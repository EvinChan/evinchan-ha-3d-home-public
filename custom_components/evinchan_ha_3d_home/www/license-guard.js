/*
 * License guard（授权状态 + 轻量反调试 / 完整性自检）。
 *
 * 目标：配合后端 license.py（Ed25519 验签）防止"改掉检查白嫖"。
 *
 * 分三层，从强到弱：
 *   1. 【服务端权威】真正的功能限制在后端业务接口里判定
 *      （license_store.has_feature）。前端无论怎么改都无法越过后端。
 *   2. 【完整性自检】本文件校验自身关键函数是否被运行时替换（比如有人
 *      在 console 里把 status 改成恒返回 {activated:true}）。发现篡改后
 *      自己降级成社区版，而不是继续信任。
 *   3. 【反调试提示】检测 DevTools 打开时，只在控制台提示一次、并把面板
 *      标记为"调试中"（不阻断任何操作），避免影响正常用户体验。
 *
 * 降级策略（社区版）：
 *   - 不解锁高级功能位（premium / advanced）；
 *   - 在页面上给出一个不打扰的激活入口（Console / API 均可）；
 *   - 基础查看与基础控制始终可用 —— 不能让正常用户觉得"东西坏了"。
 *
 * Debug: window.HA3D_LICENSE_DEBUG = true
 */
(function () {
  "use strict";

  if (window.ha3dLicenseGuard) return; // 幂等

  var API_TIMEOUT = 6000;
  var POLL_MS = 60000; // 授权状态变更不频繁，低频轮询即可
  var DEVTOOLS_PROBE_MS = 4000;

  function log() {
    if (window.HA3D_LICENSE_DEBUG) {
      try {
        console.log.apply(console, ["[3d-home license]"].concat([].slice.call(arguments)));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function apiBase() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") {
      return "/" + parts[0] + "/" + parts[1];
    }
    return "";
  }

  /* ------------------------------------------------------------ 状态模型 */

  /* 内部权威状态。注意：这个对象**不出现在 window 上**，外部只能通过
     status() 拿到一份拷贝，避免被直接改写。 */
  var state = {
    activated: false,
    tier: "community",
    features: ["basic_control", "view"],
    expiresAt: null,
    reason: "pending",
    machineId: null,
    tampered: false,
    devtools: false,
  };

  var subscribers = [];
  var lastFetchAt = 0;
  var inflight = null;

  function snapshot() {
    return {
      activated: state.activated,
      tier: state.tier,
      features: state.features.slice(),
      expiresAt: state.expiresAt,
      reason: state.reason,
      machineId: state.machineId,
      tampered: state.tampered,
      devtools: state.devtools,
    };
  }

  function emit() {
    var snap = snapshot();
    subscribers.slice().forEach(function (fn) {
      try {
        fn(snap);
      } catch (err) {
        log("subscriber failed", err);
      }
    });
    // 给 CSS / 其它补丁一个钩子
    try {
      document.documentElement.classList.toggle("ha3d-licensed", !!snap.activated);
      document.body &&
        document.body.classList.toggle("ha3d-community", !snap.activated);
    } catch (e) {
      /* ignore */
    }
  }

  function applyStatus(payload) {
    if (!payload || typeof payload !== "object") return;
    var activated = payload.activated === true && payload.tier === "licensed";
    var features = Array.isArray(payload.features)
      ? payload.features.filter(function (f) {
          return typeof f === "string";
        })
      : [];
    var changed =
      activated !== state.activated ||
      payload.tier !== state.tier ||
      features.join(",") !== state.features.join(",");

    state.activated = activated;
    state.tier = typeof payload.tier === "string" ? payload.tier : "community";
    state.features = features;
    state.expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : null;
    state.reason = typeof payload.reason === "string" ? payload.reason : "unknown";
    state.machineId = typeof payload.machineId === "string" ? payload.machineId : null;
    lastFetchAt = Date.now();

    if (changed) {
      log("status", snapshot());
      emit();
    }
  }

  /* -------------------------------------------------------- 完整性自检 */

  /* 记录关键函数的引用，用于检测运行时替换。
     检查方式：比较函数体字符串是否与注册时一致。攻击者若重写
     window.ha3dLicenseGuard.status 为恒真，这里能发现。 */
  var trusted = {};

  function fnSignature(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch (e) {
      return "";
    }
  }

  function verifyIntegrity() {
    var guard = window.ha3dLicenseGuard;
    if (!guard) return false;
    var keys = Object.keys(trusted);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (fnSignature(guard[k]) !== trusted[k]) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------- 网络请求 */

  function fetchStatus() {
    if (inflight) return inflight;
    var ctrl = null;
    var opts = { credentials: "same-origin" };
    try {
      ctrl = new AbortController();
      opts.signal = ctrl.signal;
    } catch (e) {
      /* 老浏览器无 AbortController，直接请求 */
    }
    var timer = window.setTimeout(function () {
      if (ctrl) {
        try {
          ctrl.abort();
        } catch (e) {
          /* ignore */
        }
      }
    }, API_TIMEOUT);

    inflight = fetch(apiBase() + "/api/license", opts)
      .then(function (res) {
        if (!res.ok) throw new Error("license endpoint " + res.status);
        return res.json();
      })
      .then(function (payload) {
        applyStatus(payload);
        return snapshot();
      })
      .catch(function (err) {
        // 请求失败不改变授权结论（避免网络抖动把已授权用户降级），
        // 只在从未成功获取过时标记为 unknown。
        if (state.reason === "pending") state.reason = "unreachable";
        log("status fetch failed", err);
        return snapshot();
      })
      .then(
        function (v) {
          window.clearTimeout(timer);
          inflight = null;
          return v;
        },
        function (e) {
          window.clearTimeout(timer);
          inflight = null;
          throw e;
        }
      );
    return inflight;
  }

  function activate(key) {
    return fetch(apiBase() + "/api/license", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: String(key || "") }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("activate failed " + res.status);
        return res.json();
      })
      .then(function (payload) {
        applyStatus(payload);
        return snapshot();
      });
  }

  /* ------------------------------------------------------- 反调试（轻量） */

  /* 只用最不误报的手段：debugger 计时差。不用 console.log getter 陷阱
     （它会在正常用户打开控制台时抛出副作用），也不用禁用右键/快捷键感受差的手段。
     发现 DevTools 也不阻断，只标记 + 一次性提示。 */
  var warnedDevTools = false;

  function detectDevTools() {
    var start = performance.now();
    try {
      // eslint-disable-next-line no-debugger
      debugger;
    } catch (e) {
      /* ignore */
    }
    var elapsed = performance.now() - start;
    var open = elapsed > 120;
    if (open !== state.devtools) {
      state.devtools = open;
      if (open && !warnedDevTools) {
        warnedDevTools = true;
        try {
          console.info(
            "[3d-home] 检测到开发者工具。本项目为付费授权软件，请遵守 LICENSE；" +
              "商业使用请通过 /api/license 激活授权。"
          );
        } catch (e) {
          /* ignore */
        }
      }
      emit();
    }
  }

  /* ------------------------------------------------------------ 对外 API */

  var guard = {
    version: 1,

    /* 当前授权快照（拷贝，改不动内部状态）。 */
    status: function () {
      return snapshot();
    },

    /* 是否具备某功能位。注意：这份结果仅供 UI 决定"显示与否"，
       服务端仍会独立校验，前端伪造不出真实权限。

       功能位以 features 列表为准，与 activated 无关：社区版也带
       view / basic_control，否则正常用户会觉得"东西坏了"。 */
    hasFeature: function (feature) {
      if (!verifyIntegrity()) {
        state.tampered = true;
        state.activated = false;
        state.tier = "community";
        state.features = ["basic_control", "view"];
        return feature === "basic_control" || feature === "view";
      }
      return state.features.indexOf(feature) >= 0;
    },

    isActivated: function () {
      return state.activated && !state.tampered;
    },

    /* 订阅状态变化：首次立刻回调一次。 */
    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      subscribers.push(fn);
      try {
        fn(snapshot());
      } catch (e) {
        /* ignore */
      }
      return function () {
        var i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    },

    /* 主动刷新（例如用户刚激活后）。 */
    refresh: function () {
      return fetchStatus();
    },

    /* 激活：写后端并以返回的服务端验签结果为准。 */
    activate: function (key) {
      return activate(key);
    },

    machineId: function () {
      return state.machineId;
    },
  };

  /* 注册"可信签名"，然后冻结 API 表面，防止被简单替换。 */
  ["status", "hasFeature", "isActivated", "subscribe", "refresh", "activate"].forEach(
    function (k) {
      trusted[k] = fnSignature(guard[k]);
    }
  );
  try {
    Object.freeze(guard);
  } catch (e) {
    /* ignore */
  }

  window.ha3dLicenseGuard = guard;

  /* ------------------------------------------------------------ 启动 */

  function boot() {
    fetchStatus();
    window.setInterval(function () {
      // 页面隐藏时不轮询，省电
      if (document.hidden) return;
      fetchStatus();
    }, POLL_MS);

    window.setInterval(function () {
      if (document.hidden) return;
      detectDevTools();
      if (!verifyIntegrity() && !state.tampered) {
        state.tampered = true;
        state.activated = false;
        state.tier = "community";
        log("integrity check failed, degraded to community");
        emit();
      }
    }, DEVTOOLS_PROBE_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
