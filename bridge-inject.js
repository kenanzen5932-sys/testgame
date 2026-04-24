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

  // FLUTTER_USER enjekte edilene kadar bekle
  function refreshUserFromFlutter() {
    var u = window.FLUTTER_USER;
    if (u && u.token) {
      AUTH_TOKEN = u.token;
      USER_ID = u.userId || "";
      ROOM_ID = u.roomId || "0";
      NICKNAME = u.nickname || "Oyuncu";
      AVATAR = u.avatar || "";
      _authReady = true;
      console.log("%c[BRIDGE] FLUTTER_USER okundu: " + NICKNAME + " room=" + ROOM_ID, "color: lime;");
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

  // Çarpan tablosu
  var MULTIPLIERS = [5, 45, 5, 25, 5, 15, 10, 5];

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
    var body = Object.assign({ action: action, room_id: parseInt(ROOM_ID) || 0 }, params || {});

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
  // 4) PIESOCKET BAĞLANTISI
  // ============================================================
  function connectPieSocket() {
    if (!ROOM_ID) {
      console.warn("[BRIDGE] roomId yok, PieSocket bağlanmadı");
      return;
    }

    var channelName = "game-room-" + ROOM_ID;
    var wsUrl = "wss://" + PIESOCKET_CLUSTER + ".piesocket.com/v3/" + channelName + "?api_key=" + PIESOCKET_API_KEY + "&notify_self=0";

    console.log("%c[BRIDGE] PieSocket bağlanıyor: " + channelName, "color: orange;");

    _socket = new WebSocket(wsUrl);

    _socket.onopen = function () {
      console.log("%c[BRIDGE] PieSocket bağlı ✓", "color: lime; font-weight: bold;");
    };

    _socket.onmessage = function (evt) {
      try {
        var msg = JSON.parse(evt.data);
        // PieSocket mesaj formatı: { event, data, sender_id }
        var event = msg.event || "";
        var data = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;

        if (!event || !data) return;

        console.log("%c[PIESOCKET] " + event, "color: #ff9800;", data);

        handleGameEvent(event, data);
      } catch (e) {
        // ignore non-JSON
      }
    };

    _socket.onclose = function () {
      console.log("%c[BRIDGE] PieSocket kapandı, 3s sonra tekrar bağlanıyor...", "color: red;");
      setTimeout(connectPieSocket, 3000);
    };

    _socket.onerror = function (err) {
      console.error("[BRIDGE] PieSocket hata:", err);
    };
  }

  // ============================================================
  // 5) GAME EVENT HANDLER — PieSocket'ten gelen mesajları Cocos'a ilet
  // ============================================================
  function handleGameEvent(event, data) {
    switch (event) {
      case "client-game-state":
        handleGameState(data);
        break;
      case "client-game-bet":
        handleOtherPlayerBet(data);
        break;
    }
  }

  function handleGameState(data) {
    _currentState = data.state;

    if (data.roundId) _currentRoundId = data.roundId;

    if (data.state === 1) {
      // READY — yeni round, bahis süresi başladı
      _userBets = {};
      sendRTMToGame("greedy_baby_state", {
        roundId: data.roundId,
        state: 1,
        countDown: data.countDown || 15,
        betData: [],
        serverTime: data.serverTime || Date.now(),
      });
    } else if (data.state === 2) {
      // RUNNING — çekiliş animasyonu
      sendRTMToGame("greedy_baby_state", {
        roundId: data.roundId,
        state: 2,
        countDown: data.countDown || 5,
        serverTime: data.serverTime || Date.now(),
      });
    } else if (data.state === 3) {
      // SETTLE — sonuçlar
      var resultData = data.resultData || {};
      var winFoodId = resultData.foodId;

      // Kullanıcının kazanıp kazanmadığını hesapla
      var winType = 0; // NOTBET
      var userAward = 0;
      if (Object.keys(_userBets).length > 0) {
        if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
          winType = 2; // WIN
          userAward = _userBets[winFoodId] * (resultData.multiple || MULTIPLIERS[winFoodId]);
          _userCoins += userAward;
        } else {
          winType = 1; // LOSE
        }
      }

      sendRTMToGame("greedy_baby_state", {
        roundId: data.roundId,
        state: 3,
        countDown: (resultData.resultShowTime || 3) + 2,
        resultData: {
          foodId: winFoodId,
          multiple: resultData.multiple || MULTIPLIERS[winFoodId],
          award: userAward,
          winType: winType,
          resultShowTime: resultData.resultShowTime || 3,
          todayWin: resultData.todayWin || 0,
          winUser: resultData.winUser || [],
        },
        lotteryResult: data.lotteryResult || [],
        delayShowResultTime: 0,
        todayWin: resultData.todayWin || 0,
        diamond: _userCoins,
        serverTime: data.serverTime || Date.now(),
      });

      // Rank bilgisi
      setTimeout(function () {
        sendRTMToGame("greedy_baby_rank", {
          rank: 0,
          award: userAward,
        });
      }, 500);
    }
  }

  function handleOtherPlayerBet(data) {
    // Diğer oyuncuların bahislerini alan state'e ekle
    sendRTMToGame("greedy_baby_sync_area_state", {
      roundId: _currentRoundId,
      totalFoodBets: data,
    });
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

  // Console error spam'i azalt
  var _origError = console.error;
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === "string") {
      if (msg.indexOf("3300") !== -1 || msg.indexOf("4930") !== -1 || msg.indexOf("ERR_SSL") !== -1) return;
      if (msg.indexOf("resetChipNum_error") !== -1 || msg.indexOf("loadImageByHttp_error") !== -1) return;
    }
    _origError.apply(console, arguments);
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
      diamond: _userCoins,
      coin: _userCoins
    };
  }

  // localStorage'a da yaz (store mekanizması buradan okuyor)
  try {
    localStorage.setItem("userInfo", JSON.stringify(getUserInfoData()));
  } catch (e) {}
  // FLUTTER_USER gelince güncelle
  var _lsUpdateInterval = setInterval(function () {
    if (refreshUserFromFlutter()) {
      try { localStorage.setItem("userInfo", JSON.stringify(getUserInfoData())); } catch (e) {}
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
    "closePage": "",
    "showRechargeDialog": "",
    "jumpToTarget": "",
    "speakerOperation": "",
    "micOperation": "",
    "isNativeAsset": "false",
    "event_webview_success": "",
    "popUpBottomRecharge": "",
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
  };

  // ============================================================
  // WINDOW.PROMPT OVERRIDE (oyun native bridge'i prompt() ile kullanıyor)
  // ============================================================
  var PROMPT_RESPONSES = {
    "getUserInfo": function() { return wrapBridgeResponse(getUserInfoData()); },
    "getDeviceInfo": wrapBridgeResponse({ deviceId: "flutter_device", os: "web", osVersion: "android", appVersion: "9.9.9", packageName: "com.greedy.niva", channel: "flutter" }),
    "closeLoadingPage": "",
    "getNetworkState": wrapBridgeResponse("1"),
    "getLanguage": wrapBridgeResponse("TR"),
    "getStatusBarHeight": wrapBridgeResponse("0"),
    "showRechargeDialog": "",
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
    "/game/greedy-baby-rank/bet-recored": { code: 200, message: "success", data: { total: 0, list: [] } },
    "/game/operation/operation-search": { code: 200, message: "success", data: {} },
    "/v2/client-event/report": { code: 200, message: "ok" }
  };

  function findMockApiResponse(url) {
    for (var pattern in MOCK_API_RESPONSES) {
      if (url.indexOf(pattern) !== -1) return MOCK_API_RESPONSES[pattern];
    }
    return null;
  }

  // XHR interceptor
  var OriginalXHR = window.XMLHttpRequest;
  function BridgeXHR() {
    var realXHR = new OriginalXHR();
    var self = this;
    this._url = ""; this._mockResponse = null; this._realXHR = realXHR;
    this.responseType = ""; this.timeout = 0; this.status = 0; this.response = null; this.readyState = 0;
    this.onload = null; this.onerror = null; this.ontimeout = null; this.onreadystatechange = null; this.onprogress = null;
  }
  BridgeXHR.prototype.open = function (method, url, async) {
    this._url = url;
    this._mockResponse = findMockApiResponse(url);
    if (!this._mockResponse) this._realXHR.open(method, url, async !== false);
  };
  BridgeXHR.prototype.setRequestHeader = function (k, v) { if (!this._mockResponse) try { this._realXHR.setRequestHeader(k, v); } catch(e){} };
  BridgeXHR.prototype.addEventListener = function (t, fn) { if (!this._mockResponse) this._realXHR.addEventListener(t, fn); };
  BridgeXHR.prototype.getResponseHeader = function (n) { return this._mockResponse ? null : this._realXHR.getResponseHeader(n); };
  BridgeXHR.prototype.send = function (body) {
    var self = this;
    if (this._mockResponse) {
      setTimeout(function () {
        self.status = 200; self.readyState = 4; self.response = self._mockResponse;
        if (self.onload) self.onload();
        if (self.onreadystatechange) self.onreadystatechange();
      }, 50);
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
    var mockResp = findMockApiResponse(typeof url === "string" ? url : url.url || "");
    if (mockResp) {
      return Promise.resolve(new Response(JSON.stringify(mockResp), { status: 200, headers: { "Content-Type": "application/json" } }));
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
      // Bakiye ve durum al
      callGameEngine("get_state").then(function (result) {
        if (!result || !result.success) {
          console.error("[BRIDGE] get_state başarısız:", result);
          // Offline mod — mock init gönder
          sendInitToGame(null, result);
          startLocalGameLoop();
          return;
        }

        _userCoins = result.coins || 0;
        var round = result.round;

        if (round && round.state < 4) {
          // Aktif round var
          var state = round.state;
          var countDown = 0;
          if (round.bet_ends_at) {
            countDown = Math.max(0, Math.floor((new Date(round.bet_ends_at).getTime() - Date.now()) / 1000));
          }
          sendInitToGame(round, result);
          _currentRoundId = round.id;
          _currentState = state;
        } else {
          // Aktif round yok — başlat
          console.log("%c[BRIDGE] Aktif round yok, yeni başlatılıyor...", "color: gold;");
          callGameEngine("start_game").then(function (startRes) {
            if (startRes && startRes.success) {
              _currentRoundId = startRes.round_id;
              _currentState = 1;
              sendInitToGame({ id: startRes.round_id, state: 1 }, result, startRes.bet_duration || 15);
              // Bahis süresi sonunda otomatik lottery → settle → next
              scheduleRoundProgression(startRes.round_id, startRes.bet_duration || 15);
            } else {
              // Start da başarısız — local game loop
              console.warn("[BRIDGE] start_game başarısız, local loop:", startRes);
              sendInitToGame(null, result);
              startLocalGameLoop();
            }
          });
        }
      });

      // PieSocket bağlan
      connectPieSocket();
    });
  }

  function sendInitToGame(round, stateResult, forcedCountDown) {
    var state = round ? round.state : 1;
    var countDown = forcedCountDown || 0;
    if (!forcedCountDown && round && round.bet_ends_at) {
      countDown = Math.max(0, Math.floor((new Date(round.bet_ends_at).getTime() - Date.now()) / 1000));
    }
    if (!forcedCountDown && state === 1 && countDown === 0) countDown = 15;

    var history = (stateResult && stateResult.lotteryResult) || [];

    sendRTMToGame("greedy_baby_init", {
      roundId: round ? round.id : 1000,
      state: state,
      countDown: countDown,
      diamond: _userCoins,
      bets: [100, 1000, 5000, 10000, 50000],
      betData: [],
      rank: 0,
      lotteryTime: 5,
      lotteryResult: history,
      todayWin: 0,
      winFoodId: -1,
      serverTime: Date.now(),
    });
  }

  var _lotteryHistory = [];

  // Round ilerlemesi: bahis süresi → lottery → settle → next round
  function scheduleRoundProgression(roundId, betDuration) {
    console.log("%c[BRIDGE] Round " + roundId + " | " + betDuration + "s bahis başladı", "color: gold;");
    setTimeout(function () {
      // Lottery
      callGameEngine("run_lottery", { round_id: roundId }).then(function (lRes) {
        if (!lRes || !lRes.success) {
          console.warn("[BRIDGE] run_lottery başarısız:", lRes);
          return;
        }
        var winFoodId = lRes.win_food_id;
        var LOTTERY_TIME = 5;
        console.log("%c[BRIDGE] Kazanan: " + lRes.win_food_name + " (x" + lRes.multiplier + ")", "color: gold;");

        // state=2 gönder (çark dönüyor)
        sendRTMToGame("greedy_baby_state", {
          roundId: roundId,
          state: 2,
          countDown: LOTTERY_TIME,
          lotteryTime: LOTTERY_TIME,
          areaBetData: [],
          serverTime: Date.now(),
        });

        // Lottery süresi sonra settle
        setTimeout(function () {
          callGameEngine("settle", { round_id: roundId, food_id: winFoodId }).then(function (sRes) {
            if (!sRes) return;

            _lotteryHistory.unshift(winFoodId);
            if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;

            var multiple = sRes.multiplier || MULTIPLIERS[winFoodId];
            var RESULT_SHOW_TIME = 3;

            // Kullanıcının kazanıp kazanmadığını hesapla
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

            // state=3 gönder (sonuç)
            sendRTMToGame("greedy_baby_state", {
              roundId: roundId,
              state: 3,
              countDown: RESULT_SHOW_TIME + 2,
              resultData: {
                foodId: winFoodId,
                multiple: multiple,
                award: userAward,
                winType: userWinType,
                resultShowTime: RESULT_SHOW_TIME,
                todayWin: 0,
                winUser: sRes.top_winners || [],
              },
              lotteryResult: _lotteryHistory.slice(0, 10),
              delayShowResultTime: 0,
              todayWin: 0,
              diamond: _userCoins,
              serverTime: Date.now(),
            });

            // Rank bilgisi
            setTimeout(function () {
              sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward });
            }, 500);

            // Sonuç gösterim süresi sonra yeni round
            setTimeout(function () {
              callGameEngine("next_round", { round_id: roundId }).then(function (nRes) {
                if (nRes && nRes.success) {
                  _currentRoundId = nRes.round_id;
                  _currentState = 1;
                  _userBets = {};

                  sendRTMToGame("greedy_baby_state", {
                    roundId: nRes.round_id,
                    state: 1,
                    countDown: 15,
                    betData: [],
                    serverTime: Date.now(),
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

  // Local game loop (Edge Function çalışmıyorsa fallback)
  var _localRoundId = 1000;
  function startLocalGameLoop() {
    console.log("%c[BRIDGE] Local game loop başlatıldı (offline mod)", "color: orange; font-weight: bold;");
    runLocalRound();
  }

  function runLocalRound() {
    _localRoundId++;
    _currentRoundId = _localRoundId;
    _currentState = 1;
    _userBets = {};
    var betDuration = 15;
    var LOTTERY_TIME = 5;
    var RESULT_SHOW_TIME = 3;
    var winFoodId = Math.floor(Math.random() * 8);

    // state=1 (bahis)
    sendRTMToGame("greedy_baby_state", {
      roundId: _localRoundId,
      state: 1,
      countDown: betDuration,
      betData: [],
      serverTime: Date.now(),
    });

    setTimeout(function () {
      // state=2 (çark dönüyor)
      sendRTMToGame("greedy_baby_state", {
        roundId: _localRoundId,
        state: 2,
        countDown: LOTTERY_TIME,
        lotteryTime: LOTTERY_TIME,
        areaBetData: [],
        serverTime: Date.now(),
      });

      setTimeout(function () {
        // state=3 (sonuç)
        _lotteryHistory.unshift(winFoodId);
        if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;

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

        sendRTMToGame("greedy_baby_state", {
          roundId: _localRoundId,
          state: 3,
          countDown: RESULT_SHOW_TIME + 2,
          resultData: {
            foodId: winFoodId,
            multiple: multiple,
            award: userAward,
            winType: userWinType,
            resultShowTime: RESULT_SHOW_TIME,
            todayWin: 0,
            winUser: [],
          },
          lotteryResult: _lotteryHistory.slice(0, 10),
          delayShowResultTime: 0,
          todayWin: 0,
          diamond: _userCoins,
          serverTime: Date.now(),
        });

        setTimeout(function () {
          sendRTMToGame("greedy_baby_rank", { rank: 0, award: userAward });
        }, 500);

        setTimeout(function () {
          runLocalRound();
        }, (RESULT_SHOW_TIME + 2) * 1000);
      }, LOTTERY_TIME * 1000);
    }, betDuration * 1000);
  }

  // ============================================================
  // 9) KULLANICI BAHİS
  // ============================================================
  function handleUserBet(msg) {
    var betParams = msg.params || {};
    var betDataArr = betParams.betData || [];
    if (betDataArr.length === 0) return;

    var betFoodId = betDataArr[0].foodId || 0;
    var betAmount = (betDataArr[0].bets && betDataArr[0].bets[0]) || 100;

    // Edge Function'a bahis gönder
    callGameEngine("place_bet", {
      round_id: _currentRoundId,
      food_id: betFoodId,
      amount: betAmount,
    }).then(function (result) {
      if (result && result.success) {
        _userCoins = result.remaining_coins;
        _userBets[betFoodId] = (_userBets[betFoodId] || 0) + betAmount;

        // Oyuna onay gönder
        sendRTMToGame("greedy_baby_bet", {
          code: 0,
          roundId: _currentRoundId,
          diamond: _userCoins,
          betingId: result.bet_id,
          betData: betDataArr,
        });
      } else {
        // Hata — bahis reddedildi
        console.warn("[BRIDGE] Bahis reddedildi:", result);
        sendRTMToGame("greedy_baby_bet", {
          code: 1,
          msg: (result && result.error) || "Bahis yapılamadı",
        });
      }
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

      if (!_rankHidden) {
        var allNodes = [];
        collectAllNodes(scene, allNodes);
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

  console.log("%c[BRIDGE] Konfigürasyon:", "color: yellow;");
  console.log("  Supabase:", SUPABASE_URL);
  console.log("  Room:", ROOM_ID);
  console.log("  User:", NICKNAME, "(ID:", USER_ID.substring(0, 8) + "...)");
})();
