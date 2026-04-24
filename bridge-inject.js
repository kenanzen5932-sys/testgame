/**
 * bridge-inject.js — Greedy Niva H5 Oyun Köprüsü (Gerçek Versiyon)
 * 
 * Mock-inject.js yerine kullanılır.
 * Supabase Auth + Edge Function + PieSocket ile gerçek multiplayer oyun.
 * 
 * Flutter WebView şu değişkenleri enjekte eder:
 *   window.FLUTTER_USER = { userId, token, nickname, avatar, roomId }
 */
(function () {
  "use strict";
  console.log("%c[BRIDGE] Greedy Niva bridge aktif!", "color: lime; font-weight: bold; font-size: 14px;");

  // ============================================================
  // 1) CONFIG
  // ============================================================
  var SUPABASE_URL = "https://rotriajxffiwouamtocp.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvdHJpYWp4ZmZpd291YW10b2NwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MjI3NTAsImV4cCI6MjA4NzE5ODc1MH0.bTu0eeyc1ndOAEZttV8AcCauureUxvJLlzrDOllvxEM";
  var EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/game-engine";
  var PIESOCKET_API_KEY = "9CyPAVbTkPvoFVsLScz32Ucq4slVz9J4a6yOwfby";
  var PIESOCKET_CLUSTER = "s15665.fra1";

  // Flutter'dan gelen kullanıcı bilgileri — lazily okunacak
  var AUTH_TOKEN = "";
  var USER_ID = "";
  var ROOM_ID = "0";
  var NICKNAME = "Oyuncu";
  var AVATAR = "";
  var _authReady = false;

  // Multiplayer state
  var _isMaster = false;
  var _masterUserId = null;
  var _masterLastHB = 0;
  var _players = {}; // {userId: {nickname, avatar, joinedAt}}
  var _allBets = {}; // current round: {userId: {foodId: amount, ...}}
  var _masterHBInterval = null;
  var _masterCheckInterval = null;
  var GLOBAL_CHANNEL = "greedy-niva-global";
  var MASTER_HB_INTERVAL = 5000; // 5s
  var MASTER_TIMEOUT = 15000; // 15s

  // FLUTTER_USER enjekte edilene kadar bekle
  function refreshUserFromFlutter() {
    var u = window.FLUTTER_USER;
    if (u && u.token) {
      AUTH_TOKEN = u.token;
      USER_ID = u.userId || "";
      ROOM_ID = u.roomId || "0";
      NICKNAME = u.nickname || "Oyuncu";
      var rawAvatar = u.avatar || "";
      if (rawAvatar.indexOf("cdn.apexparty.live") > -1) {
        AVATAR = rawAvatar.replace("https://cdn.apexparty.live", window.location.origin + "/avatar-proxy");
      } else {
        AVATAR = rawAvatar;
      }
      _authReady = true;
      console.log("%c[BRIDGE] FLUTTER_USER okundu: " + NICKNAME + " room=" + ROOM_ID + " avatar=" + AVATAR, "color: lime;");
      return true;
    }
    return false;
  }

  // Oyun durumu
  var _gameId = "";
  var _currentRoundId = null;
  var _currentState = 0;
  var _userCoins = 0;
  var _userBets = {}; // { foodId: totalBet } bu round için
  var _socket = null;
  var _gameLoopTimer = null;
  // Bugünkü toplam kazanç — localStorage'da günlük sakla
  var _todayWinKey = "todayWin_" + new Date().toISOString().slice(0, 10);
  var _todayWin = 0;
  try { var _sw = localStorage.getItem(_todayWinKey); if (_sw) _todayWin = parseInt(_sw) || 0; } catch(e) {}
  function saveTodayWin() { try { localStorage.setItem(_todayWinKey, _todayWin.toString()); } catch(e) {} }

  // Geçmiş kayıtlar (bet records) — localStorage'da sakla
  var _betRecords = [];
  try { var _savedBR = localStorage.getItem("betRecords"); if (_savedBR) _betRecords = JSON.parse(_savedBR); } catch(e) {}
  function saveBetRecords() { try { _betRecords = _betRecords.slice(-100); localStorage.setItem("betRecords", JSON.stringify(_betRecords)); } catch(e) {} }
  function addBetRecord(roundId, foodId, userBets, userAward, userCoins) {
    var betMap = {};
    for (var fid in userBets) { if (userBets.hasOwnProperty(fid) && userBets[fid] > 0) betMap[fid] = userBets[fid]; }
    _betRecords.push({
      roundId: roundId,
      settleTime: Math.floor(Date.now() / 1000),
      foodId: foodId,
      win: userAward,
      assetNum: userCoins,
      betMap: betMap
    });
    saveBetRecords();
  }

  // Çarpan tablosu
  var MULTIPLIERS = [5, 45, 5, 25, 5, 15, 10, 5];

  // Flutter'a coin güncellemesi gönder
  function notifyFlutterCoins(coins) {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("onCoinsChanged", { coins: coins });
      }
      if (window.parent && window.parent.postMessage) {
        window.parent.postMessage(JSON.stringify({ type: "coins_update", coins: coins }), "*");
      }
    } catch (e) {}
  }

  // Flutter'a oyunu kapat sinyali gönder
  function notifyFlutterClose() {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("onGameClose", {});
      }
      if (window.parent && window.parent.postMessage) {
        window.parent.postMessage(JSON.stringify({ type: "game_close" }), "*");
      }
    } catch (e) {}
  }

  // Flutter'a coins sayfasına git sinyali gönder
  function notifyFlutterOpenCoinsPage() {
    try {
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("onOpenCoinsPage", {});
      }
      if (window.parent && window.parent.postMessage) {
        window.parent.postMessage(JSON.stringify({ type: "open_coins_page" }), "*");
      }
    } catch (e) {}
  }

  // ============================================================
  // 2) FLUTTER BRIDGE — Token alma (InAppWebView)
  // ============================================================
  function getAuthFromFlutter() {
    return new Promise(function (resolve) {
      // Önce FLUTTER_USER'dan oku
      if (refreshUserFromFlutter()) {
        resolve({ token: AUTH_TOKEN, userId: USER_ID });
        return;
      }
      // flutter_inappwebview bridge ile token al
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("getSupabaseAuth").then(function (auth) {
          if (auth && auth.token) {
            AUTH_TOKEN = auth.token;
            USER_ID = auth.uuid || auth.userId || "";
            _authReady = true;
            console.log("%c[BRIDGE] Auth bridge'den alındı: " + USER_ID.substring(0, 8) + "...", "color: lime;");
          }
          // FLUTTER_USER'dan da nickname/avatar al
          refreshUserFromFlutter();
          resolve({ token: AUTH_TOKEN, userId: USER_ID });
        });
      } else {
        // FLUTTER_USER henüz yok — bekle (500ms aralıklarla 10 deneme)
        var attempts = 0;
        var waitInterval = setInterval(function () {
          attempts++;
          if (refreshUserFromFlutter() || attempts >= 20) {
            clearInterval(waitInterval);
            resolve({ token: AUTH_TOKEN, userId: USER_ID });
          }
        }, 300);
      }
    });
  }

  // ============================================================
  // 3) SUPABASE EDGE FUNCTION ÇAĞRISI
  // ============================================================
  function callGameEngine(action, params) {
    var body = Object.assign({ action: action, room_id: 0 }, params || {}); // Global mod: room_id=0

    return fetch(EDGE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + AUTH_TOKEN,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        console.log("%c[BRIDGE] " + action + " →", "color: cyan;", data);
        return data;
      })
      .catch(function (err) {
        console.error("[BRIDGE] " + action + " hata:", err);
        return { success: false, error: String(err) };
      });
  }

  // ============================================================
  // 4) PIESOCKET BAĞLANTISI (GLOBAL)
  // ============================================================
  function connectPieSocket() {
    var wsUrl = "wss://" + PIESOCKET_CLUSTER + ".piesocket.com/v3/" + GLOBAL_CHANNEL + "?api_key=" + PIESOCKET_API_KEY + "&notify_self=0";

    console.log("%c[BRIDGE] PieSocket bağlanıyor: " + GLOBAL_CHANNEL, "color: orange;");

    _socket = new WebSocket(wsUrl);

    _socket.onopen = function () {
      console.log("%c[BRIDGE] PieSocket bağlı ✓", "color: lime; font-weight: bold;");
      // Odaya katıl
      sendPieSocket("player:join", {
        userId: USER_ID,
        nickname: NICKNAME,
        avatar: AVATAR,
        joinedAt: Date.now()
      });
      // Master bekle — 3 saniye içinde heartbeat gelmezse master ol
      setTimeout(function() {
        if (!_masterUserId) {
          claimMaster();
        }
      }, 3000);
    };

    _socket.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        var event = msg.event || "";
        var data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
        if (!event || !data) return;
        if (event !== "master:heartbeat") {
          console.log("%c[PIESOCKET ←] " + event, "color: #ff9800;", data);
        }
        handleGameEvent(event, data);
      } catch (e) {}
    };

    _socket.onclose = function () {
      console.log("%c[BRIDGE] PieSocket kapandı, 3s sonra tekrar bağlanıyor...", "color: red;");
      _isMaster = false;
      _masterUserId = null;
      if (_masterHBInterval) { clearInterval(_masterHBInterval); _masterHBInterval = null; }
      if (_masterCheckInterval) { clearInterval(_masterCheckInterval); _masterCheckInterval = null; }
      setTimeout(connectPieSocket, 3000);
    };

    _socket.onerror = function (err) {
      console.error("[BRIDGE] PieSocket hata:", err);
    };
  }

  // PieSocket'e mesaj gönder
  function sendPieSocket(event, data) {
    if (_socket && _socket.readyState === WebSocket.OPEN) {
      _socket.send(JSON.stringify({ event: event, data: data }));
    }
  }

  // Master ol
  function claimMaster() {
    _isMaster = true;
    _masterUserId = USER_ID;
    _masterLastHB = Date.now();
    console.log("%c[BRIDGE] BEN MASTER OLDUM! " + NICKNAME, "color: gold; font-weight: bold; font-size: 16px;");
    sendPieSocket("master:claim", { userId: USER_ID, nickname: NICKNAME });
    // Heartbeat başlat
    if (_masterHBInterval) clearInterval(_masterHBInterval);
    _masterHBInterval = setInterval(function() {
      sendPieSocket("master:heartbeat", { userId: USER_ID, ts: Date.now() });
    }, MASTER_HB_INTERVAL);
    // Master olarak oyunu başlat
    startMasterGameLoop();
  }

  // Master kontrol — heartbeat gelmezse yeni master seç
  function startMasterCheck() {
    if (_masterCheckInterval) clearInterval(_masterCheckInterval);
    _masterCheckInterval = setInterval(function() {
      if (_isMaster) return; // ben zaten master'ım
      if (_masterUserId && (Date.now() - _masterLastHB > MASTER_TIMEOUT)) {
        console.log("%c[BRIDGE] Master timeout! Yeni master seçiliyor...", "color: red; font-weight: bold;");
        _masterUserId = null;
        // En düşük userId master olur (deterministik)
        var playerIds = Object.keys(_players);
        playerIds.push(USER_ID);
        playerIds.sort();
        if (playerIds[0] === USER_ID) {
          claimMaster();
        } else {
          // Başkası master olacak, 3s bekle
          setTimeout(function() {
            if (!_masterUserId) claimMaster();
          }, 3000);
        }
      }
    }, 5000);
  }

  // ============================================================
  // 5) GAME EVENT HANDLER — PieSocket'ten gelen mesajları işle
  // ============================================================
  function handleGameEvent(event, data) {
    switch (event) {
      case "player:join":
        onPlayerJoin(data);
        break;
      case "player:bet":
        onPlayerBet(data);
        break;
      case "master:heartbeat":
        onMasterHeartbeat(data);
        break;
      case "master:claim":
        onMasterClaim(data);
        break;
      case "round:state":
        onRoundState(data);
        break;
      case "round:settle":
        onRoundSettle(data);
        break;
    }
  }

  function onPlayerJoin(data) {
    if (!data.userId) return;
    _players[data.userId] = {
      nickname: data.nickname || "Oyuncu",
      avatar: data.avatar || "",
      joinedAt: data.joinedAt || Date.now()
    };
    console.log("%c[BRIDGE] Oyuncu katıldı: " + data.nickname + " (toplam: " + (Object.keys(_players).length + 1) + ")", "color: lime;");
    // Yeni oyuncuya mevcut durumu bildir (sadece master)
    if (_isMaster && _currentRoundId) {
      sendPieSocket("round:state", {
        roundId: _currentRoundId,
        state: _currentState,
        countDown: 10,
        serverTime: Date.now()
      });
    }
  }

  function onPlayerBet(data) {
    if (!data.userId || data.userId === USER_ID) return; // kendi bahsimi zaten lokal işledim
    // Diğer oyuncunun bahsini kaydet
    if (!_allBets[data.userId]) _allBets[data.userId] = {};
    _allBets[data.userId][data.foodId] = (_allBets[data.userId][data.foodId] || 0) + data.amount;
    console.log("%c[BRIDGE] " + (data.nickname || "?") + " bahis yaptı: food=" + data.foodId + " +" + data.amount, "color: #00BCD4;");
    // Toplam bahisleri hesapla ve Cocos'a gönder
    var totalFoodBets = buildTotalFoodBets();
    sendRTMToGame("greedy_baby_sync_area_state", {
      roundId: _currentRoundId,
      areaBetData: totalFoodBets
    });
  }

  function onMasterHeartbeat(data) {
    if (!data.userId) return;
    _masterUserId = data.userId;
    _masterLastHB = Date.now();
  }

  function onMasterClaim(data) {
    if (!data.userId) return;
    // Eğer ben de master'ım ve diğerinin userId daha düşükse, ben bırakırım
    if (_isMaster && data.userId < USER_ID) {
      console.log("%c[BRIDGE] Master'lığı bırakıyorum → " + data.nickname, "color: orange;");
      _isMaster = false;
      if (_masterHBInterval) { clearInterval(_masterHBInterval); _masterHBInterval = null; }
    }
    if (!_isMaster) {
      _masterUserId = data.userId;
      _masterLastHB = Date.now();
      console.log("%c[BRIDGE] Master: " + (data.nickname || data.userId), "color: gold;");
    }
  }

  // Listener: master'dan gelen round state
  function onRoundState(data) {
    if (_isMaster) return; // master kendi state'ini zaten biliyor
    // Sync loop'u durdur — artık master'dan alıyoruz
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; console.log("%c[BRIDGE] Sync loop durduruldu → Master'dan alıyorum", "color: orange;"); }
    _currentRoundId = data.roundId;
    _currentState = data.state;

    if (data.state === 1) {
      _userBets = {};
      _allBets = {};
    }

    sendRTMToGame("greedy_baby_state", {
      roundId: data.roundId,
      state: data.state,
      countDown: data.countDown || 15,
      lotteryTime: data.lotteryTime || 5,
      areaBetData: data.areaBetData || [],
      betData: [],
      serverTime: data.serverTime || Date.now(),
    });
  }

  // Listener: master'dan gelen settle sonuçları
  function onRoundSettle(data) {
    if (_isMaster) return;
    var winFoodId = data.foodId;
    var multiple = data.multiple || MULTIPLIERS[winFoodId];
    var topWinners = data.winners || [];

    // Kendi kazancımı hesapla
    var userWinType = 0;
    var userAward = 0;
    if (Object.keys(_userBets).length > 0) {
      if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
        userWinType = 2;
        userAward = _userBets[winFoodId] * multiple;
        _userCoins += userAward;
      } else {
        userWinType = 1;
      }
    }

    if (userAward > 0) { _todayWin += userAward; saveTodayWin(); }
    addBetRecord(data.roundId, winFoodId, _userBets, userAward, _userCoins);

    // Lottery history güncelle
    _lotteryHistory.unshift(winFoodId);
    if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;
    saveLotteryHistory();

    console.log("%c[BRIDGE] Settle(listener): winType=" + userWinType + " award=" + userAward + " winners=" + topWinners.length, "color: gold;");
    sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
    notifyFlutterCoins(_userCoins);

    sendRTMToGame("greedy_baby_state", {
      roundId: data.roundId,
      state: 3,
      countDown: 5,
      resultData: {
        foodId: winFoodId,
        multiple: multiple,
        award: userAward,
        winType: userWinType,
        resultShowTime: 3,
        todayWin: _todayWin,
        winUser: topWinners,
      },
      lotteryResult: _lotteryHistory.slice(0, 20),
      delayShowResultTime: 0,
      todayWin: _todayWin,
      diamond: _userCoins,
      serverTime: Date.now(),
    });

    setTimeout(function () {
      sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward });
    }, 500);
  }

  // Tüm oyuncuların yemek başına toplam bahislerini hesapla
  function buildTotalFoodBets() {
    var totals = {};
    // Kendi bahislerim
    for (var fid in _userBets) {
      if (_userBets.hasOwnProperty(fid)) totals[fid] = (totals[fid] || 0) + _userBets[fid];
    }
    // Diğer oyuncuların bahisleri
    for (var uid in _allBets) {
      if (_allBets.hasOwnProperty(uid)) {
        for (var fid2 in _allBets[uid]) {
          if (_allBets[uid].hasOwnProperty(fid2)) totals[fid2] = (totals[fid2] || 0) + _allBets[uid][fid2];
        }
      }
    }
    // areaBetData formatına çevir
    var result = [];
    for (var fi = 0; fi < 8; fi++) {
      var total = totals[fi] || 0;
      var chipIdx = Math.min(Math.floor(total / 1000), 4);
      var chipNum = total > 0 ? Math.max(1, Math.min(Math.ceil(total / 500), 5)) : 0;
      result.push({
        foodId: fi,
        maxUserBet: total > 0 ? 1 : 0,
        chips: chipNum > 0 ? [{ index: chipIdx, num: chipNum }] : []
      });
    }
    return result;
  }

  // ============================================================
  // 6) COCOS'A RTM MESAJI GÖNDER
  // ============================================================
  function sendRTMToGame(event, params) {
    if (!_gameId) return;
    var payload = JSON.stringify({
      gameId: _gameId,
      events: [{ event: event, params: params }],
    });
    try {
      window.RTMResponseMsg(payload);
      console.log("%c[→GAME] " + event, "color: #4CAF50;", params);
    } catch (e) {
      console.error("[BRIDGE] RTMResponseMsg hata:", e);
    }
  }

  // ============================================================
  // 7) COCOS'TAN GELEN MESAJLARI YAKALA (requestMsg override)
  // ============================================================

  // Mock userAgent (oyun mobil kontrol yapıyor)
  var FAKE_UA = "Mozilla/5.0 (Linux; Android 12; Mock) AppleWebKit/537.36 (KHTML, like Gecko) appName/mock";
  try {
    Object.defineProperty(navigator, "userAgent", { get: function () { return FAKE_UA; }, configurable: true });
  } catch (e1) {
    try { navigator.__defineGetter__("userAgent", function () { return FAKE_UA; }); } catch (e2) {}
  }

  // Oyun window.Env'e bakıyor
  window.Env = "prod";
  window.Branch = "prod";
  window.Version = "1.0.17";

  // Console error/log spam'i azalt (audio + bilinen hatalar)
  function isAudioSpam(msg) {
    if (typeof msg !== "string") return false;
    return msg.indexOf("load audio failed") !== -1 ||
      msg.indexOf("playRemoteEffect_error") !== -1 ||
      msg.indexOf("preloadRemoteAudio_error") !== -1 ||
      msg.indexOf("failed to load Web Audio") !== -1 ||
      msg.indexOf("DOMException") !== -1;
  }
  var _origError = console.error;
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === "string") {
      if (msg.indexOf("3300") !== -1 || msg.indexOf("4930") !== -1 || msg.indexOf("ERR_SSL") !== -1) return;
      if (msg.indexOf("resetChipNum_error") !== -1 || msg.indexOf("loadImageByHttp_error") !== -1) return;
      if (isAudioSpam(msg)) return;
    }
    _origError.apply(console, arguments);
  };
  var _origLog = console.log;
  console.log = function () {
    var msg = arguments[0];
    if (isAudioSpam(msg)) return;
    _origLog.apply(console, arguments);
  };
  var _origWarn = console.warn;
  console.warn = function () {
    var msg = arguments[0];
    if (isAudioSpam(msg)) return;
    _origWarn.apply(console, arguments);
  };

  // ============================================================
  // BRIDGE RESPONSE FORMAT (base64 encoded JSON wrapper — native bridge formatı)
  // ============================================================
  function wrapBridgeResponse(data) {
    var wrapper = { params: (typeof data === "string") ? data : JSON.stringify(data) };
    var json = JSON.stringify(wrapper);
    try {
      return window.btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      return window.btoa(json);
    }
  }

  // ============================================================
  // getUserInfo dataları (her çağrıda güncel)
  // ============================================================
  function getUserInfoData() {
    refreshUserFromFlutter();
    return {
      userId: USER_ID,
      token: AUTH_TOKEN,
      packageName: "com.greedy.niva",
      uiLang: "TR",
      appVersion: "9.9.9",
      deviceId: "flutter_device",
      nickname: NICKNAME,
      avatar: AVATAR,
      icon: AVATAR,
      diamond: _userCoins,
      coin: _userCoins
    };
  }

  // localStorage'a da yaz (store mekanizması buradan okuyor)
  try {
    localStorage.setItem("userInfo", JSON.stringify(getUserInfoData()));
  } catch (e) {}
  // Avatar ön-yükleme (CORS proxy üzerinden)
  var _avatarPreloaded = false;
  function preloadAvatar() {
    if (_avatarPreloaded || !AVATAR) return;
    _avatarPreloaded = true;
    try {
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        console.log("%c[BRIDGE] Avatar ön-yüklendi: " + img.width + "x" + img.height, "color: lime;");
        // Cocos assetManager cache'e ekle
        try {
          var cc = window.cc;
          if (cc && cc.assetManager) {
            cc.assetManager.loadRemote(AVATAR, { ext: ".png" }, function (err) {
              if (err) console.warn("[BRIDGE] Avatar Cocos cache hata:", err);
              else console.log("%c[BRIDGE] Avatar Cocos cache OK", "color: lime;");
            });
          }
        } catch (e2) {}
      };
      img.onerror = function () {
        console.warn("[BRIDGE] Avatar ön-yükleme başarısız: " + AVATAR);
      };
      img.src = AVATAR;
    } catch (e) {}
  }

  // FLUTTER_USER gelince güncelle
  var _lsUpdateInterval = setInterval(function () {
    if (refreshUserFromFlutter()) {
      try { localStorage.setItem("userInfo", JSON.stringify(getUserInfoData())); } catch (e) {}
      preloadAvatar();
      clearInterval(_lsUpdateInterval);
    }
  }, 500);
  setTimeout(function () { clearInterval(_lsUpdateInterval); }, 15000);

  // ============================================================
  // FUN_METHODS (window.fun.xxx çağrıları için)
  // ============================================================
  var FUN_METHODS = {
    "getUserInfo": function() { return getUserInfoData(); },
    "getUserInfoNew": function() { return getUserInfoData(); },
    "getDeviceInfo": { deviceId: "flutter_device", os: "web", osVersion: "android", appVersion: "9.9.9", packageName: "com.greedy.niva", channel: "flutter" },
    "getNetworkState": "1",
    "getLanguage": "TR",
    "getStatusBarHeight": "0",
    "getAppVersion": { version: "9.9.9", versionCode: 999 },
    "getAppVersionCode": "999",
    "checkUpdate": { needUpdate: false },
    "getVersion": "9.9.9",
    "getToken": function() { refreshUserFromFlutter(); return AUTH_TOKEN; },
    "getFunId": function() { refreshUserFromFlutter(); return USER_ID; },
    "getRoomId": function() { refreshUserFromFlutter(); return ROOM_ID; },
    "getAppRequestHost": SUPABASE_URL,
    "closeLoadingPage": "",
    "closePage": function() { notifyFlutterClose(); return ""; },
    "showRechargeDialog": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "jumpToTarget": "",
    "speakerOperation": "",
    "micOperation": "",
    "isNativeAsset": "false",
    "event_webview_success": "",
    "popUpBottomRecharge": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "enterRoom": ""
  };

  // fun.* bridge mock (Cocos oyunu bunu bekliyor)
  window.fun = window.fun || {};
  Object.keys(FUN_METHODS).forEach(function (key) {
    window.fun[key] = function (params) {
      console.log("%c[BRIDGE FUN] " + key, "color: #ff9800;", params || "");
      var data = FUN_METHODS[key];
      var result = typeof data === "function" ? data(params) : data;
      if (!result && result !== "") return "";
      return wrapBridgeResponse(result);
    };
  });
  window.fun.nativeToH5 = function () {};
  window.fun.h5ToNative = function (data) {
    console.log("%c[BRIDGE FUN] h5ToNative", "color: #ff9800;", data);
    try {
      var parsed = typeof data === "string" ? JSON.parse(data) : data;
      var action = (parsed.action || parsed.method || parsed.type || parsed.name || "").toLowerCase();
      var target = (parsed.target || parsed.page || parsed.url || "").toLowerCase();
      var combined = action + " " + target + " " + JSON.stringify(parsed).toLowerCase();
      if (combined.indexOf("recharge") !== -1 || combined.indexOf("charge") !== -1 ||
          combined.indexOf("diamond") !== -1 || combined.indexOf("topup") !== -1 ||
          combined.indexOf("wallet") !== -1 || combined.indexOf("coin") !== -1 ||
          combined.indexOf("shop") !== -1) {
        console.log("%c[BRIDGE] h5ToNative → coins sayfası açılıyor", "color: lime;");
        notifyFlutterOpenCoinsPage();
      }
      if (combined.indexOf("close") !== -1 && combined.indexOf("loading") === -1) {
        console.log("%c[BRIDGE] h5ToNative → oyun kapatılıyor", "color: lime;");
        notifyFlutterClose();
      }
    } catch (e) {}
  };

  // ============================================================
  // WINDOW.PROMPT OVERRIDE (oyun native bridge'i prompt() ile kullanıyor)
  // ============================================================
  var PROMPT_RESPONSES = {
    "getUserInfo": function() { return wrapBridgeResponse(getUserInfoData()); },
    "getDeviceInfo": wrapBridgeResponse({ deviceId: "flutter_device", os: "web", osVersion: "android", appVersion: "9.9.9", packageName: "com.greedy.niva", channel: "flutter" }),
    "closeLoadingPage": "",
    "closePage": function() { notifyFlutterClose(); return ""; },
    "getNetworkState": wrapBridgeResponse("1"),
    "getLanguage": wrapBridgeResponse("TR"),
    "getStatusBarHeight": wrapBridgeResponse("0"),
    "showRechargeDialog": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "popUpBottomRecharge": function() { notifyFlutterOpenCoinsPage(); return ""; },
    "jumpToTarget": "",
    "speakerOperation": "",
    "micOperation": "",
    "getAppVersion": wrapBridgeResponse({ version: "9.9.9", versionCode: 999 }),
    "checkUpdate": wrapBridgeResponse({ needUpdate: false }),
    "getVersion": wrapBridgeResponse("9.9.9")
  };

  var originalPrompt = window.prompt;
  window.prompt = function (method, params) {
    if (method === "requestMsg") {
      console.log("%c[BRIDGE RTM ←] requestMsg", "color: orange;", params);
      if (window.fun && window.fun.requestMsg) {
        window.fun.requestMsg(params);
      }
      return "";
    }
    if (PROMPT_RESPONSES.hasOwnProperty(method)) {
      var resp = PROMPT_RESPONSES[method];
      console.log("%c[BRIDGE PROMPT] " + method, "color: #ff9800;", params || "");
      return typeof resp === "function" ? resp() : (resp || "");
    }
    console.warn("[BRIDGE PROMPT] Unknown:", method, params || "");
    var ml = (method || "").toLowerCase();
    if (ml.indexOf("recharge") !== -1 || ml.indexOf("charge") !== -1 ||
        ml.indexOf("diamond") !== -1 || ml.indexOf("topup") !== -1 ||
        ml.indexOf("wallet") !== -1 || ml.indexOf("shop") !== -1) {
      notifyFlutterOpenCoinsPage();
    }
    if (ml.indexOf("close") !== -1 && ml.indexOf("loading") === -1) {
      notifyFlutterClose();
    }
    return wrapBridgeResponse({});
  };

  // URL parametrelerine uid ve token ekle (globalContext.userInfo fallback)
  if (!window.location.search.includes("uid=")) {
    var injectParams = "uid=" + encodeURIComponent(USER_ID || "flutter_user") +
      "&token=" + encodeURIComponent(AUTH_TOKEN || "flutter_token") +
      "&roomId=" + encodeURIComponent(ROOM_ID || "0") +
      "&betVersion=1";
    var newUrl = window.location.pathname + "?" + injectParams + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }
  // host paramı her zaman ekle (record API için HostAddress gerekli)
  if (!window.location.search.includes("host=")) {
    var sep = window.location.search ? "&" : "?";
    var hostUrl = window.location.pathname + window.location.search + sep + "host=" + encodeURIComponent(btoa("https://mock-api")) + window.location.hash;
    window.history.replaceState(null, "", hostUrl);
  }

  window.game = window.game || {};
  window.game.netEventManger = window.game.netEventManger || {};
  if (typeof window.webkit === "undefined") {
    window.webkit = { messageHandlers: {} };
  }
  window.ReportEvent = window.ReportEvent || function () {};

  // API base URL set et (oyun bunu kullanıyor)
  window.REQUEST_API_URL = SUPABASE_URL;

  // ============================================================
  // API MOCK RESPONSES (oyun XHR ile sorgulama yapıyor)
  // ============================================================
  var MOCK_API_RESPONSES = {
    "/activity/probability-game/banner": { code: 200, message: "success", data: { banners: [] } },
    "/game/greedy-baby/gm": { code: 200, message: "success", data: {} },
    "/game/greedy-baby-rank/rank-v1": { code: 200, message: "success", data: { userType: 1, myRank: 0, myBet: 0, rankList: [] } },
    "/game/greedy-baby-rank/bet-recored": function() {
      var recs = _betRecords.slice().reverse();
      return { code: 200, message: "success", data: { page: 0, more: false, records: recs } };
    },
    "/game/operation/operation-search": { code: 200, message: "success", data: {} },
    "/v2/client-event/report": { code: 200, message: "ok" }
  };

  function findMockApiResponse(url) {
    for (var pattern in MOCK_API_RESPONSES) {
      if (url.indexOf(pattern) !== -1) {
        var val = MOCK_API_RESPONSES[pattern];
        var result = typeof val === "function" ? val() : val;
        console.log("%c[BRIDGE] MOCK HIT: " + pattern, "color: cyan;", result);
        return result;
      }
    }
    return null;
  }

  // AudioContext.decodeAudioData patch — DOMException'ı sustur
  try {
    var _origDecode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (buf, successCb, errorCb) {
      return _origDecode.call(this, buf, successCb, function (err) {
        // Sessiz WAV decode hatalarını yut
        if (errorCb) errorCb(err);
      }).catch(function () {});
    };
  } catch (e) {}

  // Minimal sessiz WAV — ArrayBuffer olarak (atob gerektirmez)
  var _silentAudioBuf = null;
  function getSilentAudioBuffer() {
    if (!_silentAudioBuf) {
      var buf = new ArrayBuffer(46);
      var d = new DataView(buf);
      d.setUint32(0, 0x52494646, false);  // "RIFF"
      d.setUint32(4, 38, true);           // file size - 8
      d.setUint32(8, 0x57415645, false);  // "WAVE"
      d.setUint32(12, 0x666D7420, false); // "fmt "
      d.setUint32(16, 16, true);          // chunk size
      d.setUint16(20, 1, true);           // PCM
      d.setUint16(22, 1, true);           // mono
      d.setUint32(24, 44100, true);       // sample rate
      d.setUint32(28, 88200, true);       // byte rate
      d.setUint16(32, 2, true);           // block align
      d.setUint16(34, 16, true);          // bits per sample
      d.setUint32(36, 0x64617461, false); // "data"
      d.setUint32(40, 2, true);           // data size
      d.setInt16(44, 0, true);            // silence
      _silentAudioBuf = buf;
    }
    return _silentAudioBuf;
  }

  function isAudioUrl(url) {
    return url && (url.indexOf("/sound/") !== -1 || /\.(mp3|ogg|wav|m4a)$/i.test(url));
  }

  // XHR interceptor
  var OriginalXHR = window.XMLHttpRequest;
  function BridgeXHR() {
    var realXHR = new OriginalXHR();
    var self = this;
    this._url = ""; this._mockResponse = null; this._isAudio = false; this._realXHR = realXHR;
    this.responseType = ""; this.timeout = 0; this.status = 0; this.response = null; this.readyState = 0;
    this.onload = null; this.onerror = null; this.ontimeout = null; this.onreadystatechange = null; this.onprogress = null;
  }
  BridgeXHR.prototype.open = function (method, url, async) {
    this._url = url;
    this._isAudio = isAudioUrl(url);
    this._mockResponse = findMockApiResponse(url);
    if (url.indexOf("/game/") !== -1 || url.indexOf("mock-api") !== -1) {
      console.log("%c[BRIDGE] XHR.open: " + method + " " + url + " mock=" + !!this._mockResponse, "color: orange;");
    }
    if (!this._mockResponse && !this._isAudio) this._realXHR.open(method, url, async !== false);
  };
  BridgeXHR.prototype.setRequestHeader = function (k, v) { if (!this._mockResponse) try { this._realXHR.setRequestHeader(k, v); } catch(e){} };
  BridgeXHR.prototype.addEventListener = function (t, fn) { if (!this._mockResponse) this._realXHR.addEventListener(t, fn); };
  BridgeXHR.prototype.getResponseHeader = function (n) { return this._mockResponse ? null : this._realXHR.getResponseHeader(n); };
  BridgeXHR.prototype.send = function (body) {
    var self = this;
    if (this._mockResponse) {
      setTimeout(function () {
        var mockStr = typeof self._mockResponse === "string" ? self._mockResponse : JSON.stringify(self._mockResponse);
        self.responseText = mockStr;
        // responseType="json" ise parsed object, değilse string
        self.response = (self.responseType === "json") ? self._mockResponse : mockStr;
        self.status = 200; self.readyState = 4;
        if (self.onload) self.onload();
        if (self.onreadystatechange) self.onreadystatechange();
      }, 50);
    } else if (this._isAudio) {
      // Ses dosyası → sessiz WAV ArrayBuffer döndür (404 spamı engeller)
      setTimeout(function () {
        self.status = 200; self.readyState = 4;
        self.response = getSilentAudioBuffer();
        if (self.onload) self.onload();
        if (self.onreadystatechange) self.onreadystatechange();
      }, 10);
    } else {
      var xr = this._realXHR;
      xr.responseType = this.responseType; xr.timeout = this.timeout;
      xr.onload = function () { self.status = xr.status; self.response = xr.response; self.readyState = xr.readyState; if (self.onload) self.onload(); };
      xr.onerror = function (e) { if (self.onerror) self.onerror(e); };
      xr.ontimeout = function (e) { if (self.ontimeout) self.ontimeout(e); };
      xr.onreadystatechange = function () { self.readyState = xr.readyState; self.status = xr.status; self.response = xr.response; if (self.onreadystatechange) self.onreadystatechange(); };
      xr.send(body);
    }
  };
  window.XMLHttpRequest = BridgeXHR;

  // Fetch interceptor
  var originalFetch = window.fetch;
  window.fetch = function (url, options) {
    var urlStr = typeof url === "string" ? url : url.url || "";
    var mockResp = findMockApiResponse(urlStr);
    if (mockResp) {
      return Promise.resolve(new Response(JSON.stringify(mockResp), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (isAudioUrl(urlStr)) {
      return Promise.resolve(new Response(getSilentAudioBuffer(), { status: 200, headers: { "Content-Type": "audio/wav" } }));
    }
    return originalFetch.apply(window, arguments);
  };

  // requestMsg — oyunun RTM mesajları
  window.fun.requestMsg = function (paramsStr) {
    try {
      var msg = JSON.parse(paramsStr);
      var action = msg.action || "";
      console.log("%c[GAME→] " + action, "color: #2196F3;", msg);

      if (action === "GreedyBaby:init") {
        _gameId = msg.gameId || "";
        handleGameInit();
      } else if (action === "GreedyBaby:join") {
        // join — state loop zaten PieSocket'ten geliyor
      } else if (action === "GreedyBaby:bet") {
        handleUserBet(msg);
      } else if (action === "GreedyBaby:diamond") {
        sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
      }
    } catch (e) {
      console.error("[BRIDGE] requestMsg parse error:", e);
    }
  };

  // ============================================================
  // 8) OYUN INIT — İlk bağlantı
  // ============================================================
  function handleGameInit() {
    getAuthFromFlutter().then(function () {
      // Bakiye al
      callGameEngine("get_state").then(function (result) {
        if (result && result.success) {
          _userCoins = result.coins || 0;
        }
        // Init mesajını HEMEN gönder — oyun bekleyemez
        var syncInfo = getSyncRoundInfo();
        sendInitToGame({ id: syncInfo.roundId, state: syncInfo.state }, result, syncInfo.countDown);
        _currentRoundId = syncInfo.roundId;
        _currentState = syncInfo.state;
        // Sync loop'u HEMEN başlat — PieSocket master olunca üstüne yazılacak
        console.log("%c[BRIDGE] Sync loop hemen başlatılıyor (PieSocket beklenmeden)", "color: yellow;");
        startLocalGameLoop();
      });

      // PieSocket bağlan — master election otomatik olur
      connectPieSocket();
      startMasterCheck();
    });
  }

  // Master olarak oyun döngüsünü başlat
  function startMasterGameLoop() {
    console.log("%c[BRIDGE] Master game loop başlatılıyor...", "color: gold; font-weight: bold;");
    // Sync loop'u durdur — master artık EF ile yönetecek
    if (_syncTimer) { clearInterval(_syncTimer); _syncTimer = null; console.log("%c[BRIDGE] Sync loop durduruldu → Master EF moduna geçiyor", "color: orange;"); }
    // Senkron bilgisini al ve EF ile round başlat
    callGameEngine("start_game").then(function (startRes) {
      if (startRes && startRes.success) {
        _currentRoundId = startRes.round_id;
        _currentState = 1;
        _userBets = {};
        _allBets = {};
        var betDuration = startRes.bet_duration || 15;
        // Kendi UI'ımı güncelle
        sendRTMToGame("greedy_baby_state", {
          roundId: startRes.round_id,
          state: 1,
          countDown: betDuration,
          betData: [],
          serverTime: Date.now(),
        });
        // Listener'lara bildir
        sendPieSocket("round:state", {
          roundId: startRes.round_id,
          state: 1,
          countDown: betDuration,
          serverTime: Date.now()
        });
        // Round ilerlemesini planla
        scheduleRoundProgression(startRes.round_id, betDuration);
      } else {
        // EF başarısız → senkron fallback
        console.warn("[BRIDGE] Master: start_game başarısız, senkron mod");
        startLocalGameLoop();
      }
    });
  }

  function sendInitToGame(round, stateResult, forcedCountDown) {
    var state = round ? round.state : 1;
    var countDown = forcedCountDown || 0;
    if (!forcedCountDown && round && round.bet_ends_at) {
      countDown = Math.max(0, Math.floor((new Date(round.bet_ends_at).getTime() - Date.now()) / 1000));
    }
    if (!forcedCountDown && state === 1 && countDown === 0) countDown = 15;

    var history = (stateResult && stateResult.lotteryResult && stateResult.lotteryResult.length > 0)
      ? stateResult.lotteryResult : (_lotteryHistory.length > 0 ? _lotteryHistory : []);

    sendRTMToGame("greedy_baby_init", {
      roundId: round ? round.id : 1000,
      state: state,
      countDown: countDown,
      diamond: _userCoins,
      betingId: 0,
      bets: [100, 1000, 5000, 10000, 50000],
      betData: [],
      rank: 0,
      lotteryTime: 5,
      lotteryResult: history,
      todayWin: _todayWin,
      winFoodId: -1,
      serverTime: Date.now(),
    });
  }

  // lotteryHistory: localStorage'dan yükle (sayfa yeniden açıldığında korunsun)
  var _lotteryHistory = [];
  try { var _savedLH = localStorage.getItem("lotteryHistory"); if (_savedLH) _lotteryHistory = JSON.parse(_savedLH); } catch(e) {}
  function saveLotteryHistory() { try { localStorage.setItem("lotteryHistory", JSON.stringify(_lotteryHistory)); } catch(e) {} }

  // Round ilerlemesi: bahis süresi → lottery → settle → next round (SADECE MASTER)
  function scheduleRoundProgression(roundId, betDuration) {
    if (!_isMaster) return;
    console.log("%c[BRIDGE] Master: Round " + roundId + " | " + betDuration + "s bahis başladı", "color: gold;");

    setTimeout(function () {
      if (!_isMaster) return; // master değilsem dur

      // Lottery çalıştır
      callGameEngine("run_lottery", { round_id: roundId }).then(function (lRes) {
        if (!lRes || !lRes.success) {
          console.warn("[BRIDGE] run_lottery başarısız:", lRes);
          return;
        }
        var winFoodId = lRes.win_food_id;
        var LOTTERY_TIME = 5;
        var multiple = lRes.multiplier || MULTIPLIERS[winFoodId];
        console.log("%c[BRIDGE] Kazanan: " + lRes.win_food_name + " (x" + multiple + ")", "color: gold;");

        // areaBetData — gerçek bahis toplamlarından oluştur
        var areaBetData = buildTotalFoodBets();

        // state=2 — kendi UI
        sendRTMToGame("greedy_baby_state", {
          roundId: roundId, state: 2, countDown: LOTTERY_TIME,
          lotteryTime: LOTTERY_TIME, areaBetData: areaBetData,
          serverTime: Date.now(),
        });
        // state=2 — listener'lara
        sendPieSocket("round:state", {
          roundId: roundId, state: 2, countDown: LOTTERY_TIME,
          lotteryTime: LOTTERY_TIME, areaBetData: areaBetData,
          serverTime: Date.now()
        });

        // Lottery süresi sonra settle
        setTimeout(function () {
          if (!_isMaster) return;
          callGameEngine("settle", { round_id: roundId, food_id: winFoodId }).then(function (sRes) {
            if (!sRes) return;

            _lotteryHistory.unshift(winFoodId);
            if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;
            saveLotteryHistory();

            var RESULT_SHOW_TIME = 3;

            // TÜM OYUNCULARIN kazananlarını hesapla
            var topWinners = buildAllWinners(winFoodId, multiple);

            // Kendi kazancımı hesapla
            var userWinType = 0; var userAward = 0;
            if (Object.keys(_userBets).length > 0) {
              if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
                userWinType = 2;
                userAward = _userBets[winFoodId] * multiple;
                _userCoins += userAward;
              } else {
                userWinType = 1;
              }
            }

            if (userAward > 0) { _todayWin += userAward; saveTodayWin(); }
            addBetRecord(roundId, winFoodId, _userBets, userAward, _userCoins);

            console.log("%c[BRIDGE] Settle(master): winType=" + userWinType + " award=" + userAward + " winners=" + topWinners.length, "color: gold;");
            sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
            notifyFlutterCoins(_userCoins);

            // state=3 — kendi UI
            sendRTMToGame("greedy_baby_state", {
              roundId: roundId, state: 3, countDown: RESULT_SHOW_TIME + 2,
              resultData: {
                foodId: winFoodId, multiple: multiple, award: userAward,
                winType: userWinType, resultShowTime: RESULT_SHOW_TIME,
                todayWin: _todayWin, winUser: topWinners,
              },
              lotteryResult: _lotteryHistory.slice(0, 20),
              delayShowResultTime: 0, todayWin: _todayWin,
              diamond: _userCoins, serverTime: Date.now(),
            });

            // Settle — listener'lara (herkese aynı winner listesini gönder)
            sendPieSocket("round:settle", {
              roundId: roundId, foodId: winFoodId, multiple: multiple,
              winners: topWinners, lotteryHistory: _lotteryHistory.slice(0, 20)
            });

            // Rank bilgisi
            setTimeout(function () {
              sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward });
            }, 500);

            // Yeni round
            setTimeout(function () {
              if (!_isMaster) return;
              // Avatar patch flag'lerini sıfırla
              try {
                var scene = cc.director.getScene();
                if (scene) {
                  var allN = scene.getComponentsInChildren(cc.UITransform).map(function(c){return c.node});
                  for (var ri = 0; ri < allN.length; ri++) {
                    if (allN[ri].name === "head_img" && allN[ri]._bridgeAvatarPatched) allN[ri]._bridgeAvatarPatched = false;
                  }
                }
              } catch(e3) {}

              callGameEngine("next_round", { round_id: roundId }).then(function (nRes) {
                if (nRes && nRes.success) {
                  _currentRoundId = nRes.round_id;
                  _currentState = 1;
                  _userBets = {};
                  _allBets = {};

                  sendRTMToGame("greedy_baby_state", {
                    roundId: nRes.round_id, state: 1, countDown: 15,
                    betData: [], serverTime: Date.now(),
                  });
                  sendPieSocket("round:state", {
                    roundId: nRes.round_id, state: 1, countDown: 15,
                    serverTime: Date.now()
                  });

                  scheduleRoundProgression(nRes.round_id, 15);
                }
              });
            }, (RESULT_SHOW_TIME + 2) * 1000);
          });
        }, LOTTERY_TIME * 1000);
      });
    }, betDuration * 1000);
  }

  // Tüm oyuncuların kazananlarını hesapla (master)
  function buildAllWinners(winFoodId, multiple) {
    var winners = [];
    // Master'ın kendi bahisleri
    if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
      var myAward = _userBets[winFoodId] * multiple;
      var avatarCB = AVATAR ? AVATAR + (AVATAR.indexOf("?") > -1 ? "&" : "?") + "_t=" + Date.now() : "";
      winners.push({ name: NICKNAME || "Oyuncu", icon: avatarCB, avatar: avatarCB, award: myAward });
    }
    // Diğer oyuncuların bahisleri
    for (var uid in _allBets) {
      if (_allBets.hasOwnProperty(uid) && _allBets[uid][winFoodId] && _allBets[uid][winFoodId] > 0) {
        var pAward = _allBets[uid][winFoodId] * multiple;
        var pInfo = _players[uid] || {};
        var pAvatar = pInfo.avatar || "";
        if (pAvatar) pAvatar = pAvatar + (pAvatar.indexOf("?") > -1 ? "&" : "?") + "_t=" + Date.now();
        winners.push({
          name: pInfo.nickname || "Oyuncu",
          icon: pAvatar, avatar: pAvatar,
          award: pAward
        });
      }
    }
    winners.sort(function (a, b) { return b.award - a.award; });
    return winners.slice(0, 3);
  }

  // ============================================================
  // ZAMAN-SENKRON GLOBAL GAME LOOP
  // Tüm oyuncular aynı tura, aynı saniyeye bakar.
  // Round süresi: 15s bahis + 5s çark + 5s sonuç = 25s döngü
  // ============================================================
  var SYNC_BET_DURATION = 15;
  var SYNC_LOTTERY_TIME = 5;
  var SYNC_RESULT_TIME = 5;
  var SYNC_ROUND_TOTAL = SYNC_BET_DURATION + SYNC_LOTTERY_TIME + SYNC_RESULT_TIME; // 25s
  var _syncTimer = null;
  var _syncLastState = -1;
  var _syncLastRoundId = -1;

  // Deterministik hash: round ID'den kazanan yiyecek belirle (herkes aynı sonucu görür)
  function hashToFood(roundId) {
    var h = 0;
    var s = String(roundId);
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 8;
  }

  function getSyncRoundInfo() {
    var now = Math.floor(Date.now() / 1000);
    var roundId = Math.floor(now / SYNC_ROUND_TOTAL);
    var elapsed = now % SYNC_ROUND_TOTAL;
    var state, countDown;
    if (elapsed < SYNC_BET_DURATION) {
      state = 1; // bahis
      countDown = SYNC_BET_DURATION - elapsed;
    } else if (elapsed < SYNC_BET_DURATION + SYNC_LOTTERY_TIME) {
      state = 2; // çark
      countDown = (SYNC_BET_DURATION + SYNC_LOTTERY_TIME) - elapsed;
    } else {
      state = 3; // sonuç
      countDown = SYNC_ROUND_TOTAL - elapsed;
    }
    var winFoodId = hashToFood(roundId);
    return { roundId: roundId, state: state, countDown: countDown, elapsed: elapsed, winFoodId: winFoodId };
  }

  function startLocalGameLoop() {
    console.log("%c[BRIDGE] Senkron global game loop başlatıldı", "color: orange; font-weight: bold;");
    _syncLastState = -1;
    _syncLastRoundId = -1;
    syncTick(); // İlk tick hemen
    if (_syncTimer) clearInterval(_syncTimer);
    _syncTimer = setInterval(syncTick, 500); // Her 500ms kontrol
  }

  function syncTick() {
    var info = getSyncRoundInfo();
    var roundChanged = info.roundId !== _syncLastRoundId;
    var stateChanged = info.state !== _syncLastState;

    if (!roundChanged && !stateChanged) return; // Değişiklik yok

    _currentRoundId = info.roundId;
    _currentState = info.state;

    // Yeni round başladı
    if (roundChanged) {
      _syncLastRoundId = info.roundId;
      _userBets = {};
    }

    if (stateChanged) {
      _syncLastState = info.state;
    }

    if (info.state === 1) {
      // Bahis aşaması — kullanıcının mevcut bahislerini de ekle ({foodId, bet} formatı)
      var currentBetData = [];
      for (var bf in _userBets) {
        if (_userBets.hasOwnProperty(bf) && _userBets[bf] > 0) {
          currentBetData.push({ foodId: parseInt(bf), bet: _userBets[bf] });
        }
      }
      sendRTMToGame("greedy_baby_state", {
        roundId: info.roundId,
        state: 1,
        countDown: info.countDown,
        betData: currentBetData,
        serverTime: Date.now(),
      });
    } else if (info.state === 2) {
      // Çark dönüyor
      var localAreaBetData = [];
      for (var fi = 0; fi < 8; fi++) {
        var ci = (info.roundId + fi) % 5;
        var cn = ((info.roundId * 3 + fi * 7) % 5) + 1;
        localAreaBetData.push({
          foodId: fi,
          maxUserBet: fi === info.winFoodId ? 1 : 0,
          chips: [{ index: ci, num: cn }]
        });
      }
      // Kullanıcının bahislerini de ekle ({foodId, bet} formatı)
      var betDataS2 = [];
      for (var bf2 in _userBets) {
        if (_userBets.hasOwnProperty(bf2) && _userBets[bf2] > 0) {
          betDataS2.push({ foodId: parseInt(bf2), bet: _userBets[bf2] });
        }
      }
      sendRTMToGame("greedy_baby_state", {
        roundId: info.roundId,
        state: 2,
        countDown: info.countDown,
        lotteryTime: SYNC_LOTTERY_TIME,
        areaBetData: localAreaBetData,
        betData: betDataS2,
        serverTime: Date.now(),
      });
    } else if (info.state === 3 && stateChanged) {
      // Sonuç — sadece state değiştiğinde bir kere çalışır
      var winFoodId = info.winFoodId;
      _lotteryHistory.unshift(winFoodId);
      if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;
      saveLotteryHistory();

      var multiple = MULTIPLIERS[winFoodId];
      var userWinType = 0;
      var userAward = 0;
      if (Object.keys(_userBets).length > 0) {
        if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
          userWinType = 2;
          userAward = _userBets[winFoodId] * multiple;
          _userCoins += userAward;
        } else {
          userWinType = 1;
        }
      }

      // Bugünkü kazancı güncelle
      if (userAward > 0) { _todayWin += userAward; saveTodayWin(); }
      // Geçmiş kaydı ekle
      addBetRecord(info.roundId, winFoodId, _userBets, userAward, _userCoins);

      var localTopWinners = [];
      // Kullanıcı kazandıysa winner listesinde göster
      if (userWinType === 2 && userAward > 0) {
        var avatarCB2 = AVATAR ? AVATAR + (AVATAR.indexOf("?") > -1 ? "&" : "?") + "_t=" + Date.now() : "";
        localTopWinners.push({ name: NICKNAME || "Oyuncu", icon: avatarCB2, avatar: avatarCB2, award: userAward });
      }
      console.log("%c[BRIDGE] Settle(sync): winType=" + userWinType + " award=" + userAward + " avatar=" + AVATAR + " winners=" + localTopWinners.length, "color: gold;");
      // Oyun UI'daki coin göstergesini güncelle
      sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
      notifyFlutterCoins(_userCoins);

      sendRTMToGame("greedy_baby_state", {
        roundId: info.roundId,
        state: 3,
        countDown: info.countDown,
        resultData: {
          foodId: winFoodId,
          multiple: multiple,
          award: userAward,
          winType: userWinType,
          resultShowTime: SYNC_RESULT_TIME,
          todayWin: _todayWin,
          winUser: localTopWinners,
        },
        lotteryResult: _lotteryHistory.slice(0, 20),
        delayShowResultTime: 0,
        todayWin: _todayWin,
        diamond: _userCoins,
        serverTime: Date.now(),
      });

      setTimeout(function () {
        sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward });
      }, 500);
    }
  }

  // ============================================================
  // 9) KULLANICI BAHİS
  // ============================================================
  var _betIdCounter = 1000;
  function handleUserBet(msg) {
    var betParams = msg.params || {};
    var betDataArr = betParams.betData || [];
    if (betDataArr.length === 0) return;

    var betFoodId = betDataArr[0].foodId || 0;
    var betAmount = (betDataArr[0].bets && betDataArr[0].bets[0]) || 100;

    // Yetersiz bakiye kontrolü
    if (_userCoins < betAmount) {
      console.warn("%c[BRIDGE] Yetersiz bakiye! coins=" + _userCoins + " bet=" + betAmount, "color: red;");
      notifyFlutterOpenCoinsPage();
      return;
    }

    // Önce local olarak düş (instant feedback)
    _userCoins -= betAmount;
    _userBets[betFoodId] = (_userBets[betFoodId] || 0) + betAmount;
    _betIdCounter++;
    var localBetId = _betIdCounter;

    console.log("%c[BRIDGE] Bahis: food=" + betFoodId + " amount=" + betAmount + " coins=" + _userCoins, "color: cyan;");
    notifyFlutterCoins(_userCoins);

    // PieSocket'e broadcast — diğer oyuncular görsün
    sendPieSocket("player:bet", {
      userId: USER_ID,
      nickname: NICKNAME,
      avatar: AVATAR,
      foodId: betFoodId,
      amount: betAmount
    });

    // betData: kullanıcının yemek başına toplam bahisleri — oyun {foodId, bet} formatı bekliyor
    var responseBetData = [];
    for (var fid in _userBets) {
      if (_userBets.hasOwnProperty(fid) && _userBets[fid] > 0) {
        responseBetData.push({ foodId: parseInt(fid), bet: _userBets[fid] });
      }
    }

    // Oyuna hemen onay gönder
    sendRTMToGame("greedy_baby_bet", {
      code: 0,
      roundId: _currentRoundId,
      diamond: _userCoins,
      betingId: localBetId,
      betData: responseBetData,
    });

    // Edge Function'a da gönder (arka planda)
    callGameEngine("place_bet", {
      round_id: _currentRoundId,
      food_id: betFoodId,
      amount: betAmount,
    }).then(function (result) {
      if (result && result.success) {
        // Gerçek bakiyeyle senkronize et
        _userCoins = result.remaining_coins;
        sendRTMToGame("greedy_baby_diamond_sync", { diamond: _userCoins });
        notifyFlutterCoins(_userCoins);
      } else {
        console.warn("[BRIDGE] Bahis backend'de reddedildi:", result);
      }
    }).catch(function(e) {
      console.warn("[BRIDGE] place_bet hatası (local devam ediyor):", e);
    });
  }

  // ============================================================
  // 10) GAME LOOP — Round döngüsü (Edge Function'ı tetikle)
  // ============================================================
  // Bu fonksiyon oda sahibi tarafından çağrılır.
  // Normal oyuncular sadece PieSocket'ten dinler.
  window.GREEDY_NIVA = {
    startGame: function () {
      callGameEngine("start_game");
    },
    runLottery: function (roundId) {
      callGameEngine("run_lottery", { round_id: roundId || _currentRoundId });
    },
    settle: function (roundId, winFoodId) {
      callGameEngine("settle", { round_id: roundId || _currentRoundId, food_id: winFoodId });
    },
    nextRound: function (roundId) {
      callGameEngine("next_round", { round_id: roundId || _currentRoundId });
    },

    // Otomatik game loop — test için
    autoLoop: function () {
      var self = this;
      console.log("%c[BRIDGE] Auto game loop başlatıldı!", "color: gold; font-weight: bold;");

      function loop() {
        self.startGame().then || callGameEngine("start_game").then(function (res) {
          if (!res || !res.success) return;
          var roundId = res.round_id;
          var betDuration = res.bet_duration || 15;

          // Bahis süresi sonunda lottery
          setTimeout(function () {
            callGameEngine("run_lottery", { round_id: roundId }).then(function (lotteryRes) {
              if (!lotteryRes || !lotteryRes.success) return;
              var winFoodId = lotteryRes.win_food_id;

              // Lottery animasyonu sonunda settle
              setTimeout(function () {
                callGameEngine("settle", { round_id: roundId, food_id: winFoodId }).then(function () {
                  // Settle sonunda yeni round
                  setTimeout(function () {
                    callGameEngine("next_round", { round_id: roundId }).then(function () {
                      // Devam
                    });
                  }, 5000);
                });
              }, 5000);
            });
          }, betDuration * 1000);
        });
      }

      loop();
    },
  };

  // ============================================================
  // 11) gameGlobal betVersion + GameRemoteHost patch
  // ============================================================
  var _patchDone = { betVersion: false, remoteHost: false };
  var betPatchInterval = setInterval(function () {
    try {
      if (window.__cclm && window.__cclm._moduleMap) {
        var entries = Object.entries(window.__cclm._moduleMap);
        for (var i = 0; i < entries.length; i++) {
          var mod = entries[i][1];
          if (!_patchDone.betVersion && mod && mod.exports && mod.exports.gameGlobal && mod.exports.gameGlobal.betVersion !== undefined) {
            mod.exports.gameGlobal.betVersion = 1;
            _patchDone.betVersion = true;
          }
          if (!_patchDone.remoteHost && mod && mod.exports && mod.exports.GameRemoteHost) {
            // Vercel'de HTTPS doğru, değiştirme
            _patchDone.remoteHost = true;
          }
        }
        if (_patchDone.betVersion && _patchDone.remoteHost) clearInterval(betPatchInterval);
      }
    } catch (e) {}
  }, 200);
  setTimeout(function () { clearInterval(betPatchInterval); }, 10000);

  // ============================================================
  // 12) TÜRKÇE ÇEVİRİ + UI PATCH
  // ============================================================
  var TR_MAP = {
    "Greedy Baby": "Greedy Niva",
    "Bet Time": "Bahis Süresi",
    "Show Time": "Sonuç",
    "Drawing": "Çekiliş",
    "You did not bet in this round": "Bu turda bahis yapmadınız",
    "Result": "Sonuçlar",
    "Fruit": "Meyve",
    "Pizza": "Pizza",
    "New": "Yeni",
    "TODAY'S WIN": "BUGÜNKÜ KAZANÇ",
    "Choose the amount wager -> Choose food": "Bahis miktarı seç -> Yiyecek seç",
    "Rank": "Sıralama",
    "Top": "En İyi",
    "WIN": "KAZANDINIZ",
    "LOSE": "KAYBETTİNİZ",
    "You Win!": "Kazandınız!",
    "You Lose!": "Kaybettiniz!",
    "Rule": "Kurallar",
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
    if (children) {
      for (var i = 0; i < children.length; i++) {
        collectAllNodes(children[i], result);
      }
    }
  }

  var _rankHidden = false;
  var _rechargeBtnPatched = false;
  var _nodesDumped = false;
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
          if (TR_MAP[lbl.string]) { lbl.string = TR_MAP[lbl.string]; continue; }
          var matched = false;
          for (var p = 0; p < TR_PREFIX.length; p++) {
            if (lbl.string.indexOf(TR_PREFIX[p].from) === 0) {
              lbl.string = lbl.string.replace(TR_PREFIX[p].from, TR_PREFIX[p].to);
              matched = true; break;
            }
          }
          if (matched) continue;
          for (var c = 0; c < TR_CONTAINS.length; c++) {
            if (lbl.string.indexOf(TR_CONTAINS[c].match) !== -1) {
              lbl.string = TR_CONTAINS[c].replace; break;
            }
          }
        }
      }

      var allNodes = [];
      collectAllNodes(scene, allNodes);

      if (!_rankHidden) {
        for (var j = 0; j < allNodes.length; j++) {
          var nd = allNodes[j];
          if (nd.name && nd.active !== false && (
            nd.name.toLowerCase().indexOf("rank") !== -1 ||
            nd.name.toLowerCase().indexOf("cup") !== -1 ||
            nd.name.toLowerCase().indexOf("trophy") !== -1
          )) {
            nd.active = false;
            _rankHidden = true;
          }
        }
      }

      // Tüm buton node isimlerini bir kez logla (debug)
      if (!_nodesDumped && cc.Button) {
        var btns = scene.getComponentsInChildren(cc.Button);
        if (btns && btns.length) {
          var names = [];
          for (var bi = 0; bi < btns.length; bi++) {
            names.push(btns[bi].node.name);
          }
          console.log("%c[BRIDGE] Tüm buton node isimleri: " + names.join(", "), "color: cyan;");
          _nodesDumped = true;
        }
      }

      // Recharge/Add butonu bul ve Flutter'a bağla
      if (!_rechargeBtnPatched && cc.Button) {
        var buttons = scene.getComponentsInChildren(cc.Button);
        if (buttons && buttons.length) {
          for (var b = 0; b < buttons.length; b++) {
            var bNode = buttons[b].node;
            var bName = (bNode.name || "").toLowerCase();
            if (bName.indexOf("recharge") !== -1 || bName.indexOf("charge") !== -1 ||
                bName.indexOf("adddia") !== -1 || bName.indexOf("add_dia") !== -1 ||
                bName.indexOf("adddiamond") !== -1 || bName.indexOf("diamond") !== -1 ||
                bName.indexOf("plus") !== -1 || bName.indexOf("topup") !== -1 ||
                bName.indexOf("充值") !== -1 || bName.indexOf("shop") !== -1 ||
                bName.indexOf("wallet") !== -1 || bName.indexOf("coin") !== -1) {
              console.log("%c[BRIDGE] Recharge butonu bulundu: " + bNode.name, "color: lime; font-weight: bold;");
              (function(node) {
                node.on(cc.Node.EventType.TOUCH_END, function() {
                  console.log("%c[BRIDGE] Recharge butonu tıklandı → coins sayfası", "color: lime;");
                  notifyFlutterOpenCoinsPage();
                });
              })(bNode);
              _rechargeBtnPatched = true;
            }
          }
        }
        // Label "+" olan node'u da dene
        if (!_rechargeBtnPatched) {
          for (var li = 0; li < allNodes.length; li++) {
            var an = allNodes[li];
            var anName = (an.name || "").toLowerCase();
            if (anName.indexOf("recharge") !== -1 || anName.indexOf("charge") !== -1 ||
                anName.indexOf("adddia") !== -1 || anName.indexOf("diamond_add") !== -1 ||
                anName.indexOf("btn_add") !== -1 || anName.indexOf("btnadd") !== -1 ||
                anName === "add" || anName === "plus") {
              console.log("%c[BRIDGE] Recharge node bulundu: " + an.name, "color: lime; font-weight: bold;");
              (function(node) {
                node.on(cc.Node.EventType.TOUCH_END, function() {
                  console.log("%c[BRIDGE] Recharge node tıklandı → coins sayfası", "color: lime;");
                  notifyFlutterOpenCoinsPage();
                });
              })(an);
              _rechargeBtnPatched = true;
              break;
            }
          }
        }
      }
      // you_chip: arka plan pembe, yazı siyah
      if (cc.Color && cc.Sprite) {
        if (!_chipLabelBlackColor) {
          _chipLabelBlackColor = new cc.Color(0, 0, 0, 255);
          _chipBgPinkColor = new cc.Color(218, 165, 32, 255); // Koyu sarı (goldenrod)
          // Oval köşeli beyaz texture oluştur (sarı tint için)
          try {
            var cvs = document.createElement("canvas");
            cvs.width = 128; cvs.height = 64;
            var ctx2d = cvs.getContext("2d");
            ctx2d.clearRect(0, 0, 128, 64);
            ctx2d.fillStyle = "#ffffff";
            ctx2d.beginPath();
            ctx2d.roundRect(0, 0, 128, 64, 28);
            ctx2d.fill();
            cvs.toBlob(function(blob) {
              if (!blob) return;
              var blobUrl = URL.createObjectURL(blob);
              cc.assetManager.loadRemote(blobUrl, { ext: ".png" }, function(err, imgAsset) {
                if (!err && imgAsset) {
                  try {
                    var t2d = new cc.Texture2D();
                    t2d.image = imgAsset;
                    _whiteSF = new cc.SpriteFrame();
                    _whiteSF.texture = t2d;
                    console.log("[BRIDGE] Oval SpriteFrame hazır (sarı chip BG)");
                  } catch(ex) {}
                }
              });
            }, "image/png");
          } catch(ex2) {}
        }
        for (var ci = 0; ci < allNodes.length; ci++) {
          var nd2 = allNodes[ci];
          if (nd2.name === "you_chip_label") {
            var chipLbl = nd2.getComponent(cc.Label);
            if (chipLbl) {
              chipLbl.color = _chipLabelBlackColor;
            }
          }
          if (nd2.name === "you_chip" && nd2.active) {
            var chipSprite = nd2.getComponent(cc.Sprite);
            if (chipSprite) {
              // Beyaz texture + pembe tint = pembe arka plan
              if (_whiteSF && chipSprite.spriteFrame !== _whiteSF) {
                chipSprite.spriteFrame = _whiteSF;
                chipSprite.type = 0; // SIMPLE
                chipSprite.sizeMode = 0; // CUSTOM
              }
              chipSprite.color = _chipBgPinkColor;
            }
            // chip_gray katmanını kalıcı olarak görünmez yap (sprite'yi devre dışı bırak)
            var chipGray = nd2.getChildByName && nd2.getChildByName("chip_gray");
            if (chipGray && !chipGray._bridgeHidden) {
              var graySpr = chipGray.getComponent(cc.Sprite);
              if (graySpr) graySpr.enabled = false;
              chipGray._bridgeHidden = true;
            }
            // layout içindeki ekstra yazıyı gizle (sadece you_chip_label ve ikon kalsın)
            var layoutNode = nd2.getChildByName && nd2.getChildByName("layout");
            if (layoutNode && layoutNode.children) {
              for (var li = 0; li < layoutNode.children.length; li++) {
                var lChild = layoutNode.children[li];
                if (lChild.name !== "you_chip_label") {
                  var lLabel = lChild.getComponent(cc.Label);
                  if (lLabel) {
                    lChild.active = false;
                  }
                }
              }
            }
          }
        }
      }
      // Avatar force-patch: settle view'daki winner head_img sprite'larına avatar yükle
      if (AVATAR && cc.assetManager && cc.Texture2D && cc.SpriteFrame) {
        for (var hi = 0; hi < allNodes.length; hi++) {
          var hn = allNodes[hi];
          // winner_0, winner_1, winner_2 altındaki head_img node'ları
          if ((hn.name === "winner_0" || hn.name === "winner_1" || hn.name === "winner_2") && hn.active) {
            var headNode = hn.getChildByName && hn.getChildByName("head_img");
            if (headNode) {
              var hSprite = headNode.getComponent(cc.Sprite);
              if (hSprite && !headNode._bridgeAvatarPatched) {
                headNode._bridgeAvatarPatched = true;
                (function(sprite, hNode) {
                  var avatarUrl = AVATAR + (AVATAR.indexOf("?") > -1 ? "&" : "?") + "_t=" + Date.now();
                  cc.assetManager.loadRemote(avatarUrl, { ext: ".jpg" }, function(err, imgAsset) {
                    if (!err && imgAsset && sprite.isValid) {
                      try {
                        var tex = new cc.Texture2D();
                        tex.image = imgAsset;
                        var sf = new cc.SpriteFrame();
                        sf.texture = tex;
                        sf.packable = false;
                        sprite.spriteFrame = sf;
                      } catch(e2) {
                        hNode._bridgeAvatarPatched = false;
                      }
                    } else {
                      hNode._bridgeAvatarPatched = false;
                    }
                  });
                })(hSprite, headNode);
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  setInterval(patchCocosLabels, 500);

  // networkState'i online yap + globalContext patch
  var netInterval = setInterval(function () {
    if (window.game && window.game.netEventManger) {
      var mgr = window.game.netEventManger;
      if (mgr.constructor) {
        mgr.constructor.networkState = 1;
      }
      if (!mgr._userInfo || !mgr._userInfo.token) {
        mgr._userInfo = getUserInfoData();
      }
    }
  }, 300);
  setTimeout(function () { clearInterval(netInterval); }, 15000);

  // HostAddress'i game yüklendikten sonra globalContext üzerine yaz
  // System.register wrapper ile modül export'unu intercept et
  var _origRegister = typeof System !== "undefined" && System.register;
  if (_origRegister) {
    System.register = function(name, deps, declare) {
      if (typeof name === "string" && name.indexOf("GlobalContext.ts") !== -1) {
        var origDeclare = declare;
        declare = function(exportFn) {
          var result = origDeclare(function(key, val) {
            if (key === "globalContext" && val && typeof val === "object") {
              val.HostAddress = "https://mock-api";
              val.gameId = val.gameId || 22;
              console.log("%c[BRIDGE] GlobalContext.HostAddress patched via register hook", "color: lime;");
            }
            return exportFn(key, val);
          });
          return result;
        };
      }
      return _origRegister.call(System, name, deps, declare);
    };
  }

  console.log("%c[BRIDGE] Konfigürasyon:", "color: yellow;");
  console.log("  Supabase:", SUPABASE_URL);
  console.log("  Kanal:", GLOBAL_CHANNEL);
  console.log("  User:", NICKNAME, "(ID:", USER_ID.substring(0, 8) + "...)");
  console.log("  Mod: Global Multiplayer (PieSocket)");
})();
