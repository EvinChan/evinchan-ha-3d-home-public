/*
 * 定制餐边柜卡片（furniture-library 运行时补丁）。
 *
 * 与 furniture-library-sofa.js 同构：载体 kind 是 `sideboard`（SPA 白名单内），
 * SPA 目录里的 label 是「边柜/餐边柜」，2D 标签/属性卡片按 modelId + 坐标改写
 * 为「餐边柜」。只做两件事：
 *   1. 往 `.furniture-library-grid` 注入一张"定制餐边柜"卡片（克隆原生卡片，
 *      MutationObserver 抢回 + 轮询兜底，lane 排序与既有补丁共存）；
 *   2. 点卡片 → 画布点击 → 经 REST 写入一条 kind "sideboard" +
 *      modelId "furniture.sideboard" 的家具记录（两步放置，一次性）。
 *
 * 3D 模型由 furniture-sideboard.js 渲染（含对原生 sideboard 的三层隐藏）。
 *
 * 防泄漏三件套（skill §2.3 / §2.3.1，每个新库补丁必做）：
 *   - 手势序号封堵（blockingSerial 初值 -1，click 到达才解锁）；
 *   - 跨补丁 armed 协调器 window.__ha3dLibArm；
 *   - handleDownGate 清理残留锁。
 *
 * Debug: window.HA3D_SIDEBOARD_LIB_DEBUG = true → window.ha3dSideboardLibDebug
 */
(function () {
  "use strict";

  var MODEL_ID = "furniture.sideboard";
  var CARRIER_KIND = "sideboard";
  var DIM = { width: 2.2, depth: 0.35, height: 2.5 };
  var LABEL = "餐边柜";
  var BUTTON_ID = "ha3d-sideboard-library-button";
  var POLL_MS = 500;
  var VERSION = 1;

  var stats = {
    version: VERSION,
    polls: 0,
    gridFound: false,
    injections: 0,
    reinjections: 0,
    armed: false,
    placed: 0,
    planPoints: 0,
    lastError: null,
  };
  window.ha3dSideboardLibDebug = stats;

  function log() {
    if (!window.HA3D_SIDEBOARD_LIB_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home sideboard-lib]"].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  /* 跨补丁 armed 协调器：任一库卡片武装时强制解除其它库补丁的 armed 状态。 */
  function armCoordinator() {
    if (!window.__ha3dLibArm) {
      var owners = {};
      window.__ha3dLibArm = {
        register: function (id, disarm) { owners[id] = disarm; },
        arm: function (id) {
          for (var k in owners) {
            if (k !== id && Object.prototype.hasOwnProperty.call(owners, k)) {
              try { owners[k](); } catch (e) {}
            }
          }
        },
      };
    }
    return window.__ha3dLibArm;
  }

  /* 卡片图标：高柜 + 玻璃展示格剪影 */
  var ICON_SVG =
    '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true">' +
    '<rect x="12" y="8" width="40" height="48" rx="2" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<line x1="26" y1="8" x2="26" y2="56" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    '<line x1="14" y1="22" x2="24" y2="22" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    '<line x1="14" y1="34" x2="24" y2="34" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    '<line x1="14" y1="46" x2="24" y2="46" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    '<line x1="28" y1="26" x2="50" y2="26" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    '<line x1="28" y1="26" x2="28" y2="8" stroke="currentColor" stroke-width="2" opacity="0.7"/>' +
    "</svg>";

  /* ----------------------------------------------------- 卡片注入 */
  function makeCard(nativeCard) {
    var btn;
    if (nativeCard && nativeCard.cloneNode) {
      btn = nativeCard.cloneNode(true);
      btn.removeAttribute("id");
      btn.classList.remove("active");
      btn.removeAttribute("onclick");
    } else {
      btn = document.createElement("button");
      btn.type = "button";
    }
    btn.id = BUTTON_ID;
    btn.setAttribute("aria-pressed", "false");
    btn.title = "添加定制餐边柜（点击后点击画布放置）";
    btn.innerHTML =
      '<span class="furniture-pictogram" aria-hidden="true">' + ICON_SVG + "</span>" +
      "<span><strong>" + LABEL + "</strong><small>" +
      DIM.width.toFixed(2) + " × " + DIM.depth.toFixed(2) + " m</small></span>";
    btn.addEventListener("click", function () {
      if (stats.armed) {
        setArmed(false);
        return;
      }
      armCoordinator().arm(BUTTON_ID); // 强制解除其它库补丁的 armed
      setArmed(true);
      disarmNativeCards();
    });
    if (stats.armed) {
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
    }
    return btn;
  }

  function isVisible(el) {
    try {
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (e) {
      return true;
    }
  }

  function findNativeCard() {
    var pics = document.querySelectorAll(".furniture-pictogram");
    for (var i = 0; i < pics.length; i += 1) {
      var card = pics[i].closest ? pics[i].closest("button") : null;
      if (card && card.id !== BUTTON_ID) return card;
    }
    return null;
  }

  function findGrid() {
    var grids = document.querySelectorAll(".furniture-library-grid");
    var fallback = null;
    for (var i = 0; i < grids.length; i += 1) {
      if (isVisible(grids[i])) return grids[i];
      if (!fallback) fallback = grids[i];
    }
    return fallback;
  }

  /* lane 排序：与其他补丁的卡片共存，位置固定、互不抢位 */
  var LANE_ORDER = [
    "ha3d-fridge-library-button",
    "ha3d-washer-library-button",
    "ha3d-dining-table-button",
    "ha3d-dining-chair-button",
    "ha3d-fabric-sofa-button",
    "ha3d-nested-coffee-table-button",
    BUTTON_ID,
  ];

  function laneIndexOf(id) {
    var i = LANE_ORDER.indexOf(id);
    return i < 0 ? LANE_ORDER.length : i;
  }

  function insertionPoint(grid) {
    var lane = laneIndexOf(BUTTON_ID);
    var kids = grid.children;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (!kid || !kid.id) return kid;
      if (laneIndexOf(kid.id) > lane) return kid;
    }
    return null;
  }

  function ensureCardsInGrid() {
    var grid = findGrid();
    if (!grid) {
      stats.gridFound = false;
      return;
    }
    stats.gridFound = true;
    var existing = document.getElementById(BUTTON_ID);
    if (existing && existing.parentNode === grid) return;
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var card = makeCard(findNativeCard());
    grid.insertBefore(card, insertionPoint(grid));
    stats.injections += 1;
    watchGrid(grid);
  }

  var observer = null;
  var observedGrid = null;
  var restoring = false;

  function watchGrid(grid) {
    if (!window.MutationObserver) return;
    if (observedGrid === grid && observer) return;
    try {
      if (observer) observer.disconnect();
      observedGrid = grid;
      observer = new MutationObserver(function (records) {
        var removedUs = false;
        for (var i = 0; i < records.length && !removedUs; i += 1) {
          var removed = records[i].removedNodes;
          if (!removed) continue;
          for (var j = 0; j < removed.length; j += 1) {
            if (removed[j] && removed[j].id === BUTTON_ID) {
              removedUs = true;
              break;
            }
          }
        }
        if (!removedUs || restoring) return;
        restoring = true;
        try {
          ensureCardsInGrid();
          stats.reinjections += 1;
        } catch (err) {
          stats.lastError = String(err);
        }
        restoring = false;
      });
      observer.observe(grid, { childList: true });
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* ------------------------------------------------- 两步放置 */
  function setArmed(on) {
    stats.armed = on;
    var btn = document.getElementById(BUTTON_ID);
    if (btn) {
      if (on) btn.classList.add("active");
      else btn.classList.remove("active");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function disarmNativeCards() {
    try {
      var all = document.querySelectorAll(
        '.furniture-library-grid > button, [class*="furniture-library"] button'
      );
      Array.prototype.forEach.call(all, function (b) {
        if (b.id === BUTTON_ID) return;
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
    } catch (err) {}
  }

  function planPointFromEvent(e) {
    var svg = e.target && e.target.closest ? e.target.closest("svg.floorplan-canvas") : null;
    if (!svg) svg = document.querySelector("svg.floorplan-canvas");
    if (!svg) return null;
    try {
      if (svg.getScreenCTM && svg.createSVGPoint) {
        var ctm = svg.getScreenCTM();
        if (ctm) {
          var pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          var p = pt.matrixTransform(ctm.inverse());
          if (isFinite(p.x) && isFinite(p.y)) return [p.x, p.y];
        }
      }
    } catch (err) {}
    try {
      var box = svg.getBoundingClientRect();
      var vb = svg.viewBox && svg.viewBox.baseVal;
      if (!box.width || !box.height || !vb || !vb.width || !vb.height) return null;
      return [
        vb.x + ((e.clientX - box.left) / box.width) * vb.width,
        vb.y + ((e.clientY - box.top) / box.height) * vb.height,
      ];
    } catch (err2) {
      stats.lastError = String(err2);
      return null;
    }
  }

  /* 手势序号封堵（skill §2.3）：blockingSerial 初值必须是 -1。 */
  var gestureSerial = 0;
  var blockingSerial = -1;

  function handleDown(e) {
    if (!stats.armed) return;
    var t = e.target;
    if (t && t.closest) {
      if (!t.closest("svg.floorplan-canvas")) {
        if (!t.closest("#" + BUTTON_ID)) setArmed(false);
        return;
      }
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    gestureSerial += 1;
    blockingSerial = gestureSerial;
    var pos = planPointFromEvent(e);
    if (pos) addItemAt(pos);
    setArmed(false); // 一次性放置
  }

  function handleUp(e, type) {
    var t = e.target;
    if (!t || !t.closest || !t.closest("svg.floorplan-canvas")) return;
    if (blockingSerial !== gestureSerial) {
      if (stats.armed) setArmed(false);
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    if (stats.armed) setArmed(false);
    if (type === "click") {
      blockingSerial = -1;
    }
  }

  /* ------------------------------------- 未选中时禁止拖拽（只拦 pointermove） */
  function footprintOf(el) {
    var n = el;
    while (n && n.closest) {
      if (n.classList && n.classList.contains("plan-furniture")) {
        return n.querySelector("rect.furniture-footprint");
      }
      n = n.parentNode;
    }
    return null;
  }

  function isSelectedFootprint(rect) {
    return !!(rect && rect.classList && rect.classList.contains("selected"));
  }

  var dragBlocked = false;

  function handleDownGate(e) {
    /* 清理残留锁：放置时 down 被 preventDefault，浏览器可能不发 click。 */
    if (blockingSerial === gestureSerial) blockingSerial = -1;

    var t = e.target;
    var onCanvas = !!(t && t.closest && t.closest("svg.floorplan-canvas"));
    if (!onCanvas) { dragBlocked = false; return; }
    var rect = footprintOf(t);
    dragBlocked = !!(rect && !isSelectedFootprint(rect));
  }

  function handleMoveGate(e) {
    if (!dragBlocked) return;
    e.stopImmediatePropagation();
  }

  function installPlacementInterceptor() {
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach(function (type) {
      window.addEventListener(
        type,
        function (e) {
          if (type === "pointerdown" || type === "mousedown") {
            if (stats.armed) handleDown(e);
            else handleDownGate(e);
          } else {
            if (type === "pointerup" || type === "mouseup") dragBlocked = false;
            handleUp(e, type);
          }
        },
        true
      );
    });
    window.addEventListener("pointermove", handleMoveGate, true);
  }

  function apiUrl(path) {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1] + path;
    return "." + path;
  }

  function addItemAt(pos) {
    fetch(apiUrl("/api/projects/current"), { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("load project failed " + res.status);
        return res.json();
      })
      .then(function (res) {
        var project = res && (res.project || res);
        if (!project || !project.floors || !project.floors.length) throw new Error("no project");
        var floor = project.floors[0];
        var item = {
          id: "furniture-sideboard-" + Date.now(),
          kind: CARRIER_KIND,
          floorId: floor.id,
          roomId: floor.rooms && floor.rooms[0] ? floor.rooms[0].id : null,
          position: [pos[0], pos[1]],
          rotation: 0,
          width: DIM.width,
          depth: DIM.depth,
          height: DIM.height,
          modelId: MODEL_ID,
        };
        floor.furniture = floor.furniture || [];
        floor.furniture.push(item);
        return fetch(apiUrl("/api/projects/" + project.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(project),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("save failed " + res.status);
        stats.placed += 1;
        log("sideboard added at", pos);
        var snapAfter = snapshot();
        if (snapAfter) snapAfter.refresh();
        if (window.ha3dSelectAfterPlace) window.ha3dSelectAfterPlace(pos);
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("add failed", err);
      });
  }

  /* ------------------------------------------------- 2D / 属性卡片文案改写
   * 载体 kind "sideboard" 的原生文案（"边柜/餐边柜"等）按 modelId + 平面坐标
   * 识别我们的记录后改写为「餐边柜」（绝不用尺寸识别）。 */
  var planPoints = [];

  function applyProject(project) {
    if (!project || !project.floors) return;
    var pts = [];
    project.floors.forEach(function (floor) {
      (floor.furniture || []).forEach(function (item) {
        if (!item || item.modelId !== MODEL_ID) return;
        if (!item.position || item.position.length < 2) return;
        pts.push([Number(item.position[0]), Number(item.position[1])]);
      });
    });
    planPoints = pts;
    stats.planPoints = pts.length;
  }

  function snapshot() {
    return window.ha3dProjectSnapshot || null;
  }

  function refreshPlanPoints() {
    var snap = snapshot();
    if (snap) {
      snap.request();
      return;
    }
    fetch(apiUrl("/api/projects/current"), { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (res) {
        applyProject(res && (res.project || res));
      })
      .catch(function (err) {
        stats.lastError = String(err);
      });
  }

  function planGroupTransform(g) {
    var t = g && g.getAttribute ? g.getAttribute("transform") : null;
    if (!t) return null;
    var m = /translate\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/.exec(t);
    if (!m) return null;
    var x = parseFloat(m[1]);
    var z = parseFloat(m[2]);
    if (!isFinite(x) || !isFinite(z)) return null;
    return [x, z];
  }

  function sideboardFootprintGroups() {
    var out = [];
    var svg = document.querySelector("svg.floorplan-canvas");
    if (!svg || !planPoints.length) return out;
    var groups = svg.querySelectorAll("g.plan-furniture");
    for (var i = 0; i < groups.length; i += 1) {
      var pos = planGroupTransform(groups[i]);
      if (!pos) continue;
      for (var j = 0; j < planPoints.length; j += 1) {
        var p = planPoints[j];
        if (Math.abs(pos[0] - p[0]) < 0.01 && Math.abs(pos[1] - p[1]) < 0.01) {
          out.push(groups[i]);
          break;
        }
      }
    }
    return out;
  }

  function relabelFootprints() {
    try {
      var groups = sideboardFootprintGroups();
      for (var i = 0; i < groups.length; i += 1) {
        var label = groups[i].querySelector("text.furniture-label");
        if (label && label.textContent !== LABEL) label.textContent = LABEL;
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* 属性卡片标题由 React 按 vt[kind].label 渲染并反复重建，每轮 tick 重写。 */
  function relabelInspectorTitle() {
    try {
      var groups = sideboardFootprintGroups();
      var selected = false;
      for (var i = 0; i < groups.length; i += 1) {
        if (groups[i].querySelector("rect.furniture-footprint.selected")) {
          selected = true;
          break;
        }
      }
      if (!selected) return;
      var h2 = document.querySelector(".inspector-title h2");
      if (h2 && h2.textContent !== LABEL && !/餐边柜/.test(h2.textContent)) h2.textContent = LABEL;
      var small = document.querySelector(".inspector-title small");
      if (small && /边柜/.test(small.textContent) && !/餐边柜/.test(small.textContent)) {
        small.textContent = small.textContent.replace(/边柜/g, LABEL);
      }
      var headings = document.querySelectorAll(".selection-summary-heading strong");
      for (var hi = 0; hi < headings.length; hi += 1) {
        if (headings[hi].textContent !== LABEL && /边柜/.test(headings[hi].textContent)) {
          headings[hi].textContent = headings[hi].textContent.replace(/边柜/g, LABEL);
        }
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* 点其他原生卡片时解除武装；Esc 解除武装 */
  function installGuards() {
    document.addEventListener(
      "click",
      function (e) {
        if (!stats.armed) return;
        var target = e.target;
        if (!target || !target.closest) return;
        if (target.closest("#" + BUTTON_ID)) return;
        var card = target.closest("button");
        if (card && card.querySelector(".furniture-pictogram")) setArmed(false);
      },
      true
    );
    document.addEventListener(
      "keydown",
      function (e) {
        if (stats.armed && (e.key === "Escape" || e.keyCode === 27)) setArmed(false);
      },
      true
    );
  }

  function start() {
    armCoordinator().register(BUTTON_ID, function () { setArmed(false); });
    installPlacementInterceptor();
    installGuards();
    ensureCardsInGrid();
    var snap = snapshot();
    if (snap) snap.subscribe(applyProject);
    refreshPlanPoints();
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      if (tick % 30 === 0) refreshPlanPoints();
      stats.polls += 1;
      try {
        ensureCardsInGrid();
      } catch (err) {
        stats.lastError = String(err);
      }
      relabelFootprints();
      relabelInspectorTitle();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
