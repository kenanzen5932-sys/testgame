/**
 * bridge-inject-v2.js — Greedy Niva H5 Authoritative Backend Bridge
 * 
 * v4.0: Server-authoritative model. No master election.
 * Server controls rounds, bets, payouts via game-engine-v2 Edge Function.
 * PieSocket used for real-time broadcasts from server.
 */
(function () {
  "use strict";
  var BRIDGE_VERSION = "v4.0-auth";
  console.log("%c[BRIDGE] Greedy Niva AUTHORITATIVE bridge aktif! " + BRIDGE_VERSION, "color: lime; font-weight: bold; font-size: 14px;");

  // ============================================================
  // 1) CONFIG
  // ============================================================
  var SUPABASE_URL = "https://rotriajxffiwouamtocp.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvdHJpYWp4ZmZpd291YW10b2NwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MjI3NTAsImV4cCI6MjA4NzE5ODc1MH0.bTu0eeyc1ndOAEZttV8AcCauureUxvJLlzrDOllvxEM";
  var EDGE_FUNCTION_URL = (location.origin || "") + "/api/game-engine-v2";
  var _bridgeStartTime = Date.now();
  var PIESOCKET_API_KEY = "9CyPAVbTkPvoFVsLScz32Ucq4slVz9J4a6yOwfby";
  var PIESOCKET_CLUSTER = "s15665.fra1";
  var GLOBAL_CHANNEL = "greedy-niva-global";

  var AUTH_TOKEN = "bridge_pending";
  var USER_ID = "bridge_user";
  var ROOM_ID = "0";
  var NICKNAME = "Oyuncu";
  var AVATAR = "";
  var _authReady = false;

  // FLUTTER_USER interception
  var _flutterUserValue = window.FLUTTER_USER || null;
  try {
    if (_flutterUserValue && _flutterUserValue.token) {
      AUTH_TOKEN = _flutterUserValue.token;
      USER_ID = _flutterUserValue.userId || USER_ID;
      ROOM_ID = _flutterUserValue.roomId || ROOM_ID;
      NICKNAME = _flutterUserValue.nickname || NICKNAME;
      AVATAR = _flutterUserValue.avatar || "";
      _authReady = true;
    }
    Object.defineProperty(window, "FLUTTER_USER", {
      get: function() { return _flutterUserValue; },
      set: function(val) {
        _flutterUserValue = val;
        if (val && val.token) {
          AUTH_TOKEN = val.token;
          USER_ID = val.userId || USER_ID;
          ROOM_ID = val.roomId || ROOM_ID;
          NICKNAME = val.nickname || NICKNAME;
          AVATAR = proxyAvatarUrl(val.avatar || "");
          _authReady = true;
          try { localStorage.setItem("userInfo", JSON.stringify(getUserInfoData())); } catch(e) {}
          if (AVATAR) preloadAvatar();
        }
      },
      configurable: true
    });
  } catch(e) {}

  // ============================================================
  // 2) HELPERS
  // ============================================================
  function proxyAvatarUrl(url) {
    if (!url) return "";
    if (url.indexOf("cdn.apexparty.live") > -1) {
      return url.replace("https://cdn.apexparty.live", window.location.origin + "/avatar-proxy");
    }
    return url;
  }

  function ensureAvatarCached(avatarUrl) {
    if (!avatarUrl || avatarUrl.length < 5) return;
    if (_avatarSFCache[avatarUrl]) return;
    try {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function() {
        try {
          var cc = window.cc;
          if (cc && cc.assetManager && cc.Texture2D && cc.SpriteFrame) {
            cc.assetManager.loadRemote(avatarUrl, { ext: ".jpg" }, function(err, asset) {
              if (!err && asset) { _buildAvatarSF(avatarUrl, asset); }
              else {
                cc.assetManager.loadRemote(avatarUrl, { ext: ".png" }, function(err2, asset2) {
                  if (!err2 && asset2) _buildAvatarSF(avatarUrl, asset2);
                });
              }
            });
          }
        } catch(e) {}
      };
      img.src = avatarUrl;
    } catch(e) {}
  }

  function refreshUserFromFlutter() {
    var u = window.FLUTTER_USER;
    if (u && u.token) {
      AUTH_TOKEN = u.token; USER_ID = u.userId || ""; ROOM_ID = u.roomId || "0";
      NICKNAME = u.nickname || "Oyuncu"; AVATAR = proxyAvatarUrl(u.avatar || ""); _authReady = true;
      return true;
    }
    return false;
  }

  // Game state (NO master election)
  var _gameId = 22;
  var _gameInitDone = false;
  var _lastInitParams = null;
  var _currentRoundId = null;
  var _currentState = 0;
  var _userCoins = 0;
  var _userBets = {};
  var _allBets = {};
  var _currentWinners = [];
  var _avatarSFCache = {};
  var _socket = null;
  var _heartbeatTimer = null;
  var _players = {};
  var _currentBetOptions = [100, 1000, 5000, 10000, 50000];

  function setBetOptionsFromServer(options) {
    if (!Array.isArray(options) || options.length < 5) return;
    var parsed = [];
    for (var i = 0; i < 5; i++) {
      var n = parseInt(options[i], 10);
      if (!isFinite(n) || n <= 0) return;
      parsed.push(n);
    }
    _currentBetOptions = parsed;
  }

  function formatBetShort(n) {
    if (n >= 1000000) return (n / 1000000) + "M";
    if (n >= 1000) return (n / 1000) + "K";
    return String(n);
  }

  function normalizeBetAmount(rawAmount) {
    var amount = parseInt(rawAmount, 10);
    if (!isFinite(amount) || amount <= 0) return _currentBetOptions[0] || 100;
    for (var i = 0; i < _currentBetOptions.length; i++) {
      if (amount === _currentBetOptions[i]) return amount;
    }
    var oldBets = [100, 1000, 5000, 10000, 50000];
    for (var j = 0; j < oldBets.length; j++) {
      if (amount === oldBets[j]) return _currentBetOptions[j] || amount;
    }
    return amount;
  }

  var _todayWinKey = "todayWin_" + new Date().toISOString().slice(0, 10);
  var _todayWin = 0;
  try { var _sw = localStorage.getItem(_todayWinKey); if (_sw) _todayWin = parseInt(_sw) || 0; } catch(e) {}
  function saveTodayWin() { try { localStorage.setItem(_todayWinKey, _todayWin.toString()); } catch(e) {} }

  var _betRecords = [];
  try { var _savedBR = localStorage.getItem("betRecords"); if (_savedBR) _betRecords = JSON.parse(_savedBR); } catch(e) {}
  function saveBetRecords() { try { _betRecords = _betRecords.slice(-100); localStorage.setItem("betRecords", JSON.stringify(_betRecords)); } catch(e) {} }
  function addBetRecord(roundId, foodId, userBets, userAward, userCoins) {
    var betMap = {};
    for (var fid in userBets) { if (userBets.hasOwnProperty(fid) && userBets[fid] > 0) betMap[fid] = userBets[fid]; }
    _betRecords.push({ roundId: roundId, settleTime: Math.floor(Date.now() / 1000), foodId: foodId, win: userAward, assetNum: userCoins, betMap: betMap });
    saveBetRecords();
  }

  var MULTIPLIERS = [5, 45, 5, 25, 5, 15, 10, 5];
  var _lotteryHistory = [];
  try { var _savedLH = localStorage.getItem("lotteryHistory"); if (_savedLH) _lotteryHistory = JSON.parse(_savedLH); } catch(e) {}
  function saveLotteryHistory() { try { localStorage.setItem("lotteryHistory", JSON.stringify(_lotteryHistory)); } catch(e) {} }

  function notifyFlutterCoins(coins) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) window.flutter_inappwebview.callHandler("onCoinsChanged", { coins: coins });
      if (window.parent && window.parent.postMessage) window.parent.postMessage(JSON.stringify({ type: "coins_update", coins: coins }), "*");
    } catch (e) {}
  }
  function notifyFlutterClose(caller) {
    var elapsed = Date.now() - _bridgeStartTime;
    if (elapsed < 15000) { console.warn("[BRIDGE] close BLOCKED (too early: " + elapsed + "ms) caller=" + (caller||"?")); return; }
    if (!notifyFlutterClose._lastAt) notifyFlutterClose._lastAt = 0;
    var now = Date.now();
    if (now - notifyFlutterClose._lastAt < 1500) return;
    notifyFlutterClose._lastAt = now;
    console.warn("[BRIDGE] notifyFlutterClose fired, caller=" + (caller||"?"));
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) window.flutter_inappwebview.callHandler("onGameClose", {});
      if (window.parent && window.parent.postMessage) window.parent.postMessage(JSON.stringify({ type: "game_close" }), "*");
    } catch (e) {}
  }
  function notifyFlutterOpenCoinsPage() {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) window.flutter_inappwebview.callHandler("onOpenCoinsPage", {});
      if (window.parent && window.parent.postMessage) window.parent.postMessage(JSON.stringify({ type: "open_coins_page" }), "*");
    } catch (e) {}
  }

  // ============================================================
  // 3) AUTH
  // ============================================================
  function getAuthFromFlutter() {
    return new Promise(function (resolve) {
      if (refreshUserFromFlutter()) { resolve({ token: AUTH_TOKEN, userId: USER_ID }); return; }
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("getSupabaseAuth").then(function (auth) {
          if (auth && auth.token) { AUTH_TOKEN = auth.token; USER_ID = auth.uuid || auth.userId || ""; _authReady = true; }
          refreshUserFromFlutter();
          resolve({ token: AUTH_TOKEN, userId: USER_ID });
        });
      } else {
        var attempts = 0;
        var waitInterval = setInterval(function () {
          attempts++;
          if (refreshUserFromFlutter() || attempts >= 20) { clearInterval(waitInterval); resolve({ token: AUTH_TOKEN, userId: USER_ID }); }
        }, 300);
      }
    });
  }

  // ============================================================
  // 4) EDGE FUNCTION CALL (v2)
  // ============================================================
  function callGameEngine(action, params) {
    var body = Object.assign({ action: action, room_id: 0 }, params || {});
    return fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + AUTH_TOKEN, "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify(body),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) { console.log("%c[BRIDGE] " + action + " →", "color: cyan;", data); return data; })
    .catch(function (err) { console.error("[BRIDGE] " + action + " hata:", err); return { success: false, error: String(err) }; });
  }

  // ============================================================
  // 5) PIESOCKET (simplified — no master, just listen for server events)
  // ============================================================
  function connectPieSocket() {
    var wsUrl = "wss://" + PIESOCKET_CLUSTER + ".piesocket.com/v3/" + GLOBAL_CHANNEL + "?api_key=" + PIESOCKET_API_KEY + "&notify_self=0";
    console.log("%c[BRIDGE] PieSocket bağlanıyor: " + GLOBAL_CHANNEL, "color: orange;");
    _socket = new WebSocket(wsUrl);
    _socket.onopen = function () {
      console.log("%c[BRIDGE] PieSocket bağlı ✓", "color: lime; font-weight: bold;");
    };
    _socket.onmessage = function (evt) {
      try {
        var raw = JSON.parse(evt.data);
        var event, data;
        // PieSocket may wrap in {event:"message",data:"..."} or send direct
        if (raw.sender_id === "game-engine-v2") {
          // Direct server broadcast format
          event = raw.event || "";
          data = typeof raw.data === "string" ? JSON.parse(raw.data) : raw.data;
        } else if (raw.event === "message" || raw.event === "system") {
          // PieSocket envelope — inner data is the actual payload
          var inner = typeof raw.data === "string" ? JSON.parse(raw.data) : raw.data;
          if (inner && inner.event) { event = inner.event; data = typeof inner.data === "string" ? JSON.parse(inner.data) : inner.data; }
          else { event = raw.event; data = inner; }
        } else if (raw.event && raw.data) {
          // Already unwrapped format
          event = raw.event;
          data = typeof raw.data === "string" ? JSON.parse(raw.data) : raw.data;
        } else {
          // Try to parse the whole thing as inner payload
          event = raw.event || ""; data = raw.data || raw;
        }
        if (!event || !data) return;
        console.log("%c[PIESOCKET ←] " + event, "color: #ff9800;", data);
        handleServerEvent(event, data);
      } catch (e) { console.warn("[PIESOCKET] parse error:", e, evt.data); }
    };
    _socket.onclose = function () {
      console.log("%c[BRIDGE] PieSocket kapandı, 3s sonra tekrar...", "color: red;");
      setTimeout(connectPieSocket, 3000);
    };
    _socket.onerror = function (err) { console.error("[BRIDGE] PieSocket hata:", err); };
  }

  // ============================================================
  // 6) SERVER EVENT HANDLERS (from game-engine-v2 broadcasts)
  // ============================================================
  var _animatingResult = false;
  var _pendingNewRound = null;

  function handleServerEvent(event, data) {
    switch (event) {
      case "game-result":
        onGameResult(data);
        break;
      case "game-new-round":
        onGameNewRound(data);
        break;
      case "game-bet":
        onGameBet(data);
        break;
    }
  }

  var _lastSettledRoundId = null;

  function onGameResult(data) {
    // Prevent double-processing same round (from both PieSocket and heartbeat)
    if (data.roundId && data.roundId === _lastSettledRoundId) {
      console.log("[BRIDGE] onGameResult SKIP — already settled roundId=" + data.roundId);
      return;
    }
    if (_animatingResult) {
      console.log("[BRIDGE] onGameResult SKIP — already animating");
      return;
    }
    _lastSettledRoundId = data.roundId;

    var winFoodId = data.winFoodId;
    var multiplier = data.multiplier || MULTIPLIERS[winFoodId];
    var topWinners = data.topWinners || [];

    _lotteryHistory.unshift(winFoodId);
    if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;
    saveLotteryHistory();

    // Calculate own winnings
    var userWinType = 0, userAward = 0;
    if (Object.keys(_userBets).length > 0) {
      if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
        userWinType = 2;
        userAward = _userBets[winFoodId] * multiplier;
        _userCoins += userAward;
      } else { userWinType = 1; }
    }
    if (userAward > 0) { _todayWin += userAward; saveTodayWin(); }
    addBetRecord(data.roundId, winFoodId, _userBets, userAward, _userCoins);

    // Proxy winner avatars
    for (var wi = 0; wi < topWinners.length; wi++) {
      if (topWinners[wi].avatar) topWinners[wi].avatar = proxyAvatarUrl(topWinners[wi].avatar);
      if (topWinners[wi].icon) topWinners[wi].icon = proxyAvatarUrl(topWinners[wi].icon);
      ensureAvatarCached(topWinners[wi].avatar || topWinners[wi].icon || "");
    }
    _currentWinners = topWinners;
    preloadWinnerAvatars();

    sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
    notifyFlutterCoins(_userCoins);

    // State 2 — lottery animation (5s)
    _animatingResult = true;
    _currentState = 2;
    sendRTMToGame("greedy_baby_state", {
      roundId: data.roundId, state: 2, countDown: 5, lotteryTime: 5,
      areaBetData: buildTotalFoodBets(), betData: [], serverTime: Date.now(),
    });

    // After 5s → State 3 — result (5s)
    setTimeout(function() {
      _currentState = 3;
      sendRTMToGame("greedy_baby_state", {
        roundId: data.roundId, state: 3, countDown: 5,
        resultData: {
          foodId: winFoodId, multiple: multiplier, award: userAward,
          winType: userWinType, resultShowTime: 3, todayWin: _todayWin, winUser: topWinners,
        },
        lotteryResult: _lotteryHistory.slice(0, 20),
        delayShowResultTime: 0, todayWin: _todayWin, diamond: _userCoins, serverTime: Date.now(),
      });
      setTimeout(function() { sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward }); }, 500);

      // After 5s → show new round
      setTimeout(function() {
        _animatingResult = false;
        _userBets = {};
        _allBets = {};
        _currentWinners = [];
        // Refresh state from server
        callGameEngine("get_state").then(function(res) {
          if (res && res.success) {
            _userCoins = res.coins || _userCoins;
            _currentRoundId = res.round && res.round.id;
            _currentState = 1;
            sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
            sendRTMToGame("greedy_baby_state", {
              roundId: _currentRoundId, state: 1, countDown: res.countDown || 30,
              betData: [], lotteryResult: res.lotteryResult || _lotteryHistory, serverTime: Date.now(),
            });
          }
        });
      }, 5000);
    }, 5000);
  }

  function onGameNewRound(data) {
    // If animating, ignore — we'll get_state after animation
    if (_animatingResult) { _pendingNewRound = data; return; }
    if (data && data.betOptions) setBetOptionsFromServer(data.betOptions);
    _currentRoundId = data.roundId;
    _currentState = 1;
    _userBets = {};
    _allBets = {};
    sendRTMToGame("greedy_baby_state", {
      roundId: data.roundId, state: 1, countDown: data.betDuration || 30,
      betData: [], lotteryResult: data.lotteryResult || _lotteryHistory, serverTime: Date.now(),
    });
  }

  function onGameBet(data) {
    if (!data.userId || data.userId === USER_ID) return;
    if (!_players[data.userId]) _players[data.userId] = {};
    if (data.username) _players[data.userId].nickname = data.username;
    if (data.avatar) { _players[data.userId].avatar = proxyAvatarUrl(data.avatar); ensureAvatarCached(_players[data.userId].avatar); }
    if (!_allBets[data.userId]) _allBets[data.userId] = {};
    _allBets[data.userId][data.foodId] = (_allBets[data.userId][data.foodId] || 0) + data.amount;
    sendRTMToGame("greedy_baby_sync_area_state", { roundId: _currentRoundId, areaBetData: buildTotalFoodBets() });
    sendRTMToGame("greedy_baby_other_bet", {
      userId: data.userId, nickname: data.username || "Oyuncu",
      avatar: proxyAvatarUrl(data.avatar || ""), foodId: data.foodId, amount: data.amount, roundId: _currentRoundId
    });
  }

  function buildTotalFoodBets() {
    var totals = {};
    for (var fid in _userBets) { if (_userBets.hasOwnProperty(fid)) totals[fid] = (totals[fid] || 0) + _userBets[fid]; }
    for (var uid in _allBets) { if (_allBets.hasOwnProperty(uid)) { for (var fid2 in _allBets[uid]) { if (_allBets[uid].hasOwnProperty(fid2)) totals[fid2] = (totals[fid2] || 0) + _allBets[uid][fid2]; } } }
    var result = [];
    for (var fi = 0; fi < 8; fi++) {
      var total = totals[fi] || 0;
      if (total > 0) { result.push({ foodId: fi, maxUserBet: 1, chips: [{ index: Math.min(Math.floor(total / 1000), 4), num: Math.max(1, Math.min(Math.ceil(total / 500), 5)) }] }); }
    }
    return result;
  }

  // ============================================================
  // 7) COCOS RTM
  // ============================================================
  function sendRTMToGame(event, params) {
    if (!_gameId) return;
    if (typeof window.RTMResponseMsg !== "function") { console.warn("[BRIDGE] sendRTMToGame BLOCKED — RTMResponseMsg yok! event=" + event); return; }
    var payload = JSON.stringify({ gameId: _gameId, events: [{ event: event, params: params }] });
    try { window.RTMResponseMsg(payload); console.log("%c[→GAME] " + event, "color: #4CAF50;", params); }
    catch (e) { console.error("[BRIDGE] RTMResponseMsg hata:", e); }
  }

  // ============================================================
  // 8) UA + CONSOLE PATCHES
  // ============================================================
  var FAKE_UA = "Mozilla/5.0 (Linux; Android 12; Mock) AppleWebKit/537.36 (KHTML, like Gecko) appName/mock";
  try { Object.defineProperty(navigator, "userAgent", { get: function () { return FAKE_UA; }, configurable: true }); }
  catch (e1) { try { navigator.__defineGetter__("userAgent", function () { return FAKE_UA; }); } catch (e2) {} }

  window.Env = "prod"; window.Branch = "prod"; window.Version = "1.0.17";

  function isAudioSpam(msg) {
    if (typeof msg !== "string") return false;
    return msg.indexOf("load audio failed") !== -1 || msg.indexOf("playRemoteEffect_error") !== -1 ||
      msg.indexOf("preloadRemoteAudio_error") !== -1 || msg.indexOf("failed to load Web Audio") !== -1 || msg.indexOf("DOMException") !== -1;
  }
  var _origError = console.error;
  console.error = function () { var msg = arguments[0]; if (typeof msg === "string") { if (msg.indexOf("3300") !== -1 || msg.indexOf("4930") !== -1 || msg.indexOf("ERR_SSL") !== -1) return; if (msg.indexOf("resetChipNum_error") !== -1 || msg.indexOf("loadImageByHttp_error") !== -1) return; if (isAudioSpam(msg)) return; } _origError.apply(console, arguments); };
  var _origLog = console.log; console.log = function () { if (isAudioSpam(arguments[0])) return; _origLog.apply(console, arguments); };
  var _origWarn = console.warn; console.warn = function () { if (isAudioSpam(arguments[0])) return; _origWarn.apply(console, arguments); };

  // ============================================================
  // 9) BRIDGE RESPONSE FORMAT
  // ============================================================
  function wrapBridgeResponse(data) {
    var wrapper = { params: (typeof data === "string") ? data : JSON.stringify(data) };
    var json = JSON.stringify(wrapper);
    try { return window.btoa(unescape(encodeURIComponent(json))); } catch (e) { return window.btoa(json); }
  }

  function getUserInfoData() {
    refreshUserFromFlutter();
    return { userId: USER_ID, token: AUTH_TOKEN, packageName: "com.greedy.niva", uiLang: "TR", appVersion: "9.9.9", deviceId: "flutter_device", nickname: NICKNAME, avatar: AVATAR, icon: AVATAR, diamond: _userCoins, coin: _userCoins };
  }
  try { localStorage.setItem("userInfo", JSON.stringify(getUserInfoData())); } catch (e) {}

  var _avatarPreloaded = false;
  function preloadAvatar() {
    if (_avatarPreloaded || !AVATAR) return;
    _avatarPreloaded = true;
    try {
      var img = new Image(); img.crossOrigin = "anonymous";
      img.onload = function () {
        try { var cc = window.cc; if (cc && cc.assetManager) { cc.assetManager.loadRemote(AVATAR, { ext: ".jpg" }, function (err, asset) { if (!err && asset) { _buildAvatarSF(AVATAR, asset); } else { cc.assetManager.loadRemote(AVATAR, { ext: ".png" }, function (err2, asset2) { if (!err2 && asset2) _buildAvatarSF(AVATAR, asset2); }); } }); } } catch (e2) {}
      };
      img.src = AVATAR;
    } catch (e) {}
  }
  var _lsUpdateInterval = setInterval(function () { if (refreshUserFromFlutter()) { try { localStorage.setItem("userInfo", JSON.stringify(getUserInfoData())); } catch (e) {} preloadAvatar(); clearInterval(_lsUpdateInterval); } }, 500);
  setTimeout(function () { clearInterval(_lsUpdateInterval); }, 15000);

  // ============================================================
  // 10) FUN_METHODS
  // ============================================================
  var FUN_METHODS = {
    "getUserInfo": function() { return getUserInfoData(); },
    "getUserInfoNew": function() { return getUserInfoData(); },
    "getDeviceInfo": { deviceId: "flutter_device", os: "web", osVersion: "android", appVersion: "9.9.9", packageName: "com.greedy.niva", channel: "flutter" },
    "getNetworkState": "1", "getLanguage": "TR", "getStatusBarHeight": "0",
    "getAppVersion": { version: "9.9.9", versionCode: 999 }, "getAppVersionCode": "999",
    "checkUpdate": { needUpdate: false }, "getVersion": "9.9.9",
    "getToken": function() { refreshUserFromFlutter(); return AUTH_TOKEN; },
    "getFunId": function() { refreshUserFromFlutter(); return USER_ID; },
    "getRoomId": function() { refreshUserFromFlutter(); return ROOM_ID; },
    "getAppRequestHost": SUPABASE_URL,
    "closeLoadingPage": "",
    "closePage": function() { notifyFlutterClose("FUN_METHODS.closePage"); return ""; },
    "showRechargeDialog": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "jumpToTarget": "", "speakerOperation": "", "micOperation": "",
    "isNativeAsset": "false", "event_webview_success": "",
    "popUpBottomRecharge": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "enterRoom": ""
  };
  window.fun = window.fun || {};
  Object.keys(FUN_METHODS).forEach(function (key) {
    window.fun[key] = function (params) {
      var data = FUN_METHODS[key]; var result = typeof data === "function" ? data(params) : data;
      if (!result && result !== "") return ""; return wrapBridgeResponse(result);
    };
  });
  window.fun.nativeToH5 = function () {};
  window.fun.h5ToNative = function (data) {
    try {
      var parsed = typeof data === "string" ? JSON.parse(data) : data;
      var combined = JSON.stringify(parsed).toLowerCase();
      if (combined.indexOf("recharge") !== -1 || combined.indexOf("diamond") !== -1 || combined.indexOf("topup") !== -1 || combined.indexOf("wallet") !== -1 || combined.indexOf("coin") !== -1 || combined.indexOf("shop") !== -1) notifyFlutterOpenCoinsPage();
      var action = ((parsed && (parsed.action || parsed.method || parsed.name || parsed.cmd)) || "").toString().toLowerCase();
      if (action === "closepage" || action === "close_page" || action === "game_close") notifyFlutterClose("h5ToNative." + action);
    } catch (e) {}
  };

  // ============================================================
  // 11) PROMPT OVERRIDE
  // ============================================================
  var PROMPT_RESPONSES = {
    "getUserInfo": function() { return wrapBridgeResponse(getUserInfoData()); },
    "getDeviceInfo": wrapBridgeResponse({ deviceId: "flutter_device", os: "web", osVersion: "android", appVersion: "9.9.9", packageName: "com.greedy.niva", channel: "flutter" }),
    "closeLoadingPage": "",
    "closePage": function() { notifyFlutterClose("PROMPT.closePage"); return ""; },
    "getNetworkState": wrapBridgeResponse("1"), "getLanguage": wrapBridgeResponse("TR"), "getStatusBarHeight": wrapBridgeResponse("0"),
    "showRechargeDialog": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "popUpBottomRecharge": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "jumpToTarget": "", "speakerOperation": "", "micOperation": "",
    "getAppVersion": wrapBridgeResponse({ version: "9.9.9", versionCode: 999 }),
    "checkUpdate": wrapBridgeResponse({ needUpdate: false }), "getVersion": wrapBridgeResponse("9.9.9")
  };
  var originalPrompt = window.prompt;
  window.prompt = function (method, params) {
    if (method === "requestMsg") { if (window.fun && window.fun.requestMsg) window.fun.requestMsg(params); return ""; }
    if (PROMPT_RESPONSES.hasOwnProperty(method)) { var resp = PROMPT_RESPONSES[method]; return typeof resp === "function" ? resp() : (resp || ""); }
    var ml = (method || "").toLowerCase();
    if (ml.indexOf("recharge") !== -1 || ml.indexOf("diamond") !== -1 || ml.indexOf("topup") !== -1 || ml.indexOf("wallet") !== -1 || ml.indexOf("shop") !== -1) notifyFlutterOpenCoinsPage();
    if (ml === "closepage" || ml === "close_page" || ml === "game_close") notifyFlutterClose("prompt." + ml);
    return wrapBridgeResponse({});
  };

  // URL params
  if (!window.location.search.includes("uid=")) {
    var injectParams = "uid=" + encodeURIComponent(USER_ID || "flutter_user") + "&token=" + encodeURIComponent((AUTH_TOKEN && AUTH_TOKEN !== "bridge_pending") ? AUTH_TOKEN : "flutter_token") + "&roomId=" + encodeURIComponent(ROOM_ID || "0") + "&betVersion=1";
    window.history.replaceState(null, "", window.location.pathname + "?" + injectParams + window.location.hash);
  }
  if (!window.location.search.includes("host=")) {
    var sep = window.location.search ? "&" : "?";
    window.history.replaceState(null, "", window.location.pathname + window.location.search + sep + "host=" + encodeURIComponent(btoa("https://mock-api")) + window.location.hash);
  }
  window.game = window.game || {}; window.game.netEventManger = window.game.netEventManger || {};
  if (typeof window.webkit === "undefined") window.webkit = { messageHandlers: {} };
  window.ReportEvent = window.ReportEvent || function () {};
  window.REQUEST_API_URL = SUPABASE_URL;

  // ============================================================
  // 12) MOCK API + XHR/FETCH INTERCEPTORS
  // ============================================================
  var MOCK_API_RESPONSES = {
    "/activity/probability-game/banner": { code: 200, message: "success", data: { banners: [] } },
    "/game/greedy-baby/gm": { code: 200, message: "success", data: {} },
    "/game/greedy-baby-rank/rank-v1": { code: 200, message: "success", data: { userType: 1, myRank: 0, myBet: 0, rankList: [] } },
    "/game/greedy-baby-rank/bet-recored": function() { return { code: 200, message: "success", data: { page: 0, more: false, records: _betRecords.slice().reverse() } }; },
    "/game/operation/operation-search": { code: 200, message: "success", data: {} },
    "/v2/client-event/report": { code: 200, message: "ok" }
  };
  function findMockApiResponse(url) { for (var p in MOCK_API_RESPONSES) { if (url.indexOf(p) !== -1) { var val = MOCK_API_RESPONSES[p]; return typeof val === "function" ? val() : val; } } return null; }

  try {
    var _origDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (buf, successCb, errorCb) { return _origDecode.call(this, buf, successCb, function (err) { if (errorCb) errorCb(err); }).catch(function () {}); };
  } catch (e) {}

  var _silentAudioBuf = null;
  function getSilentAudioBuffer() {
    if (!_silentAudioBuf) {
      var buf = new ArrayBuffer(46); var d = new DataView(buf);
      d.setUint32(0, 0x52494646, false); d.setUint32(4, 38, true); d.setUint32(8, 0x57415645, false);
      d.setUint32(12, 0x666D7420, false); d.setUint32(16, 16, true); d.setUint16(20, 1, true);
      d.setUint16(22, 1, true); d.setUint32(24, 44100, true); d.setUint32(28, 88200, true);
      d.setUint16(32, 2, true); d.setUint16(34, 16, true); d.setUint32(36, 0x64617461, false);
      d.setUint32(40, 2, true); d.setInt16(44, 0, true);
      _silentAudioBuf = buf;
    }
    return _silentAudioBuf;
  }
  function isAudioUrl(url) { return url && (url.indexOf("/sound/") !== -1 || /\.(mp3|ogg|wav|m4a)$/i.test(url)); }

  var OriginalXHR = window.XMLHttpRequest;
  function BridgeXHR() { var realXHR = new OriginalXHR(); this._url = ""; this._mockResponse = null; this._isAudio = false; this._realXHR = realXHR; this.responseType = ""; this.timeout = 0; this.status = 0; this.response = null; this.readyState = 0; this.onload = null; this.onerror = null; this.ontimeout = null; this.onreadystatechange = null; this.onprogress = null; }
  BridgeXHR.prototype.open = function (method, url, async) { this._url = url; this._isAudio = isAudioUrl(url); this._mockResponse = findMockApiResponse(url); if (!this._mockResponse && !this._isAudio) this._realXHR.open(method, url, async !== false); };
  BridgeXHR.prototype.setRequestHeader = function (k, v) { if (!this._mockResponse) try { this._realXHR.setRequestHeader(k, v); } catch(e){} };
  BridgeXHR.prototype.addEventListener = function (t, fn) { if (!this._mockResponse) this._realXHR.addEventListener(t, fn); };
  BridgeXHR.prototype.getResponseHeader = function (n) { return this._mockResponse ? null : this._realXHR.getResponseHeader(n); };
  BridgeXHR.prototype.send = function (body) {
    var self = this;
    if (this._mockResponse) {
      setTimeout(function () { var mockStr = typeof self._mockResponse === "string" ? self._mockResponse : JSON.stringify(self._mockResponse); self.responseText = mockStr; self.response = (self.responseType === "json") ? self._mockResponse : mockStr; self.status = 200; self.readyState = 4; if (self.onload) self.onload(); if (self.onreadystatechange) self.onreadystatechange(); }, 50);
    } else if (this._isAudio) {
      setTimeout(function () { self.status = 200; self.readyState = 4; self.response = getSilentAudioBuffer(); if (self.onload) self.onload(); if (self.onreadystatechange) self.onreadystatechange(); }, 10);
    } else {
      var xr = this._realXHR; xr.responseType = this.responseType; xr.timeout = this.timeout;
      xr.onload = function () { self.status = xr.status; self.response = xr.response; self.readyState = xr.readyState; if (self.onload) self.onload(); };
      xr.onerror = function (e) { if (self.onerror) self.onerror(e); };
      xr.ontimeout = function (e) { if (self.ontimeout) self.ontimeout(e); };
      xr.onreadystatechange = function () { self.readyState = xr.readyState; self.status = xr.status; self.response = xr.response; if (self.onreadystatechange) self.onreadystatechange(); };
      xr.send(body);
    }
  };
  window.XMLHttpRequest = BridgeXHR;

  var originalFetch = window.fetch;
  window.fetch = function (url, options) {
    var urlStr = typeof url === "string" ? url : url.url || "";
    var mockResp = findMockApiResponse(urlStr);
    if (mockResp) return Promise.resolve(new Response(JSON.stringify(mockResp), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (isAudioUrl(urlStr)) return Promise.resolve(new Response(getSilentAudioBuffer(), { status: 200, headers: { "Content-Type": "audio/wav" } }));
    return originalFetch.apply(window, arguments);
  };

  // ============================================================
  // 13) REQUEST MSG HANDLER
  // ============================================================
  window.fun.requestMsg = function (paramsStr) {
    try {
      var msg = JSON.parse(paramsStr);
      var action = msg.action || "";
      console.log("%c[GAME→] " + action, "color: #2196F3;", msg);

      if (action === "GreedyBaby:init") {
        if (msg.gameId) _gameId = msg.gameId;
        if (!_gameInitDone) { handleGameInit(); }
        else if (_lastInitParams) { sendRTMToGame("greedy_baby_init", _lastInitParams); }
      } else if (action === "GreedyBaby:bet") {
        handleUserBet(msg);
      } else if (action === "GreedyBaby:diamond") {
        sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
      }
    } catch (e) { console.error("[BRIDGE] requestMsg parse error:", e); }
  };

  // ============================================================
  // 14) HANDLE GAME INIT (Authoritative — server get_state)
  // ============================================================
  var _initAttempts = 0;
  function handleGameInit() {
    try {
      if (_gameInitDone) return;
      _initAttempts++;
      if (_initAttempts > 5) return;
      console.log("%c[BRIDGE] ████ handleGameInit (AUTHORITATIVE) ████ deneme=" + _initAttempts, "color: lime; font-weight: bold; font-size: 14px;");

      getAuthFromFlutter().then(function () {
        callGameEngine("get_state").then(function (result) {
          if (result && result.success) {
            setBetOptionsFromServer(result.betOptions);
            _userCoins = result.coins || 0;
            _currentRoundId = result.round && result.round.id;
            _currentState = result.round ? result.round.state : 1;
            _gameInitDone = true;

            var countDown = result.countDown || 30;
            _lastInitParams = {
              roundId: _currentRoundId || 1000, state: _currentState || 1, countDown: countDown,
              diamond: _userCoins, betingId: 0, bets: [100, 1000, 5000, 10000, 50000],
              betData: [], rank: 0, lotteryTime: 5,
              lotteryResult: result.lotteryResult || _lotteryHistory || [],
              todayWin: _todayWin, winFoodId: -1, serverTime: Date.now(),
            };
            sendRTMToGame("greedy_baby_init", _lastInitParams);
            setTimeout(function() { if (_lastInitParams) sendRTMToGame("greedy_baby_init", _lastInitParams); }, 2000);
          } else {
            _gameInitDone = true;
            _lastInitParams = {
              roundId: 1000, state: 1, countDown: 30, diamond: _userCoins,
              betingId: 0, bets: [100, 1000, 5000, 10000, 50000], betData: [], rank: 0,
              lotteryTime: 5, lotteryResult: _lotteryHistory || [],
              todayWin: _todayWin, winFoodId: -1, serverTime: Date.now(),
            };
            sendRTMToGame("greedy_baby_init", _lastInitParams);
          }
        }).catch(function(err) {
          console.error("[BRIDGE] get_state HATA:", err);
          _gameInitDone = true;
          _lastInitParams = {
            roundId: 1000, state: 1, countDown: 30, diamond: _userCoins,
            betingId: 0, bets: [100, 1000, 5000, 10000, 50000], betData: [], rank: 0,
            lotteryTime: 5, lotteryResult: [], todayWin: 0, winFoodId: -1, serverTime: Date.now(),
          };
          sendRTMToGame("greedy_baby_init", _lastInitParams);
        });

        connectPieSocket();
        startHeartbeat();
        _gameInitDone = true;
      }).catch(function(authErr) {
        console.error("[BRIDGE] Auth HATA:", authErr);
        _gameInitDone = true;
        _lastInitParams = {
          roundId: 1000, state: 1, countDown: 30, diamond: 0,
          betingId: 0, bets: [100, 1000, 5000, 10000, 50000], betData: [], rank: 0,
          lotteryTime: 5, lotteryResult: [], todayWin: 0, winFoodId: -1, serverTime: Date.now(),
        };
        sendRTMToGame("greedy_baby_init", _lastInitParams);
        connectPieSocket();
        startHeartbeat();
      });
    } catch(fatalErr) {
      console.error("[BRIDGE] handleGameInit FATAL:", fatalErr);
    }
  }

  // ============================================================
  // 15) RTMResponseMsg INTERCEPTOR
  // ============================================================
  var _realRTMResponseMsg = null;
  var _rtmSetCount = 0;
  try {
    Object.defineProperty(window, "RTMResponseMsg", {
      set: function (fn) {
        _realRTMResponseMsg = fn;
        _rtmSetCount++;
        if (_rtmSetCount === 1) {
          if (_gameInitDone && _lastInitParams) {
            setTimeout(function() { if (_lastInitParams) sendRTMToGame("greedy_baby_init", _lastInitParams); }, 200);
          } else if (!_gameInitDone) { handleGameInit(); }
        } else if (_rtmSetCount >= 2 && _lastInitParams) {
          setTimeout(function () { if (_lastInitParams) sendRTMToGame("greedy_baby_init", _lastInitParams); }, 300);
        }
      },
      get: function () { return _realRTMResponseMsg; },
      configurable: true
    });
  } catch (dpErr) { console.error("[BRIDGE] RTMResponseMsg defineProperty hatası:", dpErr); }

  setTimeout(function () { if (!_gameInitDone) handleGameInit(); }, 1000);
  setTimeout(function () { if (!_gameInitDone) handleGameInit(); }, 5000);

  // ============================================================
  // 16) HEARTBEAT POLLING (triggers server-side round transitions)
  // ============================================================
  function startHeartbeat() {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(function() {
      if (_animatingResult) return; // Don't poll during animation
      callGameEngine("heartbeat").then(function(res) {
        if (!res || !res.success) return;
        if (res.action === "round_settled" && res.result) {
          // Directly trigger result animation from heartbeat response
          console.log("%c[BRIDGE] Heartbeat → round_settled! winFoodId=" + res.result.winFoodId, "color: gold; font-weight: bold;");
          onGameResult(res.result);
        } else if (res.action === "new_round" && res.newRound) {
          console.log("%c[BRIDGE] Heartbeat → new_round! roundId=" + res.newRound.roundId, "color: gold;");
          onGameNewRound(res.newRound);
        } else if (res.action === "none" && res.round) {
          // Sync countdown from server
          if (res.countDown !== undefined && res.round.state === 1 && _currentState === 1) {
            var serverCountDown = res.countDown;
            if (serverCountDown <= 0 && !_animatingResult) {
              // Time expired on server but no settle yet — force immediate re-check
              console.log("%c[BRIDGE] Countdown=0, forcing re-check...", "color: orange;");
              setTimeout(function() { callGameEngine("heartbeat").then(function(r2) {
                if (r2 && r2.success && r2.action === "round_settled" && r2.result) onGameResult(r2.result);
              }); }, 500);
            }
          }
        }
      }).catch(function() {});
    }, 3000);
    console.log("%c[BRIDGE] Heartbeat polling başlatıldı (3s)", "color: gold;");
  }

  // ============================================================
  // 17) USER BET (Authoritative — server validates)
  // ============================================================
  var _betIdCounter = 1000;
  function handleUserBet(msg) {
    var betParams = msg.params || {};
    var betDataArr = betParams.betData || [];
    if (betDataArr.length === 0) return;

    var betFoodId = betDataArr[0].foodId || 0;
    var rawBetAmount = (betDataArr[0].bets && betDataArr[0].bets[0]) || _currentBetOptions[0] || 100;
    var betAmount = normalizeBetAmount(rawBetAmount);

    if (_userCoins < betAmount) {
      console.warn("[BRIDGE] Yetersiz bakiye! coins=" + _userCoins + " bet=" + betAmount);
      notifyFlutterOpenCoinsPage();
      return;
    }
    if (_currentState !== 1) {
      console.warn("[BRIDGE] Bahis süresi değil! state=" + _currentState);
      return;
    }

    // Instant local feedback
    _userCoins -= betAmount;
    _userBets[betFoodId] = (_userBets[betFoodId] || 0) + betAmount;
    _betIdCounter++;
    notifyFlutterCoins(_userCoins);

    var responseBetData = [];
    for (var fid in _userBets) { if (_userBets.hasOwnProperty(fid) && _userBets[fid] > 0) responseBetData.push({ foodId: parseInt(fid), bet: _userBets[fid] }); }
    sendRTMToGame("greedy_baby_bet", { code: 0, roundId: _currentRoundId, diamond: _userCoins, betingId: _betIdCounter, betData: responseBetData });

    // Server-authoritative bet
    callGameEngine("place_bet", { food_id: betFoodId, amount: betAmount }).then(function (result) {
      if (result && result.success) {
        _userCoins = result.remaining_coins;
        sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
        notifyFlutterCoins(_userCoins);
      } else {
        // Server rejected — rollback
        console.warn("[BRIDGE] Bahis reddedildi:", result);
        _userCoins += betAmount;
        _userBets[betFoodId] = (_userBets[betFoodId] || 0) - betAmount;
        if (_userBets[betFoodId] <= 0) delete _userBets[betFoodId];
        sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
        notifyFlutterCoins(_userCoins);
      }
    }).catch(function(e) {
      console.warn("[BRIDGE] place_bet hatası (local devam):", e);
    });
  }

  // ============================================================
  // 18) AVATAR HELPERS
  // ============================================================
  function _buildAvatarSF(url, imgAsset) {
    try {
      var tex;
      if (imgAsset instanceof cc.Texture2D) { tex = imgAsset; }
      else { tex = new cc.Texture2D(); tex.image = imgAsset; }
      var sf = new cc.SpriteFrame(); sf.texture = tex; sf.packable = false; sf.addRef();
      _avatarSFCache[url] = sf;
    } catch(e) {}
  }

  function preloadWinnerAvatars() {
    if (typeof cc === "undefined" || !cc.assetManager || !cc.Texture2D || !cc.SpriteFrame) return;
    for (var wi = 0; wi < _currentWinners.length; wi++) {
      var url = proxyAvatarUrl(_currentWinners[wi].avatar || _currentWinners[wi].icon || "");
      if (!url || _avatarSFCache[url]) continue;
      (function(avatarUrl) {
        cc.assetManager.loadRemote(avatarUrl, { ext: ".jpg" }, function(err, imgAsset) {
          if (err || !imgAsset) { cc.assetManager.loadRemote(avatarUrl, { ext: ".png" }, function(err2, imgAsset2) { if (!err2 && imgAsset2) _buildAvatarSF(avatarUrl, imgAsset2); }); return; }
          _buildAvatarSF(avatarUrl, imgAsset);
        });
      })(url);
    }
  }

  // ============================================================
  // 19) GAME GLOBAL PATCHES
  // ============================================================
  var _patchDone = { betVersion: false, remoteHost: false };
  var betPatchInterval = setInterval(function () {
    try {
      if (window.__cclm && window.__cclm._moduleMap) {
        var entries = Object.entries(window.__cclm._moduleMap);
        for (var i = 0; i < entries.length; i++) {
          var mod = entries[i][1];
          if (!_patchDone.betVersion && mod && mod.exports && mod.exports.gameGlobal && mod.exports.gameGlobal.betVersion !== undefined) {
            mod.exports.gameGlobal.betVersion = 1; _patchDone.betVersion = true;
          }
          if (!_patchDone.remoteHost && mod && mod.exports && mod.exports.GameRemoteHost) _patchDone.remoteHost = true;
        }
        if (_patchDone.betVersion && _patchDone.remoteHost) clearInterval(betPatchInterval);
      }
    } catch (e) {}
  }, 200);
  setTimeout(function () { clearInterval(betPatchInterval); }, 10000);

  // ============================================================
  // 20) TURKISH TRANSLATIONS + UI PATCHES
  // ============================================================
  var TR_MAP = {
    "Greedy Baby": "Greedy Niva", "Bet Time": "Bahis Süresi", "Show Time": "Sonuç",
    "Drawing": "Çekiliş", "You did not bet in this round": "Bu turda bahis yapmadınız",
    "Result": "Sonuçlar", "Fruit": "Meyve", "Pizza": "Pizza", "New": "Yeni",
    "TODAY'S WIN": "BUGÜNKÜ KAZANÇ",
    "Choose the amount wager -> Choose food": "Bahis miktarı seç -> Yiyecek seç",
    "Rank": "Sıralama", "Top": "En İyi", "WIN": "KAZANDINIZ", "LOSE": "KAYBETTİNİZ",
    "You Win!": "Kazandınız!", "You Lose!": "Kaybettiniz!", "Rule": "Kurallar",
  };
  var TR_PREFIX = [{ from: "TODAY'S WIN", to: "BUGÜNKÜ KAZANÇ" }];
  var TR_CONTAINS = [
    { match: "Choose the quantity of coins", replace: "1. Bahis miktarını seçin ve ardından bahis yapmak istediğiniz yiyeceği seçin." },
    { match: "Each round, you have 30 seconds", replace: "2. Her turda yiyecek seçmek için 30 saniyeniz var, ardından kazanan yiyecek belirlenir." },
    { match: "If you bet coins on the winning", replace: "3. Kazanan yiyeceğe bahis yaptıysanız, karşılık gelen ödülü kazanırsınız." },
    { match: "If the winning food is a fruit", replace: "4. Kazanan yiyecek meyveyse; elma, mango, çilek ve limon hepsi kazanır. Kazanan yiyecek pizzaysa; balık, hamburger, pizza ve tavuk hepsi kazanır." },
    { match: "Choose the amount wager", replace: "Bahis miktarı seç -> Yiyecek seç" },
  ];

  function collectAllNodes(root, result) {
    if (!root) return;
    result.push(root);
    var children = root.children;
    if (children) { for (var i = 0; i < children.length; i++) collectAllNodes(children[i], result); }
  }

  var _rankHidden = false;
  var _rechargeBtnPatched = false;
  var _chipLabelBlackColor = null;
  var _chipBgPinkColor = null;
  var _whiteSF = null;

  function patchCocosLabels() {
    try {
      var cc = window.cc;
      if (!cc || !cc.director) return;
      var scene = cc.director.getScene();
      if (!scene) return;

      var labels = scene.getComponentsInChildren(cc.Label);
      if (labels && labels.length) {
        for (var i = 0; i < labels.length; i++) {
          var lbl = labels[i];
          if (!lbl || !lbl.string) continue;

          // Force chip labels to server-configured bet options
          if (lbl.string === "100" || lbl.string === "500") { lbl.string = formatBetShort(_currentBetOptions[0] || 100); continue; }
          if (lbl.string === "1K" || lbl.string === "1k" || lbl.string === "1000") { lbl.string = formatBetShort(_currentBetOptions[1] || 1000); continue; }
          if (lbl.string === "5K" || lbl.string === "5k" || lbl.string === "5000" || lbl.string === "200000") { lbl.string = formatBetShort(_currentBetOptions[2] || 5000); continue; }
          if (lbl.string === "10K" || lbl.string === "10k" || lbl.string === "10000" || lbl.string === "500000") { lbl.string = formatBetShort(_currentBetOptions[3] || 10000); continue; }
          if (lbl.string === "50K" || lbl.string === "50k" || lbl.string === "50000" || lbl.string === "1000000" || lbl.string === "1M" || lbl.string === "1m") { lbl.string = formatBetShort(_currentBetOptions[4] || 50000); continue; }

          if (TR_MAP[lbl.string]) { lbl.string = TR_MAP[lbl.string]; continue; }
          var matched = false;
          for (var p = 0; p < TR_PREFIX.length; p++) {
            if (lbl.string.indexOf(TR_PREFIX[p].from) === 0) { lbl.string = lbl.string.replace(TR_PREFIX[p].from, TR_PREFIX[p].to); matched = true; break; }
          }
          if (matched) continue;
          for (var c = 0; c < TR_CONTAINS.length; c++) {
            if (lbl.string.indexOf(TR_CONTAINS[c].match) !== -1) { lbl.string = TR_CONTAINS[c].replace; break; }
          }
        }
      }

      var allNodes = [];
      collectAllNodes(scene, allNodes);

      if (!_rankHidden) {
        for (var j = 0; j < allNodes.length; j++) {
          var nd = allNodes[j];
          if (nd.name && nd.active !== false && (nd.name.toLowerCase().indexOf("rank") !== -1 || nd.name.toLowerCase().indexOf("cup") !== -1 || nd.name.toLowerCase().indexOf("trophy") !== -1)) {
            nd.active = false; _rankHidden = true;
          }
        }
      }

      if (!_rechargeBtnPatched && cc.Button) {
        var buttons = scene.getComponentsInChildren(cc.Button);
        if (buttons && buttons.length) {
          for (var b = 0; b < buttons.length; b++) {
            var bNode = buttons[b].node;
            var bName = (bNode.name || "").toLowerCase();
            if (bName.indexOf("recharge") !== -1 || bName.indexOf("charge") !== -1 || bName.indexOf("adddia") !== -1 || bName.indexOf("add_dia") !== -1 || bName.indexOf("adddiamond") !== -1 || bName.indexOf("diamond") !== -1 || bName.indexOf("plus") !== -1 || bName.indexOf("topup") !== -1 || bName.indexOf("shop") !== -1 || bName.indexOf("wallet") !== -1 || bName.indexOf("coin") !== -1) {
              (function(node) { node.on(cc.Node.EventType.TOUCH_END, function() { notifyFlutterOpenCoinsPage(); }); })(bNode);
              _rechargeBtnPatched = true;
            }
          }
        }
        if (!_rechargeBtnPatched) {
          for (var li = 0; li < allNodes.length; li++) {
            var an = allNodes[li];
            var anName = (an.name || "").toLowerCase();
            if (anName.indexOf("recharge") !== -1 || anName.indexOf("charge") !== -1 || anName.indexOf("adddia") !== -1 || anName.indexOf("diamond_add") !== -1 || anName.indexOf("btn_add") !== -1 || anName.indexOf("btnadd") !== -1 || anName === "add" || anName === "plus") {
              (function(node) { node.on(cc.Node.EventType.TOUCH_END, function() { notifyFlutterOpenCoinsPage(); }); })(an);
              _rechargeBtnPatched = true; break;
            }
          }
        }
      }

      if (cc.Color && cc.Sprite) {
        if (!_chipLabelBlackColor) {
          _chipLabelBlackColor = new cc.Color(0, 0, 0, 255);
          _chipBgPinkColor = new cc.Color(218, 165, 32, 255);
          try {
            var cvs = document.createElement("canvas"); cvs.width = 128; cvs.height = 64;
            var ctx2d = cvs.getContext("2d"); ctx2d.clearRect(0, 0, 128, 64);
            ctx2d.fillStyle = "#ffffff"; ctx2d.beginPath(); ctx2d.roundRect(0, 0, 128, 64, 28); ctx2d.fill();
            cvs.toBlob(function(blob) {
              if (!blob) return;
              var blobUrl = URL.createObjectURL(blob);
              cc.assetManager.loadRemote(blobUrl, { ext: ".png" }, function(err, imgAsset) {
                if (!err && imgAsset) { try { var t2d = new cc.Texture2D(); t2d.image = imgAsset; _whiteSF = new cc.SpriteFrame(); _whiteSF.texture = t2d; } catch(ex) {} }
              });
            }, "image/png");
          } catch(ex2) {}
        }
        for (var ci = 0; ci < allNodes.length; ci++) {
          var nd2 = allNodes[ci];
          if (nd2.name === "you_chip_label") { var chipLbl = nd2.getComponent(cc.Label); if (chipLbl) chipLbl.color = _chipLabelBlackColor; }
          if (nd2.name === "you_chip" && nd2.active) {
            var chipSprite = nd2.getComponent(cc.Sprite);
            if (chipSprite) {
              if (_whiteSF && chipSprite.spriteFrame !== _whiteSF) { chipSprite.spriteFrame = _whiteSF; chipSprite.type = 0; chipSprite.sizeMode = 0; }
              chipSprite.color = _chipBgPinkColor;
            }
            var chipGray = nd2.getChildByName && nd2.getChildByName("chip_gray");
            if (chipGray && !chipGray._bridgeHidden) { var graySpr = chipGray.getComponent(cc.Sprite); if (graySpr) graySpr.enabled = false; chipGray._bridgeHidden = true; }
            var layoutNode = nd2.getChildByName && nd2.getChildByName("layout");
            if (layoutNode && layoutNode.children) {
              for (var lii = 0; lii < layoutNode.children.length; lii++) {
                var lChild = layoutNode.children[lii];
                if (lChild.name !== "you_chip_label") { var lLabel = lChild.getComponent(cc.Label); if (lLabel) lChild.active = false; }
              }
            }
          }
        }
      }

      // Avatar force-patch
      if (_currentWinners.length > 0 && typeof cc !== "undefined" && cc.Sprite) {
        for (var hi = 0; hi < allNodes.length; hi++) {
          var hn = allNodes[hi];
          var winIdx = -1;
          if (hn.active) {
            var hnl = (hn.name || "").toLowerCase();
            if (hnl === "winner_0" || hnl === "winneritem_0" || hnl === "win_item_0" || hnl === "rankitem_0" || hnl === "resultitem_0" || hnl === "rank_item_0") winIdx = 0;
            else if (hnl === "winner_1" || hnl === "winneritem_1" || hnl === "win_item_1" || hnl === "rankitem_1" || hnl === "resultitem_1" || hnl === "rank_item_1") winIdx = 1;
            else if (hnl === "winner_2" || hnl === "winneritem_2" || hnl === "win_item_2" || hnl === "rankitem_2" || hnl === "resultitem_2" || hnl === "rank_item_2") winIdx = 2;
          }
          if (winIdx >= 0 && winIdx < _currentWinners.length) {
            var winAvatar = proxyAvatarUrl(_currentWinners[winIdx].avatar || _currentWinners[winIdx].icon || "");
            if (!winAvatar) continue;
            var headNode = hn.getChildByName && (hn.getChildByName("head_img") || hn.getChildByName("headImg") || hn.getChildByName("head") || hn.getChildByName("icon") || hn.getChildByName("avatar") || hn.getChildByName("img"));
            if (!headNode) continue;
            try {
              var hSprite = headNode.getComponent(cc.Sprite);
              if (!hSprite) continue;
              var hasSF = hSprite.spriteFrame && hSprite.spriteFrame.texture && hSprite.spriteFrame.texture.width > 2;
              if (!hasSF) {
                var cachedSF = _avatarSFCache[winAvatar];
                if (cachedSF) { hSprite.spriteFrame = cachedSF; }
                else if (!headNode._bridgeAvatarLoading) {
                  headNode._bridgeAvatarLoading = true;
                  (function(sprite, hNode, avatarSrc, wIdx) {
                    cc.assetManager.loadRemote(avatarSrc, { ext: ".png" }, function(err, imgAsset) {
                      hNode._bridgeAvatarLoading = false;
                      if (!err && imgAsset && sprite.isValid) { try { _buildAvatarSF(avatarSrc, imgAsset); if (_avatarSFCache[avatarSrc]) sprite.spriteFrame = _avatarSFCache[avatarSrc]; } catch(e2) {} }
                    });
                  })(hSprite, headNode, winAvatar, winIdx);
                }
              }
            } catch(eAvatar) {}
          }
        }
      }
    } catch (e) {}
  }

  setInterval(patchCocosLabels, 500);

  // loadRemote interceptor
  var _lrPatched = false;
  var _lrPatchInterval = setInterval(function() {
    if (typeof cc !== "undefined" && cc.assetManager && cc.assetManager.loadRemote && !_lrPatched) {
      _lrPatched = true;
      var _origLoadRemote = cc.assetManager.loadRemote.bind(cc.assetManager);
      cc.assetManager.loadRemote = function(url, opts, cb) {
        if (typeof url === "string" && url.indexOf("avatar-proxy") > -1) {
          var wrappedCb = function(err, asset) { if (cb) cb(err, asset); };
          return _origLoadRemote(url, opts, wrappedCb);
        }
        return _origLoadRemote(url, opts, cb);
      };
      clearInterval(_lrPatchInterval);
    }
  }, 300);
  setTimeout(function() { clearInterval(_lrPatchInterval); }, 15000);

  // networkState
  var netInterval = setInterval(function () {
    if (window.game && window.game.netEventManger) {
      var mgr = window.game.netEventManger;
      if (mgr.constructor) mgr.constructor.networkState = 1;
      if (!mgr._userInfo || !mgr._userInfo.token) mgr._userInfo = getUserInfoData();
    }
  }, 300);
  setTimeout(function () { clearInterval(netInterval); }, 15000);

  // System.register hook
  var _origRegister = typeof System !== "undefined" && System.register;
  if (_origRegister) {
    System.register = function(name, deps, declare) {
      if (typeof name === "string" && name.indexOf("GlobalContext.ts") !== -1) {
        var origDeclare = declare;
        declare = function(exportFn) {
          var result = origDeclare(function(key, val) {
            if (key === "globalContext" && val && typeof val === "object") { val.HostAddress = "https://mock-api"; val.gameId = val.gameId || 22; }
            return exportFn(key, val);
          });
          return result;
        };
      }
      return _origRegister.call(System, name, deps, declare);
    };
  }

  // Debug helper
  window.GREEDY_NIVA = {
    getState: function() { return callGameEngine("get_state"); },
    version: BRIDGE_VERSION,
    currentRound: function() { return _currentRoundId; },
    coins: function() { return _userCoins; },
  };

  console.log("%c[BRIDGE] Konfigürasyon (AUTHORITATIVE):", "color: yellow;");
  console.log("  Edge Function:", EDGE_FUNCTION_URL);
  console.log("  Kanal:", GLOBAL_CHANNEL);
  console.log("  User:", NICKNAME, "(ID:", USER_ID.substring(0, 8) + "...)");
  console.log("  Mod: Server-Authoritative (game-engine-v2)");
})();
