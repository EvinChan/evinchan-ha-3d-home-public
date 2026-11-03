/*
 * 子母茶几卡片（furniture-library 运行时补丁）。
 *
 * 与 furniture-library-sofa.js 同构：载体 kind 是 `coffee_table`，
 * SPA 目录里 label 本来就是"茶几"，属性卡片无需结构改写，这里只做：
 *   1. 往 `.furniture-library-grid` 注入一张"子母茶几"卡片（克隆原生卡片，
 *      MutationObserver 抢回 + 轮询兜底，lane 排序与既有补丁共存）；
 *   2. 点卡片 → 画布点击 → 经 REST 写入一条 kind "coffee_table" +
 *      modelId "furniture.nested_coffee_tables" 的家具记录（两步放置，一次性）；
 *   3. 2D 足迹：方形足迹上叠加"大圆 + 小圆"轮廓（按 modelId + 平面坐标
 *      识别，绝不用尺寸），并把标签改写为「子母茶几」。
 *
 * 3D 模型由 furniture-nested-coffee-table.js 渲染（含对原生 coffee_table
 * 的三层隐藏）。双台面颜色由 inspector-surface-color.js 提供。
 *
 * Debug: window.HA3D_NESTED_LIB_DEBUG = true → window.ha3dNestedLibDebug
 */
(function () {
  "use strict";

  var MODEL_ID = "furniture.nested_coffee_tables";
  var CARRIER_KIND = "coffee_table"; // SPA 白名单 kind，label 即"茶几"
  var DIM = { width: 1.25, depth: 0.8, height: 0.45 };
  var LABEL = "子母茶几";
  var BUTTON_ID = "ha3d-nested-coffee-table-button";
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
  window.ha3dNestedLibDebug = stats;

  function log() {
    if (!window.HA3D_NESTED_LIB_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home nested-lib]"].concat([].slice.call(arguments)));
    } catch (e) {}
  }

  /* 跨补丁 armed 协调器：任一库卡片武装时，强制解除其它库补丁（沙发/餐桌等）
   * 的内部 armed 状态。仅靠卡片点击 guard 操作 DOM/CSS 不够可靠——若某补丁
   * armed 未被及时解除，其 window 捕获阶段注册的 handleDown 会先抢下画布点击、
   * stopImmediatePropagation 后只放出自家模型（沙发），导致点子母茶几却出沙发。 */
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

  /* 卡片图标：一大一小两个圆（子母茶几俯视剪影） */
  var ICON_SVG =
    '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true">' +
    '<circle cx="38" cy="38" r="18" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<circle cx="38" cy="38" r="13" fill="none" stroke="currentColor" stroke-width="2" opacity="0.55"/>' +
    '<circle cx="19" cy="21" r="11" fill="none" stroke="currentColor" stroke-width="3"/>' +
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
    btn.title = "添加子母茶几（点击后点击画布放置）";
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
    if (existing && existing.parentNode === grid) return; // 已在网格内：不动
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
  var placedPointerId = null;
  var placedByMouse = false;

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

  /* 拦截必须在 window 捕获阶段：SPA 自己的放置监听挂在 window 上。
   *
   * ⚠️ 这是本链路最隐蔽的坑（skill §2.3）：
   * 一次画布点击会连发 pointerdown → pointerup → click。若只在 down 时落模型、
   * 后续 up/click 就"解除武装直接放行"，SPA 挂在 window 上的 click 处理器会
   * 再放出**它自己 armed 的 kind**（通常就是上次点过的沙发），并用整份内存项目
   * PUT 覆盖掉我们刚写入的记录。表象 = 「点子母茶几却落下沙发」。
   *
   * 所以用「手势序号」把**本次手势的剩余事件**挡死。
   * 用序号而不是 1 秒布尔：固定计时会让下一次点击被吞掉
   * （冰箱补丁踩过：点了差不多一秒才落到画布上）。序号方案只封堵本次
   * 手势派生的 up/click，click 一到立即解锁，下一次点击照常通行。 */
  /* -1 表示"没有任何手势被锁"。若用 0 当初始值，由于 gestureSerial 也从 0 开始，
   * 页面刚加载时 blockingSerial === gestureSerial 会成立，导致**第一次点击就被
   * 当成"上一个放置手势的尾巴"封掉** —— 家具彻底点不动。 */
  var gestureSerial = 0;
  var blockingSerial = -1;

  function handleDown(e) {
    if (!stats.armed) return;
    var t = e.target;
    if (t && t.closest) {
      // 画布外的按下：解除武装，但让事件正常流动（工具栏/面板要能响应）
      if (!t.closest("svg.floorplan-canvas")) {
        if (!t.closest("#" + BUTTON_ID)) setArmed(false);
        return;
      }
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    placedPointerId = e.type === "pointerdown" ? e.pointerId : null;
    placedByMouse = e.type !== "pointerdown";
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
    /* 只在 click 解锁：up 也必须挡住（否则 click 会漏给 SPA，skill §2.3）。
     * 若浏览器不发 click，残留的锁由下一次 pointerdown 清理（见 handleDown）。 */
    if (type === "click") {
      blockingSerial = -1;
      placedPointerId = null;
      placedByMouse = false;
    }
  }

  /* ------------------------------------- 未选中时禁止拖拽（只允许选中）
   * SPA 的 pointerdown 处理是「先选中、再 st() 启动拖拽」，所以原生家具一点
   * 就跟着鼠标跑。用户期望补丁模型：第一次点击只选中（蓝色高亮），已选中后
   * 才能拖动。
   *
   * ⚠️ 绝不能在 pointerdown 上 stopPropagation：SPA 的选中本身就挂在
   * pointerdown/click 链上，一旦在 window 捕获阶段掐断，家具就**彻底点不动**。
   * 正确做法：down 照常放行（让 SPA 完成选中），只把**移动**掐掉。 */
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
    /* 新手指按下即代表上一个手势已结束。若上一次放置没等到 click
     * （pointerdown 被 preventDefault 后浏览器可能根本不发 click），
     * blockingSerial 会残留并把后续 up/click 一起挡死。 */
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
    /* 移动拦截单独注册在捕获阶段，且只在本次按下判定为"未选中"时生效。 */
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
          id: "furniture-nested-coffee-" + Date.now(),
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
        log("nested coffee table added at", pos);
        // 写操作后立即作废并刷新共享快照，新记录马上能被 2D 文案识别
        var snap = snapshot();
        if (snap) snap.refresh();
        // 放置后自动选中，弹出属性卡片（与原生家具一致）
        if (window.ha3dSelectAfterPlace) window.ha3dSelectAfterPlace(pos);
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("add failed", err);
      });
  }

  /* ------------------------------------------------- 2D / 属性卡片文案改写
   * 载体 kind 是原生 "coffee_table"，SPA 会把标签渲染成「茶几」。按 modelId +
   * 平面坐标识别我们的记录（绝不用尺寸），把三处改写为「子母茶几」，
   * 并在方形足迹上叠加大小双圆轮廓。 */
  var planPoints = [];
  var OVERLAY_CLASS = "ha3d-nested-footprint-overlay";

  /* 从共享快照里算出本补丁的记录坐标。快照层保证了"同一时刻只有一个
   * /api/projects/current 在途"，多个补丁不再各拉一份完整项目。 */
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
    /* 兜底：共享层没加载时退回自己拉（单补丁场景）。 */
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

  function footprintGroups() {
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

  /* 双圆轮廓：与 3D 模型完全同构。
   *
   * 足迹中心 = 记录 position = **包围盒中心**，不是大茶几圆心。3D 模型为此
   * 把整组回移了半个 X 跨度（CENTER_X_OFFSET = 0.225），2D 轮廓必须做同样的
   * 平移，否则圆会整体偏向一侧、和 3D 对不上。
   *
   * 填充透明 + pointer-events:none：不挡选中原足迹，也不挡点击。 */
  function ensureOverlay(group) {
    var rect = group.querySelector("rect.furniture-footprint");
    if (!rect) return;
    var w = Math.abs(parseFloat(rect.getAttribute("width"))) || DIM.width;
    var h = Math.abs(parseFloat(rect.getAttribute("height"))) || DIM.depth;
    var bigR = 0.4;
    var smallR = 0.3;
    var smallOffset = 0.55; // 与 3D 模型 DIM.small.offset 一致
    /* 与 3D 的 CENTER_X_OFFSET 同一个公式：足迹中心 → 大茶几圆心 */
    var centreDx = -(smallOffset + smallR - bigR) / 2; // -0.225
    var big = group.querySelector("circle." + OVERLAY_CLASS + "-big");
    if (!big) {
      big = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      big.setAttribute("class", OVERLAY_CLASS + "-big");
      big.setAttribute("fill", "none");
      big.setAttribute("stroke", "currentColor");
      big.setAttribute("stroke-width", "0.035");
      big.setAttribute("pointer-events", "none");
      group.appendChild(big);
    }
    big.setAttribute("cx", String(centreDx));
    big.setAttribute("cy", "0");
    big.setAttribute("r", String(bigR));
    var small = group.querySelector("circle." + OVERLAY_CLASS + "-small");
    if (!small) {
      small = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      small.setAttribute("class", OVERLAY_CLASS + "-small");
      small.setAttribute("fill", "none");
      small.setAttribute("stroke", "currentColor");
      small.setAttribute("stroke-width", "0.03");
      small.setAttribute("stroke-dasharray", "0.12 0.08");
      small.setAttribute("pointer-events", "none");
      group.appendChild(small);
    }
    /* 小茶几圆心 = 大茶几圆心 + smallOffset（沿本地 x），同样带中心补偿。
     * 尺寸被用户改大时回退到负方向，保证圆仍在足迹内。 */
    var sx = smallOffset + smallR <= w / 2 ? centreDx + smallOffset : centreDx - smallOffset;
    small.setAttribute("cx", String(sx));
    small.setAttribute("cy", "0");
    var sr = smallR;
    if (h / 2 < sr) sr = Math.max(0.1, h / 2 - 0.02);
    small.setAttribute("r", String(sr));
  }

  function relabelFootprints() {
    try {
      var groups = footprintGroups();
      for (var i = 0; i < groups.length; i += 1) {
        var label = groups[i].querySelector("text.furniture-label");
        if (label && label.textContent !== LABEL) label.textContent = LABEL;
        ensureOverlay(groups[i]);
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* 属性卡片标题由 React 按 vt[kind].label 渲染并反复重建，每轮 tick 重写。 */
  function relabelInspectorTitle() {
    try {
      var groups = footprintGroups();
      var selected = false;
      for (var i = 0; i < groups.length; i += 1) {
        if (groups[i].querySelector("rect.furniture-footprint.selected")) {
          selected = true;
          break;
        }
      }
      if (!selected) return;
      var h2 = document.querySelector(".inspector-title h2");
      if (h2 && h2.textContent !== LABEL) h2.textContent = LABEL;
      var small = document.querySelector(".inspector-title small");
      if (small && /茶几/.test(small.textContent) && !/子母茶几/.test(small.textContent)) {
        small.textContent = small.textContent.replace(/茶几/g, LABEL);
      }
      var headings = document.querySelectorAll(".selection-summary-heading strong");
      for (var hi = 0; hi < headings.length; hi += 1) {
        if (headings[hi].textContent === "茶几") headings[hi].textContent = LABEL;
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
    // 订阅共享快照：有缓存时立即回调一次，之后每次刷新都会再次回调
    var snap = snapshot();
    if (snap) snap.subscribe(applyProject);
    refreshPlanPoints();
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      // 共享层自带 15s 节流与在途合并，这里只做低成本触发
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
