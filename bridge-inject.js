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

  // Flutter'dan gelen kullanıcı bilgileri (veya fallback)
  var USER = window.FLUTTER_USER || {};
  var AUTH_TOKEN = USER.token || "";
  var USER_ID = USER.userId || "";
  var ROOM_ID = USER.roomId || "";
  var NICKNAME = USER.nickname || "Oyuncu";
  var AVATAR = USER.avatar || "";

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
      if (AUTH_TOKEN) {
        resolve({ token: AUTH_TOKEN, userId: USER_ID });
        return;
      }
      // flutter_inappwebview bridge ile token al
      if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
        window.flutter_inappwebview.callHandler("getSupabaseAuth").then(function (auth) {
          if (auth && auth.token) {
            AUTH_TOKEN = auth.token;
            USER_ID = auth.uuid || auth.userId || "";
            console.log("%c[BRIDGE] Auth alındı: " + USER_ID.substring(0, 8) + "...", "color: lime;");
          }
          resolve({ token: AUTH_TOKEN, userId: USER_ID });
        });
      } else {
        resolve({ token: AUTH_TOKEN, userId: USER_ID });
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
  Object.defineProperty(navigator, "userAgent", {
    get: function () {
      return "Mozilla/5.0 (Linux; Android 12; Mock) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Mobile Safari/537.36";
    },
    configurable: true,
  });

  // Console error spam'i azalt
  var _origError = console.error;
  console.error = function () {
    var msg = arguments[0];
    if (typeof msg === "string") {
      if (msg.indexOf("3300") !== -1 || msg.indexOf("4930") !== -1 || msg.indexOf("ERR_SSL") !== -1) return;
    }
    _origError.apply(console, arguments);
  };

  // https → http patch (yerel geliştirme için)
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
      configurable: true,
    });
  }

  // fun.* bridge mock (Cocos oyunu bunu bekliyor)
  window.fun = window.fun || {};

  // getUserInfo — Flutter'dan gelen bilgiler
  var FUN_METHODS = {
    getUserInfo: function () {
      return {
        userId: USER_ID,
        token: AUTH_TOKEN,
        packageName: "com.greedy.niva",
        uiLang: "TR",
        appVersion: "1.0.0",
        clientType: "h5",
        nickname: NICKNAME,
        avatar: AVATAR,
        diamond: _userCoins,
      };
    },
    getDeviceInfo: function () {
      return { platform: "android", brand: "mock", model: "Mock", os: "Android 12" };
    },
    getAppRequestHost: function () {
      return { live: SUPABASE_URL, report: SUPABASE_URL };
    },
  };

  // fun.* proxy
  var funHandler = {
    get: function (target, key) {
      if (typeof target[key] === "function") return target[key];
      return function (params) {
        console.log("%c[BRIDGE FUN] " + key, "color: #ff9800;", params || "");
        var fn = FUN_METHODS[key];
        if (fn) {
          var result = typeof fn === "function" ? fn(params) : fn;
          return JSON.stringify({ code: 0, data: JSON.stringify(result) });
        }
        return "";
      };
    },
  };
  window.fun = new Proxy(window.fun, funHandler);

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
          return;
        }

        _userCoins = result.coins || 0;

        var round = result.round;
        var state = round ? round.state : 0;
        var countDown = 0;

        if (round && round.bet_ends_at) {
          var remaining = Math.max(0, Math.floor((new Date(round.bet_ends_at).getTime() - Date.now()) / 1000));
          countDown = remaining;
        }

        // Init response gönder
        sendRTMToGame("greedy_baby_init", {
          roundId: round ? round.id : 0,
          state: state || 0,
          countDown: countDown,
          diamond: _userCoins,
          bets: [100, 1000, 5000, 10000, 50000],
          betData: [],
          rank: 0,
          lotteryTime: 5,
          lotteryResult: result.lotteryResult || [],
          todayWin: 0,
          winFoodId: -1,
          serverTime: Date.now(),
        });

        _currentRoundId = round ? round.id : null;
        _currentState = state || 0;
      });

      // PieSocket bağlan
      connectPieSocket();
    });
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
            mod.exports.GameRemoteHost = mod.exports.GameRemoteHost.replace("https://", "http://");
            if (mod.exports.AudioRemoteHost) {
              mod.exports.AudioRemoteHost = mod.exports.AudioRemoteHost.replace("https://", "http://");
            }
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

  console.log("%c[BRIDGE] Konfigürasyon:", "color: yellow;");
  console.log("  Supabase:", SUPABASE_URL);
  console.log("  Room:", ROOM_ID);
  console.log("  User:", NICKNAME, "(ID:", USER_ID.substring(0, 8) + "...)");
})();
