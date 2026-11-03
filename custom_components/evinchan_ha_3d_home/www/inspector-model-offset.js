/*
 * 自定义模型"离地高度"微调（运行时补丁）。
 *
 * 为什么需要它：模型的底面在数学上已经精确贴地（ha3dNestedGround 显示
 * modelMinY ≈ 3e-10），但 SPA 的地板网格、阴影贴图、描边外壳、相机角度等
 * 渲染因素仍可能让落地部件看起来"陷进去"或"浮起来"。这类偏差没法靠几何
 * 自动算准，交给用户一眼微调是最省事的办法。
 *
 * 记录字段：liftOff（米，可正可负，默认 0 = 不偏移）
 *   - 正数 = 抬高，负数 = 下沉
 *   - 未设置时不写该字段，老项目结构不变
 *
 * 四层链路（见 ha3d-inspector-param skill）：
 *   ① UI       本文件：.selection-summary-card 之后插入滑块 + 数值输入
 *   ② schema   schema.py 的 normalize_furniture 白名单（_liftOff 校验）
 *   ③ 广播     views.py + gateway.py 自动完成
 *   ④ 3D       furniture-nested-coffee-table.js 的 applyLiftOff()
 *
 * Debug: window.ha3dLiftDebug
 */
(function () {
  "use strict";

  var VERSION = 1;
  var ROW_ID = "ha3d-model-lift-row";
  var ROW_CLASS = "ha3d-model-lift";
  var FIELD_KEY = "liftOff";
  var POLL_MS = 500;
  /* 允许的微调范围（米）。偏差通常只有几毫米到几厘米，
   * 留到 ±0.10 足够，也避免用户误输入把模型送上天。 */
  var MIN = -0.1;
  var MAX = 0.1;
  var STEP = 0.001;

  /* 通用能力：**任何**带 modelId 的家具都提供离地微调。
   *
   * `modelId` 本身就是"这是自定义模型"的判据 —— 原生家具记录只有 `kind`，
   * 没有 `modelId`。所以这里不需要维护白名单，新模型接入后自动获得该能力。
   * 没有 modelId 的原生家具不会出现这个控件。 */
  function targetFor(item) {
    if (!item || typeof item.modelId !== "string" || !item.modelId) return null;
    return { modelId: item.modelId };
  }

  var stats = {
    version: VERSION,
    polls: 0,
    injections: 0,
    reinjections: 0,
    saves: 0,
    selectedModelId: null,
    currentLift: null,
    lastError: null,
  };
  window.ha3dLiftDebug = stats;

  var project = null;
  var restoring = false;
  var observer = null;
  var observedPanel = null;

  function apiBase() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1];
    return "";
  }

  function snapshot() {
    return window.ha3dProjectSnapshot || null;
  }

  function applyProject(p) {
    if (p && p.floors) project = p;
  }

  function loadProject() {
    var snap = snapshot();
    if (snap) {
      snap.request();
      return;
    }
    fetch(apiBase() + "/api/projects/current", { credentials: "same-origin" })
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

  /* ------------------------- 识别当前选中的记录 ------------------------- */
  function planGroupTransform(g) {
    var t = g && g.getAttribute ? g.getAttribute("transform") : null;
    if (!t) return null;
    var m = /translate\(\s*([-\d.eE+]+)[\s,]+([-\d.eE+]+)\s*\)/.exec(t);
    if (!m) return null;
    var x = parseFloat(m[1]);
    var z = parseFloat(m[2]);
    return isFinite(x) && isFinite(z) ? [x, z] : null;
  }

  function selectedPlanPosition() {
    var svg = document.querySelector("svg.floorplan-canvas");
    if (!svg) return null;
    var groups = svg.querySelectorAll("g.plan-furniture");
    for (var i = 0; i < groups.length; i += 1) {
      if (groups[i].querySelector("rect.furniture-footprint.selected")) {
        return planGroupTransform(groups[i]);
      }
    }
    return null;
  }

  function findRecordAt(pos) {
    if (!project || !project.floors || !pos) return null;
    var tol = 0.01;
    for (var f = 0; f < project.floors.length; f += 1) {
      var items = project.floors[f].furniture || [];
      for (var i = 0; i < items.length; i += 1) {
        var it = items[i];
        if (!it || !it.position) continue;
        if (
          Math.abs(Number(it.position[0]) - pos[0]) < tol &&
          Math.abs(Number(it.position[1]) - pos[1]) < tol
        ) {
          return { item: it, floor: project.floors[f] };
        }
      }
    }
    return null;
  }

  function liftOf(item) {
    var v = item && item[FIELD_KEY];
    return typeof v === "number" && isFinite(v) ? v : 0;
  }

  /* ------------------------------- 写记录 ------------------------------- */
  function saveLift(metres) {
    var pos = selectedPlanPosition();
    if (!pos) return;
    var found = findRecordAt(pos);
    if (!found) {
      stats.lastError = "record not found";
      return;
    }
    var id = found.item.id;
    stats.saves += 1;
    stats.currentLift = metres;

    fetch(apiBase() + "/api/projects/current", { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("load failed " + res.status);
        return res.json();
      })
      .then(function (res) {
        var p = res && (res.project || res);
        if (!p || !p.floors) throw new Error("no project");
        var hit = null;
        p.floors.forEach(function (floor) {
          (floor.furniture || []).forEach(function (it) {
            if (!hit && it && it.id === id) hit = it;
          });
        });
        if (!hit) throw new Error("record not found on save");
        if (Math.abs(metres) < 1e-6) delete hit[FIELD_KEY]; // 0 就不写，保持结构干净
        else hit[FIELD_KEY] = Number(metres.toFixed(4));
        return fetch(apiBase() + "/api/projects/" + p.id, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(p),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("save failed " + res.status);
        var snap = snapshot();
        if (snap) snap.refresh();
        else loadProject();
      })
      .catch(function (err) {
        stats.lastError = String(err);
      });
  }

  /* -------------------------------- UI -------------------------------- */
  function fmt(cm) {
    // 内部按米存，界面上用毫米更直观（用户看到的是 ±100 mm）
    return (cm * 1000).toFixed(0) + " mm";
  }

  function buildRow(target, currentLift) {
    var wrap = document.createElement("div");
    wrap.id = ROW_ID;
    wrap.className = ROW_CLASS;
    wrap.style.cssText =
      "display:flex;flex-direction:column;gap:8px;padding:12px 14px;margin-top:10px;" +
      "border-radius:12px;background:rgba(127,127,127,0.08);";

    var head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:8px;" +
      "font-size:12px;letter-spacing:0.02em;opacity:0.85;";
    var title = document.createElement("span");
    title.textContent = "离地高度";
    var value = document.createElement("span");
    value.textContent = fmt(currentLift);
    value.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.75;";
    head.appendChild(title);
    head.appendChild(value);
    wrap.appendChild(head);

    var controls = document.createElement("div");
    controls.style.cssText = "display:flex;align-items:center;gap:8px;";

    var range = document.createElement("input");
    range.type = "range";
    range.min = String(MIN);
    range.max = String(MAX);
    range.step = String(STEP);
    range.value = String(currentLift);
    range.setAttribute("aria-label", "离地高度微调（毫米）");
    range.style.cssText = "flex:1;accent-color:#409eff;cursor:pointer;";

    var num = document.createElement("input");
    num.type = "number";
    num.min = String(MIN * 1000);
    num.max = String(MAX * 1000);
    num.step = "1";
    num.value = String(Math.round(currentLift * 1000));
    num.setAttribute("aria-label", "离地高度（毫米）");
    num.style.cssText =
      "width:64px;padding:4px 6px;border-radius:6px;font-size:12px;" +
      "border:1px solid rgba(127,127,127,0.45);background:transparent;color:inherit;" +
      "font-variant-numeric:tabular-nums;";

    var reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "归零";
    reset.title = "恢复为 0（模型默认贴地）";
    reset.style.cssText =
      "padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;" +
      "border:1px solid rgba(127,127,127,0.45);background:transparent;color:inherit;";

    function commit(metres) {
      var clamped = Math.max(MIN, Math.min(MAX, metres));
      value.textContent = fmt(clamped);
      saveLift(clamped);
    }

    /* 拖动时只更新显示，松手才写盘，避免每移动一格就 PUT 一次 */
    range.addEventListener("input", function (e) {
      e.stopPropagation();
      var v = parseFloat(range.value);
      if (!isFinite(v)) return;
      value.textContent = fmt(v);
      num.value = String(Math.round(v * 1000));
    });
    range.addEventListener("change", function (e) {
      e.stopPropagation();
      var v = parseFloat(range.value);
      if (isFinite(v)) commit(v);
    });

    num.addEventListener("change", function (e) {
      e.stopPropagation();
      var mm = parseFloat(num.value);
      if (!isFinite(mm)) return;
      var v = Math.max(MIN, Math.min(MAX, mm / 1000));
      range.value = String(v);
      commit(v);
    });
    num.addEventListener("click", function (e) {
      e.stopPropagation();
    });

    reset.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      range.value = "0";
      num.value = "0";
      commit(0);
    });

    controls.appendChild(range);
    controls.appendChild(num);
    controls.appendChild(reset);
    wrap.appendChild(controls);

    var hint = document.createElement("div");
    hint.textContent = "若落地部件看起来陷进地板，调大此值；悬空则调小。";
    hint.style.cssText = "font-size:11px;opacity:0.55;";
    wrap.appendChild(hint);

    return wrap;
  }

  function removeRow() {
    var existing = document.getElementById(ROW_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  function ensureRow() {
    stats.polls += 1;
    try {
      var pos = selectedPlanPosition();
      if (!pos) {
        stats.selectedModelId = null;
        removeRow();
        return;
      }
      var found = findRecordAt(pos);
      if (!found) {
        loadProject(); // 快照可能还没刷新（刚放下模型）
        removeRow();
        return;
      }
      var target = targetFor(found.item);
      stats.selectedModelId = found.item.modelId;
      if (!target) {
        // 原生家具（没有 modelId）不提供离地微调
        removeRow();
        return;
      }
      if (document.getElementById(ROW_ID)) {
        // 已存在且选中的是同一条记录：只同步显示值
        var cur = liftOf(found.item);
        stats.currentLift = cur;
        return;
      }
      stats.injections += 1;
      var row = buildRow(target, liftOf(found.item));
      var host =
        document.querySelector(".selection-summary-card") ||
        document.querySelector(".inspector-panel");
      if (!host) return;
      if (host.classList && host.classList.contains("selection-summary-card")) {
        host.parentNode.insertBefore(row, host.nextSibling);
      } else {
        host.appendChild(row);
      }
      watchInspector();
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  var watchedNode = null;
  function watchInspector() {
    if (!window.MutationObserver) return;
    var panel =
      document.querySelector(".selection-summary-card") ||
      document.querySelector(".inspector-panel");
    if (!panel) return;
    if (watchedNode === panel && observer) return;
    try {
      if (observer) observer.disconnect();
      watchedNode = panel;
      observer = new MutationObserver(function () {
        if (restoring) return;
        if (document.getElementById(ROW_ID)) return;
        restoring = true;
        try {
          ensureRow();
          stats.reinjections += 1;
        } catch (err) {
          stats.lastError = String(err);
        } finally {
          restoring = false;
        }
      });
      observer.observe(panel, { childList: true, subtree: true });
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  function start() {
    var snap = snapshot();
    if (snap) snap.subscribe(applyProject);
    loadProject();
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      if (tick % 30 === 0) loadProject();
      ensureRow();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
