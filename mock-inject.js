/**
 * MOCK INJECT - Backend olmadan oyunu çalıştırmak için
 * Bu dosya index.html'e ilk script olarak eklenir
 * 
 * Yaptıkları:
 * 1. window.REQUEST_API_URL set eder (local mock server'a yönlendirir)
 * 2. Native bridge fonksiyonlarını sahte verilerle doldurur (getUserInfo vb.)
 * 3. XMLHttpRequest'i intercept eder (API çağrılarını yakalar, mock response döner)
 * 4. fetch'i intercept eder (performans raporlama vs.)
 * 5. RTM (Real-Time Messaging) çağrılarını sahte yanıtlarla karşılar
 */

(function () {
  "use strict";

  console.log("%c[MOCK] Mock sistemi aktif!", "color: lime; font-weight: bold;");

  // Error 3300 spam'ini bastır (remote texture 1x1 stub → rect mismatch, zararsız)
  var _origError = console.error;
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === "string" && msg.indexOf("3300") !== -1) return;
    if (typeof msg === "string" && msg.indexOf("4930") !== -1) return;
    if (typeof msg === "string" && msg.indexOf("resetChipNum_error") !== -1) return;
    if (typeof msg === "string" && msg.indexOf("loadImageByHttp_error") !== -1) return;
    if (typeof msg === "string" && msg.indexOf("ERR_SSL") !== -1) return;
    _origError.apply(console, arguments);
  };

  // https://localhost → http://localhost patch (Image + XHR)
  var _origImageSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  if (_origImageSrcDesc && _origImageSrcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, "src", {
      get: _origImageSrcDesc.get,
      set: function (val) {
        if (typeof val === "string" && val.indexOf("https://localhost") === 0) {
          val = val.replace("https://localhost", "http://localhost");
        }
        _origImageSrcDesc.set.call(this, val);
      },
      configurable: true
    });
  }

  // Global error handler - yakalanmayan hataları logla
  window.addEventListener("error", function (e) {
    console.error("[MOCK ERROR CATCH]", e.message, e.filename, "line:", e.lineno);
  });
  window.addEventListener("unhandledrejection", function (e) {
    console.error("[MOCK PROMISE CATCH]", e.reason);
  });

  // ============================================================
  // 1) KONFIGURASYON
  // ============================================================
  var MOCK_API_HOST = "http://localhost:3001";
  var MOCK_CDN_HOST = "http://localhost:3001/cdn";

  // API base URL'yi set et (oyun bunu kullanıyor)
  window.REQUEST_API_URL = MOCK_API_HOST;

  // URL parametrelerine uid ve token ekle (globalContext.userInfo fallback olarak URL'den okuyor)
  if (!window.location.search.includes("uid=")) {
    var mockParams = "uid=" + encodeURIComponent("mock_user_001") +
      "&token=" + encodeURIComponent("mock_token_abc123") +
      "&roomId=mock_room_001" +
      "&betVersion=1";
    var newUrl = window.location.pathname + "?" + mockParams + window.location.hash;
    window.history.replaceState(null, "", newUrl);
  }

  // Oyun window.Env'e bakarak production/dev ayarı yapıyor
  window.Env = "prod";
  window.Branch = "mock";
  window.Version = "1.0.17";

  // Platform algılama: Oyun Id("android") kontrolü yapıyor (userAgent'ta Android + appName/ arar)
  // navigator.userAgent read-only olabilir, her yöntemi deneyelim
  var FAKE_UA = "Mozilla/5.0 (Linux; Android 12; Mock) AppleWebKit/537.36 (KHTML, like Gecko) appName/mock";
  try {
    Object.defineProperty(navigator, "userAgent", { get: function () { return FAKE_UA; }, configurable: true });
  } catch (e1) {
    try {
      navigator.__defineGetter__("userAgent", function () { return FAKE_UA; });
    } catch (e2) {
      // Son çare: Navigator prototype üzerinde dene
      try {
        Object.defineProperty(Navigator.prototype, "userAgent", { get: function () { return FAKE_UA; }, configurable: true });
      } catch (e3) {
        console.warn("[MOCK] userAgent override FAILED — will use direct store injection instead");
      }
    }
  }
  console.log("[MOCK] userAgent:", navigator.userAgent.substring(0, 60) + "...");

  // ============================================================
  // 2) SAHTE KULLANICI BİLGİSİ (Native bridge yerine)
  // ============================================================
  var MOCK_USER_INFO = {
    userId: "mock_user_001",
    token: "mock_token_abc123",
    packageName: "com.mock.game",
    uiLang: "EN",
    appVersion: "1.0.0",
    deviceId: "mock_device_001",
    nickname: "MockPlayer",
    avatar: "",
    diamond: 99999,
    coin: 99999
  };

  // getUserInfo için localStorage'a yaz (store mekanizması buradan okuyor)
  try {
    localStorage.setItem("userInfo", JSON.stringify(MOCK_USER_INFO));
  } catch (e) { }

  // ============================================================
  // 3) NATIVE BRIDGE MOCK (window.prompt override)
  // ============================================================
  // Oyun, native bridge ile window.prompt() üzerinden haberleşiyor.
  // getUserInfo, closeLoadingPage vb. çağrılar prompt("methodName") şeklinde yapılıyor.
  // Native uygulama prompt'u intercept edip JSON döndürüyor.
  // Biz de aynısını yapıyoruz:

  var originalPrompt = window.prompt;

  // Native bridge response formatı: base64( JSON({params: JSON_STRING, message: null}) )
  // Decode sonrası: message yoksa params JSON.parse edilir
  function wrapBridgeResponse(data) {
    var wrapper = { params: (typeof data === "string") ? data : JSON.stringify(data) };
    var json = JSON.stringify(wrapper);
    try {
      return window.btoa(unescape(encodeURIComponent(json)));
    } catch (e) {
      return window.btoa(json);
    }
  }

  var PROMPT_RESPONSES = {
    "getUserInfo": wrapBridgeResponse(MOCK_USER_INFO),
    "getDeviceInfo": wrapBridgeResponse({
      deviceId: "mock_device_001",
      os: "web",
      osVersion: "mock",
      appVersion: "9.9.9",
      packageName: "com.mock.game",
      channel: "mock"
    }),
    "closeLoadingPage": "",
    "getNetworkState": wrapBridgeResponse("1"),
    "getLanguage": wrapBridgeResponse("EN"),
    "getStatusBarHeight": wrapBridgeResponse("0"),
    "showRechargeDialog": "",
    "jumpToTarget": "",
    "speakerOperation": "",
    "micOperation": "",
    "getAppVersion": wrapBridgeResponse({ version: "9.9.9", versionCode: 999 }),
    "checkUpdate": wrapBridgeResponse({ needUpdate: false }),
    "getVersion": wrapBridgeResponse("9.9.9")
  };

  window.prompt = function (method, params) {
    // requestMsg = RTM çağrısı (sendRTM → RTMRequestMsg → prompt("requestMsg", msg))
    if (method === "requestMsg") {
      console.log("%c[MOCK RTM ←] requestMsg", "color: orange;", params);
      handleRTMRequest(params);
      return "";
    }
    // Bilinen native bridge method'ları
    if (PROMPT_RESPONSES.hasOwnProperty(method)) {
      var resp = PROMPT_RESPONSES[method];
      console.log("%c[MOCK BRIDGE] " + method, "color: #ff9800;", params || "");
      return resp || "";
    }
    // Bilinmeyen method'lar için de wrapped boş response döndür
    console.warn("[MOCK BRIDGE] Unknown method:", method, params || "");
    return wrapBridgeResponse({});
  };

  window.fun = window.fun || {};
  window.fun.nativeToH5 = function () { };

  // Fd fonksiyonu window.fun[method]() çağırıyor (Android path)
  // Her method için wrapBridgeResponse döndüren fonksiyon oluştur
  var FUN_METHODS = {
    "getUserInfo": MOCK_USER_INFO,
    "getUserInfoNew": MOCK_USER_INFO,
    "getDeviceInfo": { deviceId: "mock_device_001", os: "web", osVersion: "mock", appVersion: "9.9.9", packageName: "com.mock.game", channel: "mock" },
    "getNetworkState": "1",
    "getLanguage": "EN",
    "getStatusBarHeight": "0",
    "getAppVersion": { version: "9.9.9", versionCode: 999 },
    "getAppVersionCode": "999",
    "checkUpdate": { needUpdate: false },
    "getVersion": "9.9.9",
    "getToken": MOCK_USER_INFO.token,
    "getFunId": "mock_fun_id",
    "getRoomId": "mock_room_001",
    "getAppRequestHost": MOCK_API_HOST,
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
  Object.keys(FUN_METHODS).forEach(function (key) {
    window.fun[key] = function (params) {
      console.log("%c[MOCK FUN] " + key, "color: #ff9800;", params || "");
      var data = FUN_METHODS[key];
      if (!data && data !== "") return "";
      return wrapBridgeResponse(data);
    };
  });
  // requestMsg → RTM handler
  window.fun.requestMsg = function (msgStr) {
    console.log("%c[MOCK FUN] requestMsg", "color: orange;", msgStr);
    handleRTMRequest(msgStr);
  };
  // h5ToNative stub
  window.fun.h5ToNative = function (data) {
    console.log("%c[MOCK FUN] h5ToNative", "color: #ff9800;", data);
  };

  window.game = window.game || {};
  window.game.netEventManger = window.game.netEventManger || {};

  if (typeof window.webkit === "undefined") {
    window.webkit = { messageHandlers: {} };
  }

  // window.ReportEvent stub (yoksa hata fırlatıyor)
  window.ReportEvent = window.ReportEvent || function () { };

  // ============================================================
  // 4) MOCK API RESPONSES (URL pattern → sahte JSON)
  // ============================================================
  var MOCK_RESPONSES = {
    // Banner bilgisi
    "/activity/probability-game/banner": {
      code: 200,
      message: "success",
      data: {
        banners: [
          {
            id: 1,
            imageUrl: "",
            action: "",
            title: "Welcome!"
          }
        ]
      }
    },

    // GM komutu (test/debug)
    "/game/greedy-baby/gm": {
      code: 200,
      message: "success",
      data: {}
    },

    // Sıralama
    "/game/greedy-baby-rank/rank-v1": {
      code: 200,
      message: "success",
      data: {
        userType: 1,
        myRank: 5,
        myBet: 1000,
        rankList: [
          { rank: 1, uid: "u1", nickname: "Player1", avatar: "", bet: 50000 },
          { rank: 2, uid: "u2", nickname: "Player2", avatar: "", bet: 30000 },
          { rank: 3, uid: "u3", nickname: "Player3", avatar: "", bet: 20000 },
          { rank: 4, uid: "u4", nickname: "Player4", avatar: "", bet: 10000 },
          { rank: 5, uid: "mock_user_001", nickname: "MockPlayer", avatar: "", bet: 1000 }
        ]
      }
    },

    // Bahis kayıtları
    "/game/greedy-baby-rank/bet-recored": {
      code: 200,
      message: "success",
      data: {
        total: 0,
        list: []
      }
    },

    // Kullanıcı profil arama
    "/game/operation/operation-search": {
      code: 200,
      message: "success",
      data: {
        uid: "mock_user_001",
        userInfo: "ID: mock_user_001\nNickname: MockPlayer\nLevel: 10",
        recharge: 0,
        gameRole: "normal"
      }
    },

    // Performans raporlama (sessizce kabul et)
    "/v2/client-event/report": {
      code: 200,
      message: "ok"
    }
  };

  // URL'den path'i çıkar ve mock response bul
  function findMockResponse(url) {
    for (var pattern in MOCK_RESPONSES) {
      if (url.indexOf(pattern) !== -1) {
        console.log("%c[MOCK] Intercepted: " + pattern, "color: cyan;");
        return MOCK_RESPONSES[pattern];
      }
    }
    return null;
  }

  // ============================================================
  // 5) XMLHttpRequest OVERRIDE
  // ============================================================
  var OriginalXHR = window.XMLHttpRequest;

  function MockXHR() {
    var realXHR = new OriginalXHR();
    var self = this;

    this._method = "GET";
    this._url = "";
    this._mockResponse = null;
    this._realXHR = realXHR;

    // Proxy properties
    this.responseType = "";
    this.timeout = 0;
    this.status = 0;
    this.response = null;
    this.readyState = 0;

    // Event handlers
    this.onload = null;
    this.onerror = null;
    this.ontimeout = null;
    this.onreadystatechange = null;
    this.onprogress = null;
  }

  MockXHR.prototype.open = function (method, url, async) {
    this._method = method;
    // https://localhost → http://localhost (SSL fix)
    if (typeof url === 'string') {
      url = url.replace(/^https:\/\/localhost/, 'http://localhost');
      url = url.replace(/^https:\/\/127\.0\.0\.1/, 'http://127.0.0.1');
    }
    this._url = url;
    this._mockResponse = findMockResponse(url);

    if (!this._mockResponse) {
      this._realXHR.open(method, url, async !== false);
    }
  };

  MockXHR.prototype.setRequestHeader = function (key, value) {
    if (!this._mockResponse) {
      try { this._realXHR.setRequestHeader(key, value); } catch (e) { }
    }
  };

  MockXHR.prototype.addEventListener = function (type, fn) {
    if (!this._mockResponse) {
      this._realXHR.addEventListener(type, fn);
    }
  };

  MockXHR.prototype.getResponseHeader = function (name) {
    if (this._mockResponse) return null;
    return this._realXHR.getResponseHeader(name);
  };

  MockXHR.prototype.send = function (body) {
    var self = this;

    if (this._mockResponse) {
      // Sahte response döndür (50ms gecikme ile gerçekçi olsun)
      setTimeout(function () {
        self.status = 200;
        self.readyState = 4;
        self.response = self._mockResponse;

        if (self.onload) {
          self.onload();
        }
        if (self.onreadystatechange) {
          self.onreadystatechange();
        }
      }, 50);
    } else {
      // Gerçek XHR'a yönlendir
      var xr = this._realXHR;
      xr.responseType = this.responseType;
      xr.timeout = this.timeout;

      xr.onload = function () {
        self.status = xr.status;
        self.response = xr.response;
        self.readyState = xr.readyState;
        if (self.onload) self.onload();
      };
      xr.onerror = function (e) {
        if (self.onerror) self.onerror(e);
      };
      xr.ontimeout = function (e) {
        if (self.ontimeout) self.ontimeout(e);
      };
      xr.onreadystatechange = function () {
        self.readyState = xr.readyState;
        self.status = xr.status;
        self.response = xr.response;
        if (self.onreadystatechange) self.onreadystatechange();
      };

      xr.send(body);
    }
  };

  window.XMLHttpRequest = MockXHR;

  // ============================================================
  // 6) FETCH OVERRIDE
  // ============================================================
  var originalFetch = window.fetch;

  window.fetch = function (url, options) {
    var mockResp = findMockResponse(typeof url === "string" ? url : url.url || "");
    if (mockResp) {
      return Promise.resolve(
        new Response(JSON.stringify(mockResp), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
      );
    }
    return originalFetch.apply(window, arguments);
  };

  // ============================================================
  // 7) RTM (Real-Time Messaging) MOCK + GAME LOOP
  // ============================================================
  // Akış: sendRTM(msg) → RTMRequestMsg(msg) → prompt("requestMsg", msg)
  //   Biz prompt'ta yakalıyoruz → window.RTMResponseMsg(jsonStr) ile cevap veriyoruz
  // Response format: JSON.stringify({gameId:X, events:[{event:"...", params:{...}}]})

  var _mockRoundId = 1000;
  var _mockDiamond = 99999;
  var _mockGameId = "";
  var _mockBetingId = 0;
  var _gameLoopRunning = false;
  var _gameLoopTimer = null;
  var _fakeBetTimers = [];
  // Kullanıcının bu roundda yaptığı bahisler { foodId: totalBet }
  var _userBets = {};
  var _userTotalBet = 0;
  // Son kazanan meyveler geçmişi (result layout için)
  var _lotteryHistory = [0, 3, 5, 1, 7, 2, 4, 6];

  // Sahte oyuncular
  var FAKE_PLAYERS = [
    { userId: "fake_001", nickname: "Ahmet", avatar: "" },
    { userId: "fake_002", nickname: "Ayse", avatar: "" },
    { userId: "fake_003", nickname: "Mehmet", avatar: "" },
    { userId: "fake_004", nickname: "Fatma", avatar: "" },
    { userId: "fake_005", nickname: "Ali", avatar: "" }
  ];

  // RTMResponseMsg üzerinden oyuna sahte response gönder
  function sendRTMResponse(gameId, eventName, params) {
    var resp = {
      gameId: gameId,
      events: [{ event: eventName, params: params || {} }]
    };
    var jsonStr = JSON.stringify(resp);
    console.log("%c[MOCK RTM →] " + eventName, "color: #4CAF50;", params);
    setTimeout(function () {
      if (window.RTMResponseMsg) {
        window.RTMResponseMsg(jsonStr);
      } else {
        console.warn("[MOCK RTM] RTMResponseMsg not ready yet");
      }
    }, 50);
  }

  // Sahte bahisleri üret ve greedy_baby_sync_area_state gönder
  function sendFakeBets(roundId) {
    _fakeBetTimers.forEach(function (t) { clearTimeout(t); });
    _fakeBetTimers = [];
    var bets = [100, 1000, 5000, 10000, 50000];
    for (var b = 0; b < 8; b++) {
      (function (delay, foodIdx) {
        var t = setTimeout(function () {
          if (!_gameLoopRunning) return;
          var chipIndex = Math.floor(Math.random() * bets.length);
          var numChips = Math.floor(Math.random() * 3) + 1;
          var areaBetData = [];
          for (var f = 0; f < 8; f++) {
            areaBetData.push({
              foodId: f,
              maxUserBet: f === foodIdx ? 1 : 0,
              chips: f === foodIdx ? [{ index: chipIndex, num: numChips }] : []
            });
          }
          sendRTMResponse(_mockGameId, "greedy_baby_sync_area_state", {
            roundId: roundId,
            areaBetData: areaBetData
          });
        }, delay);
        _fakeBetTimers.push(t);
      })(Math.floor(Math.random() * 12000) + 1000, b);
    }
  }

  // Game state döngüsü: Ready(1) → Running(2) → Settle(3) → Ready
  function startGameLoop() {
    if (_gameLoopRunning) return;
    _gameLoopRunning = true;
    console.log("%c[MOCK GAME] Game loop started!", "color: lime; font-weight: bold;");
    runRound();
  }

  function runRound() {
    if (!_gameLoopRunning) return;
    _mockRoundId++;
    _userBets = {};
    _userTotalBet = 0;
    var winFoodId = Math.floor(Math.random() * 8);
    var LOTTERY_TIME = 5;

    // 1) READY state - bahis süresi (15s)
    sendRTMResponse(_mockGameId, "greedy_baby_state", {
      roundId: _mockRoundId,
      state: 1,
      countDown: 15,
      betData: [],
      serverTime: Date.now()
    });

    // Sahte oyuncuların bahislerini gönder
    sendFakeBets(_mockRoundId);

    // 2) 15s sonra RUNNING (çark dönüyor, 5s)
    _gameLoopTimer = setTimeout(function () {
      if (!_gameLoopRunning) return;
      // Sahte bahis timer'larını temizle
      _fakeBetTimers.forEach(function (t) { clearTimeout(t); });
      _fakeBetTimers = [];

      // areaBetData: her yiyecek için toplam bahis
      var areaBetData = [];
      for (var f = 0; f < 8; f++) {
        var chipIdx = Math.floor(Math.random() * 5);
        var n = Math.floor(Math.random() * 5) + 1;
        areaBetData.push({
          foodId: f,
          maxUserBet: f === winFoodId ? 1 : 0,
          chips: [{ index: chipIdx, num: n }]
        });
      }

      sendRTMResponse(_mockGameId, "greedy_baby_state", {
        roundId: _mockRoundId,
        state: 2,
        countDown: LOTTERY_TIME,
        lotteryTime: LOTTERY_TIME,
        areaBetData: areaBetData,
        serverTime: Date.now()
      });

      // 3) 5s sonra SETTLE (sonuç)
      _gameLoopTimer = setTimeout(function () {
        if (!_gameLoopRunning) return;
        // Geçmişe ekle
        _lotteryHistory.unshift(winFoodId);
        if (_lotteryHistory.length > 20) _lotteryHistory.length = 20;

        var multiple = [2, 5, 8, 14, 18, 25, 35, 50][winFoodId] || 5;
        var RESULT_SHOW_TIME = 3;

        // winType hesapla: 0=NOTBET, 1=LOSE, 2=WIN
        var userWinType = 0; // NOTBET
        var userAward = 0;
        if (_userTotalBet > 0) {
          if (_userBets[winFoodId] && _userBets[winFoodId] > 0) {
            userWinType = 2; // WIN
            userAward = _userBets[winFoodId] * multiple;
            _mockDiamond += userAward;
            console.log("%c[MOCK] KAZANDINIZ! food=" + winFoodId + " x" + multiple + " = +" + userAward, "color: gold; font-weight: bold;");
          } else {
            userWinType = 1; // LOSE
            console.log("%c[MOCK] Kaybettiniz. Kazanan food=" + winFoodId, "color: red;");
          }
        }

        // Top 3 kazananlar
        var topWinners = [];
        var shuffled = FAKE_PLAYERS.slice().sort(function () { return Math.random() - 0.5; });
        for (var w = 0; w < 3 && w < shuffled.length; w++) {
          topWinners.push({
            name: shuffled[w].nickname,
            icon: "",
            award: Math.floor(Math.random() * 50000) + 1000
          });
        }
        // Eğer kullanıcı kazandıysa, onu da listeye ekle
        if (userWinType === 2 && userAward > 0) {
          topWinners.push({ name: "MockPlayer", icon: "", award: userAward });
        }
        // award'a göre sırala (büyükten küçüğe)
        topWinners.sort(function (a, b) { return b.award - a.award; });
        topWinners = topWinners.slice(0, 3);

        sendRTMResponse(_mockGameId, "greedy_baby_state", {
          roundId: _mockRoundId,
          state: 3,
          countDown: RESULT_SHOW_TIME + 2,
          resultData: {
            foodId: winFoodId,
            multiple: multiple,
            award: userAward,
            winType: userWinType,
            resultShowTime: RESULT_SHOW_TIME,
            todayWin: Math.floor(Math.random() * 5000),
            winUser: topWinners
          },
          lotteryResult: _lotteryHistory.slice(0, 10),
          delayShowResultTime: 0,
          todayWin: Math.floor(Math.random() * 5000),
          diamond: _mockDiamond,
          serverTime: Date.now()
        });

        // Rank bilgisi gönder
        setTimeout(function () {
          sendRTMResponse(_mockGameId, "greedy_baby_rank", {
            rank: Math.floor(Math.random() * 50) + 1,
            award: Math.floor(Math.random() * 10000)
          });
        }, 500);

        // 4) sonuç süresinden sonra yeni round
        _gameLoopTimer = setTimeout(function () {
          if (_gameLoopRunning) runRound();
        }, (RESULT_SHOW_TIME + 2) * 1000);
      }, LOTTERY_TIME * 1000);
    }, 15000);
  }

  // RTM request handler (prompt("requestMsg") tarafından çağrılıyor)
  function handleRTMRequest(paramsRaw) {
    var msg;
    try {
      msg = (typeof paramsRaw === "string") ? JSON.parse(paramsRaw) : paramsRaw;
    } catch (e) {
      console.warn("[MOCK RTM] parse error:", e);
      return;
    }
    var action = msg.action || "";
    _mockGameId = msg.gameId || _mockGameId;
    console.log("%c[MOCK RTM] action: " + action, "color: orange;", msg);

    if (action === "GreedyBaby:init") {
      setTimeout(function () {
        sendRTMResponse(_mockGameId, "greedy_baby_init", {
          roundId: _mockRoundId,
          state: 1,
          countDown: 15,
          diamond: _mockDiamond,
          bets: [100, 1000, 5000, 10000, 50000],
          betData: [],
          rank: 0,
          lotteryTime: 5,
          lotteryResult: _lotteryHistory.slice(0, 10),
          todayWin: 0,
          winFoodId: -1,
          serverTime: Date.now()
        });
        startGameLoop();
      }, 200);
    } else if (action === "GreedyBaby:join") {
      // join'a doğrudan cevap gerekmiyor, state loop zaten çalışıyor
    } else if (action === "GreedyBaby:bet") {
      var betParams = msg.params || {};
      var betAmount = 100;
      var betFoodId = 0;
      var betDataArr = betParams.betData || [];
      if (betDataArr.length > 0) {
        betFoodId = betDataArr[0].foodId || 0;
        betAmount = (betDataArr[0].bets && betDataArr[0].bets[0]) || 100;
      }
      _mockDiamond -= betAmount;
      // Bahsi kaydet
      _userBets[betFoodId] = (_userBets[betFoodId] || 0) + betAmount;
      _userTotalBet += betAmount;
      console.log("%c[MOCK] Bahis kaydedildi: food=" + betFoodId + " bet=" + betAmount + " toplam=" + _userTotalBet, "color: cyan;");
      var _betingId = (_mockBetingId = (_mockBetingId || 0) + 1);
      setTimeout(function () {
        // greedy_baby_bet → updateSpinData (oyuncunun kendi bahsi onayı)
        sendRTMResponse(_mockGameId, "greedy_baby_bet", {
          code: 0,
          roundId: _mockRoundId,
          diamond: _mockDiamond,
          betingId: _betingId,
          betData: betDataArr
        });
      }, 100);
    } else if (action === "GreedyBaby:charge") {
      _mockDiamond += 5000;
      setTimeout(function () {
        sendRTMResponse(_mockGameId, "greedy_baby_diamond_sync", { diamond: _mockDiamond });
      }, 100);
    } else {
      console.warn("[MOCK RTM] Unhandled:", action);
    }
  }

  // ============================================================
  // 8) networkState'i her zaman online yap + globalContext patch
  // ============================================================
  var netInterval = setInterval(function () {
    if (window.game && window.game.netEventManger) {
      var mgr = window.game.netEventManger;
      if (mgr.constructor) {
        mgr.constructor.networkState = 1;
      }
      // _userInfo'yu da set et
      if (!mgr._userInfo || !mgr._userInfo.token) {
        mgr._userInfo = MOCK_USER_INFO;
      }
    }
  }, 300);
  setTimeout(function () { clearInterval(netInterval); }, 15000);

  // gameGlobal betVersion + GameRemoteHost (https→http) patch
  var _patchDone = { betVersion: false, remoteHost: false };
  var betPatchInterval = setInterval(function () {
    try {
      if (window.__cclm && window.__cclm._moduleMap) {
        var entries = Object.entries(window.__cclm._moduleMap);
        for (var i = 0; i < entries.length; i++) {
          var mod = entries[i][1];
          if (!_patchDone.betVersion && mod && mod.exports && mod.exports.gameGlobal && mod.exports.gameGlobal.betVersion !== undefined) {
            mod.exports.gameGlobal.betVersion = 1;
            console.log("%c[MOCK] gameGlobal.betVersion = 1 patched!", "color: lime;");
            _patchDone.betVersion = true;
          }
          if (!_patchDone.remoteHost && mod && mod.exports && mod.exports.GameRemoteHost) {
            var oldHost = mod.exports.GameRemoteHost;
            mod.exports.GameRemoteHost = oldHost.replace("https://", "http://");
            if (mod.exports.AudioRemoteHost) {
              mod.exports.AudioRemoteHost = mod.exports.AudioRemoteHost.replace("https://", "http://");
            }
            console.log("%c[MOCK] GameRemoteHost patched: " + oldHost + " → " + mod.exports.GameRemoteHost, "color: lime;");
            _patchDone.remoteHost = true;
          }
        }
        if (_patchDone.betVersion && _patchDone.remoteHost) {
          clearInterval(betPatchInterval);
        }
      }
    } catch(e) {}
  }, 200);
  setTimeout(function () { clearInterval(betPatchInterval); }, 10000);

  // ============================================================
  // 9) getAppRequestHost mock (HostAddress için)
  // ============================================================
  // Oyun appRequestHost.live'dan HostAddress alıyor
  window.fun.getAppRequestHost = function () {
    console.log("%c[MOCK FUN] getAppRequestHost", "color: #ff9800;");
    return wrapBridgeResponse({
      live: MOCK_API_HOST,
      report: MOCK_API_HOST
    });
  };

  console.log("%c[MOCK] Konfigürasyon:", "color: yellow;");
  console.log("  API Host:", MOCK_API_HOST);
  console.log("  User:", MOCK_USER_INFO.nickname, "(ID:", MOCK_USER_INFO.userId + ")");
  console.log("  Diamond:", MOCK_USER_INFO.diamond);

  // ============================================================
  // 10) UI PATCH: İsim değişikliği, Türkçe çeviri, Rank kupası gizle
  // ============================================================
  // Exact match çeviriler
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
    "1. Choose the quantity of coins and then select a type of food to place a bet on.": "1. Bahis miktarını seçin ve ardından bahis yapmak istediğiniz yiyeceği seçin.",
    "2. Each round, you have 30 seconds to choose a food, and then the winning food will be drawn.": "2. Her turda yiyecek seçmek için 30 saniyeniz var, ardından kazanan yiyecek belirlenir.",
    "3. If you bet coins on the winning food, you will receive the corresponding prize money.": "3. Kazanan yiyeceğe bahis yaptıysanız, karşılık gelen ödülü kazanırsınız.",
    "4. If the winning food is a fruit, then apple, mango, strawberry, and lemon are all winners. If the winning food is a pizza, then fish, burger, pizza, and chicken are all winners.": "4. Kazanan yiyecek meyveyse; elma, mango, çilek ve limon hepsi kazanır. Kazanan yiyecek pizzaysa; balık, hamburger, pizza ve tavuk hepsi kazanır."
  };
  // startsWith çeviriler (TODAY'S WIN 545 gibi)
  var TR_PREFIX = [
    { from: "TODAY'S WIN", to: "BUGÜNKÜ KAZANÇ" }
  ];
  // contains → full replace (Rule popup gibi uzun metinler)
  var TR_CONTAINS = [
    { match: "Choose the quantity of coins", replace: "1. Bahis miktarını seçin ve ardından bahis yapmak istediğiniz yiyeceği seçin." },
    { match: "Each round, you have 30 seconds", replace: "2. Her turda yiyecek seçmek için 30 saniyeniz var, ardından kazanan yiyecek belirlenir." },
    { match: "If you bet coins on the winning", replace: "3. Kazanan yiyeceğe bahis yaptıysanız, karşılık gelen ödülü kazanırsınız." },
    { match: "If the winning food is a fruit", replace: "4. Kazanan yiyecek meyveyse; elma, mango, çilek ve limon hepsi kazanır. Kazanan yiyecek pizzaysa; balık, hamburger, pizza ve tavuk hepsi kazanır." },
    { match: "Choose the amount wager", replace: "Bahis miktarı seç -> Yiyecek seç" }
  ];

  // Recursive node arama
  function findNodeByName(root, name) {
    if (!root) return null;
    if (root.name === name) return root;
    var children = root.children;
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var found = findNodeByName(children[i], name);
        if (found) return found;
      }
    }
    return null;
  }

  // Tüm node'ları recursive topla
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

      // Tüm Label bileşenlerini bul ve çevir
      var labels = scene.getComponentsInChildren(cc.Label);
      if (labels && labels.length) {
        for (var i = 0; i < labels.length; i++) {
          var lbl = labels[i];
          if (!lbl || !lbl.string) continue;
          // Exact match
          if (TR_MAP[lbl.string]) {
            lbl.string = TR_MAP[lbl.string];
            continue;
          }
          // Prefix match (TODAY'S WIN 545 → BUGÜNKÜ KAZANÇ 545)
          var matched = false;
          for (var p = 0; p < TR_PREFIX.length; p++) {
            if (lbl.string.indexOf(TR_PREFIX[p].from) === 0) {
              lbl.string = lbl.string.replace(TR_PREFIX[p].from, TR_PREFIX[p].to);
              matched = true;
              break;
            }
          }
          if (matched) continue;
          // Contains match (Rule popup uzun metinleri)
          for (var c = 0; c < TR_CONTAINS.length; c++) {
            if (lbl.string.indexOf(TR_CONTAINS[c].match) !== -1) {
              lbl.string = TR_CONTAINS[c].replace;
              break;
            }
          }
        }
      }

      // Rank kupa butonunu gizle + node ağacını keşfet
      if (!_rankHidden) {
        var allNodes = [];
        collectAllNodes(scene, allNodes);
        var nodeNames = [];
        for (var j = 0; j < allNodes.length; j++) {
          var nd = allNodes[j];
          if (nd.name) nodeNames.push(nd.name);
          // rank, cup, trophy gibi isimler ara
          if (nd.name && nd.active !== false && (
            nd.name.toLowerCase().indexOf("rank") !== -1 ||
            nd.name.toLowerCase().indexOf("cup") !== -1 ||
            nd.name.toLowerCase().indexOf("trophy") !== -1
          )) {
            nd.active = false;
            _rankHidden = true;
            console.log("%c[MOCK] Rank/kupa gizlendi: " + nd.name, "color: lime;");
          }
        }
        if (!_rankHidden) {
          console.log("%c[MOCK] Node ağacı (rank aranıyor):", "color: orange;", nodeNames.filter(function(n){ return n.length > 1; }).join(", "));
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // Label'ları periyodik olarak patch'le
  var _labelPatchInterval = setInterval(patchCocosLabels, 500);
  setTimeout(function () { clearInterval(_labelPatchInterval); }, 60000);
  setTimeout(function () {
    setInterval(patchCocosLabels, 2000);
  }, 60000);

})();
