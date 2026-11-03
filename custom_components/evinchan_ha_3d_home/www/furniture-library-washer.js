/*
 * Washing-machine card for the editor's furniture library (运行时补丁).
 *
 * The floor-plan editor's furniture library is hard-coded inside the minified
 * SPA bundle (`FloorplanEditor-*.js`) — its kind list has no washing machine,
 * and an unknown kind crashes the SPA on `vt[kind].label`. Because the
 * integration cannot edit the bundle, this patch re-adds the card at runtime,
 * following the same pattern as furniture-library-fridge.js:
 *
 *   1. poll the DOM for the furniture library grid (`.furniture-library-grid`),
 *   2. inject the card as a CLONE of a native card (identical look, no CSS),
 *   3. on click + plan click, write a furniture record through the SAME
 *      path-aware REST API the SPA itself uses (GET ./api/projects/current,
 *      PUT ./api/projects/{id}),
 *   4. repaint the 2D canvas: door circle + control strip on the footprint,
 *      and the carrier label rewritten to "洗衣机".
 *
 * The record uses the carrier kind "cabinet" + `modelId` "appliance.washer".
 * `cabinet` is the closest carrier: default footprint 1.6 x 0.6 with the same
 * 0.6 depth, and it is a member of the SPA's native-render whitelist, so
 * `appliance-washer.js` must hide the stock cabinet (see its hideStockMeshes).
 *
 * Debug: set `window.HA3D_WASHER_DEBUG = true` and inspect
 * `window.ha3dWasherLibDebug`.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------ constants */
  var MODEL_ID = "appliance.washer";
  var CARRIER_KIND = "cabinet";
  var DIM = { width: 0.6, depth: 0.6, height: 0.85 };
  var LABEL = "洗衣机";
  var BUTTON_ID = "ha3d-washer-library-button";
  var POLL_MS = 500;

  // Bump on every behavioural change: after a reload, read it in the console
  // to prove which build the browser is actually running.
  var VERSION = 2;

  var stats = {
    version: VERSION,
    polls: 0,
    gridFound: false,
    injected: false,
    injections: 0,
    reinjections: 0,
    clicks: 0,
    armed: false,
    planPoints: 0,
    lastError: null,
  };
  window.ha3dWasherLibDebug = stats;
  window.HA3D_WASHER_LIB_FORCE = function () {
    ensureButton();
    return stats;
  };

  function log() {
    if (!window.HA3D_WASHER_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home washer-lib]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------- pictograms */
  /* Front view: rounded body, big door circle, control strip on top. */
  var ICON_SVG =
    '<svg viewBox="0 0 64 64" width="34" height="34" aria-hidden="true">' +
    '<rect x="10" y="8" width="44" height="48" rx="5" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<rect x="14" y="12" width="36" height="7" rx="2.5" fill="currentColor" opacity="0.85"/>' +
    '<circle cx="32" cy="36" r="13" fill="none" stroke="currentColor" stroke-width="3"/>' +
    '<circle cx="32" cy="36" r="7" fill="none" stroke="currentColor" stroke-width="2" opacity="0.75"/>' +
    '<circle cx="32" cy="36" r="2.5" fill="currentColor" opacity="0.8"/>' +
    "</svg>";

  /* ----------------------------------------------------- button injection */
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
      btn.className = "";
    }
    btn.id = BUTTON_ID;
    btn.setAttribute("aria-pressed", "false");
    btn.title = "添加洗衣机（点击后点击画布放置）";
    btn.innerHTML =
      '<span class="furniture-pictogram washer" aria-hidden="true">' + ICON_SVG + "</span>" +
      "<span><strong>" + LABEL + "</strong><small>" +
      DIM.width.toFixed(2) + " × " + DIM.depth.toFixed(2) + " m</small></span>";
    // cloneNode copies no listeners; re-cloned nodes must not stack handlers.
    btn.addEventListener("click", onCardClick);
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

  /* ------------------------------------------------------- library lanes */
  /* furniture-library-fridge.js and furniture-library-dining.js inject their
   * own cards into the SAME React-owned grid. All three patches used to treat
   * "my card is not grid.firstElementChild" as "React wiped it" and re-insert
   * at the front, so each pass pushed the other cards back and they deleted /
   * rebuilt each other in a loop (the 冰箱/洗衣机 alternating flicker).
   *
   * The rule now: a card that is already a child of the grid is never moved or
   * rebuilt, and the insertion point comes from a fixed lane order. */
  var LANE_ORDER = ["ha3d-fridge-library-button", "ha3d-washer-library-button", "ha3d-dining-table-button", "ha3d-dining-chair-button"];

  function laneIndexOf(id) {
    var i = LANE_ORDER.indexOf(id);
    return i < 0 ? LANE_ORDER.length : i;
  }

  // First grid child that belongs after our lane (any non-lane node, then a
  // lane card with a higher lane index).
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

  /* The card must be a real child of `.furniture-library-grid`: that container
   * is `display:grid` with fixed 124 px columns, so only children inherit the
   * native card width/alignment/wrapping. */
  function ensureCardInGrid() {
    var grid = findGrid();
    if (!grid) {
      stats.gridFound = false;
      return null;
    }
    stats.gridFound = true;
    var btn = document.getElementById(BUTTON_ID);
    if (btn && btn.parentNode === grid) {
      stats.injected = true;
      watchGrid(grid);
      return btn;
    }
    if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
    var fresh = makeCard(findNativeCard());
    grid.insertBefore(fresh, insertionPoint(grid));
    stats.injected = true;
    stats.injections += 1;
    watchGrid(grid);
    return fresh;
  }

  /* React removes foreign nodes on every re-render. `childList` mutations are
   * delivered as a microtask, so re-inserting there closes the gap before the
   * browser can dispatch a click to whatever React rendered in our place.
   * Only OUR node leaving the grid counts — sibling patches insert cards into
   * the same container all the time. */
  var observedGrid = null;
  var observer = null;
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
        if (!removedUs) return;
        if (restoring) return;
        restoring = true;
        try {
          ensureCardInGrid();
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

  function ensureButton() {
    stats.polls += 1;
    try {
      ensureCardInGrid();
    } catch (err) {
      stats.lastError = String(err);
      /* never break the editor */
    }
  }

  /* ----------------------------------- two-step placement (native-like) */
  function setArmed(on) {
    stats.armed = on;
    var btn = document.getElementById(BUTTON_ID);
    if (btn) {
      if (on) btn.classList.add("active");
      else btn.classList.remove("active");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function onCardClick() {
    setArmed(!stats.armed);
    if (stats.armed) disarmNativeCards();
    log("washer placement armed:", stats.armed);
  }

  function nativeLibraryCards() {
    var all = document.querySelectorAll(".furniture-library-grid > button, [class*='furniture-library'] button");
    return Array.prototype.filter.call(all, function (b) {
      return b.id !== BUTTON_ID;
    });
  }

  function disarmNativeCards() {
    try {
      nativeLibraryCards().forEach(function (b) {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
    } catch (err) {
      /* ignore */
    }
  }

  function installDisarmGuards() {
    document.addEventListener(
      "keydown",
      function (e) {
        if (stats.armed && (e.key === "Escape" || e.keyCode === 27)) setArmed(false);
      },
      true
    );
    // Selecting a native card hands placement back to the SPA.
    document.addEventListener(
      "click",
      function (e) {
        if (!stats.armed) return;
        var target = e.target;
        if (!target || !target.closest) return;
        if (target.closest("#" + BUTTON_ID)) return;
        var card = target.closest("button");
        if (!card || !card.querySelector(".furniture-pictogram")) return;
        setArmed(false);
      },
      true
    );
  }

  /* Screen -> plan metres. The canvas viewBox is in metres, so the inverse CTM
   * gives plan coordinates; the bounding-rect path is a fallback so placement
   * never silently fails. */
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
    } catch (err) {
      /* fall through */
    }
    try {
      var box = svg.getBoundingClientRect();
      var vb = svg.viewBox && svg.viewBox.baseVal;
      if (!box.width || !box.height || !vb || !vb.width || !vb.height) return null;
      var rx = (e.clientX - box.left) / box.width;
      var ry = (e.clientY - box.top) / box.height;
      return [vb.x + rx * vb.width, vb.y + ry * vb.height];
    } catch (err2) {
      stats.lastError = String(err2);
      return null;
    }
  }

  /* Interceptors are registered on WINDOW in the CAPTURE phase: the SPA's own
   * placement handler also lives on `window`, and window-capture runs first.
   *
   * The trailing mouseup/click of a placement gesture must not leak to the SPA
   * (it would drop its armed kind and overwrite our record with a whole
   * project PUT), but the old implementation blocked the canvas for a full
   * 1000 ms afterwards, and `click` is not guaranteed while the SVG capture
   * handler returns early — so the next click was eaten and the item looked
   * like it "landed about a second late". The lock is now scoped to the exact
   * gesture that placed the item. */
  var placedPointerId = null;
  var placedByMouse = false;

  /* ⚠️ 手势必须整体封堵（skill §2.3）：一次画布点击连发
   * pointerdown → pointerup → click。旧实现只在 down 落模型，随后
   * setArmed(false) 让 up/click 畅通交给 SPA，SPA 的 window 捕获 click 处理器
   * 会再放出它自己 armed 的 kind（沙发）并 PUT 覆盖刚写入的记录。
   * 旧判定用 placedPointerId/placedByMouse 看似封堵，但 click 事件没有
   * pointerId，回落到 placedByMouse（pointer 手势下恒为 false）→ click 从不被拦。
   *
   * 用「手势序号」而不是 1 秒布尔：固定计时会让下一次点击被吞掉
   * （冰箱补丁踩过：点了差不多一秒才落到画布上）。序号方案只封堵本次手势
   * 派生的 up/click，click 一到立即解锁，下一次点击照常通行。 */
  /* -1 表示"没有任何手势被锁"。若用 0 当初始值，由于 gestureSerial 也从 0 开始，
   * 页面刚加载时 blockingSerial === gestureSerial 会成立，导致**第一次点击就被
   * 当成"上一个放置手势的尾巴"封掉** —— 家具彻底点不动。 */
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
    placedPointerId = e.type === "pointerdown" ? e.pointerId : null;
    placedByMouse = e.type !== "pointerdown";
    gestureSerial += 1;
    blockingSerial = gestureSerial;
    stats.clicks += 1;
    var pos = planPointFromEvent(e);
    if (pos) addWasherAt(pos);
    // One-shot placement, like a native card.
    setArmed(false);
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

  /* --------------------------------------------------- add on click */
  function apiUrl(path) {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1] + path;
    return "." + path;
  }

  function addWasherAt(pos) {
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
          id: "furniture-washer-" + Date.now(),
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
        log("washer added at", pos);
        var snapAfter = snapshot();
        if (snapAfter) snapAfter.refresh();
        // 放置后自动选中，弹出属性卡片（与原生家具一致）
        if (window.ha3dSelectAfterPlace) window.ha3dSelectAfterPlace(pos);
        setArmed(false); // one-shot placement
        refreshPlanPoints();
        window.setTimeout(function () {
          paintFootprints();
          relabelFootprints();
          relabelInspectorTitle();
        }, 400);
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("add washer failed", err);
      });
  }

  /* ------------------------------------------------- 2D identification */
  /* Never identify by size: the editor lets the user resize, and a size match
   * silently stops working after that. Records are read from the API and
   * matched to the rendered groups by PLAN POSITION, which is exactly the
   * `translate(x z)` of <g class="plan-furniture">. */
  var planPoints = [];

  /* 从共享快照里算出本补丁的记录坐标。快照层保证"同一时刻只有一个
   * /api/projects/current 在途"，各补丁不再各拉一份完整项目。 */
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

  function washerFootprintGroups() {
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
      var groups = washerFootprintGroups();
      for (var i = 0; i < groups.length; i += 1) {
        var label = groups[i].querySelector("text.furniture-label");
        if (label && label.textContent !== LABEL) label.textContent = LABEL;
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* ---------------------------------------------------- 2D footprint mark */
  /* Front view of the machine drawn inside the square footprint: the door
   * circle plus the control strip, so the 2D plan reads "washing machine"
   * rather than the carrier's generic cabinet rectangle. */
  var SVG_NS = "http://www.w3.org/2000/svg";

  function paintFootprints() {
    try {
      var groups = washerFootprintGroups();
      for (var i = 0; i < groups.length; i += 1) {
        var g = groups[i];
        var rect = g.querySelector("rect.furniture-footprint");
        if (!rect) continue;
        if (g.querySelector(".washer-door-mark")) continue;
        rect.style.fill = "none";
        // `fill:none` makes the rect hit-test transparent by default; force it
        // to keep receiving pointer events so the item stays selectable.
        rect.style.pointerEvents = "all";

        var w = parseFloat(rect.getAttribute("width")) || DIM.width;
        var h = parseFloat(rect.getAttribute("height")) || DIM.depth;
        // The machine's front faces the -Z edge of the footprint (the plan's
        // "up" side), so the door circle sits toward that edge.
        var doorR = Math.min(w, h) * 0.36;
        var doorCy = h * 0.1;

        var door = document.createElementNS(SVG_NS, "circle");
        door.setAttribute("class", "washer-door-mark");
        door.setAttribute("cx", "0");
        door.setAttribute("cy", String(doorCy));
        door.setAttribute("r", String(doorR));
        door.setAttribute("fill", "none");
        door.setAttribute("stroke", "#b9bec4");
        door.setAttribute("stroke-width", "0.012");
        door.setAttribute("pointer-events", "none");
        g.insertBefore(door, rect.nextSibling);

        var inner = document.createElementNS(SVG_NS, "circle");
        inner.setAttribute("class", "washer-door-inner");
        inner.setAttribute("cx", "0");
        inner.setAttribute("cy", String(doorCy));
        inner.setAttribute("r", String(doorR * 0.55));
        inner.setAttribute("fill", "none");
        inner.setAttribute("stroke", "#8f959b");
        inner.setAttribute("stroke-width", "0.008");
        inner.setAttribute("pointer-events", "none");
        g.insertBefore(inner, rect.nextSibling);

        var strip = document.createElementNS(SVG_NS, "rect");
        strip.setAttribute("class", "washer-panel-mark");
        strip.setAttribute("x", String(-w * 0.42));
        strip.setAttribute("y", String(-h / 2 + h * 0.06));
        strip.setAttribute("width", String(w * 0.84));
        strip.setAttribute("height", String(h * 0.055));
        strip.setAttribute("rx", String(h * 0.02));
        strip.setAttribute("fill", "#8f959b");
        strip.setAttribute("opacity", "0.55");
        strip.setAttribute("pointer-events", "none");
        g.insertBefore(strip, rect.nextSibling);
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* The inspector title is `vt[selected.kind].label` ("橱柜") and React
   * re-renders it on every update, so it is patched after each paint. */
  function relabelInspectorTitle() {
    try {
      var groups = washerFootprintGroups();
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
      if (small && /家具/.test(small.textContent) && /橱柜/.test(small.textContent)) {
        small.textContent = small.textContent.replace(/橱柜/g, LABEL);
      }
      var headings = document.querySelectorAll(".selection-summary-heading strong");
      for (var hi = 0; hi < headings.length; hi += 1) {
        if (headings[hi].textContent === "橱柜") headings[hi].textContent = LABEL;
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* -------------------------------------------------- self-heal old data */
  /* Prototype builds could write a bare cabinet with no modelId, which renders
   * as a plain cabinet. Rewrite only records that are unmistakably ours. */
  function repairRecords() {
    fetch(apiUrl("/api/projects/current"), { credentials: "same-origin" })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (res) {
        var project = res && (res.project || res);
        if (!project || !project.floors) return;
        var changed = 0;
        project.floors.forEach(function (floor) {
          (floor.furniture || []).forEach(function (item) {
            if (!item || item.kind !== CARRIER_KIND) return;
            if (item.modelId) return;
            if (Math.abs(item.width - DIM.width) < 0.02 && Math.abs(item.depth - DIM.depth) < 0.02) {
              item.modelId = MODEL_ID;
              changed += 1;
            }
          });
        });
        if (!changed) return;
        return fetch(apiUrl("/api/projects/" + project.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(project),
        }).then(function (res2) {
          if (!res2.ok) throw new Error("repair save failed " + res2.status);
          stats.repaired = changed;
        });
      })
      .catch(function (err) {
        stats.lastError = String(err);
      });
  }

  /* ----------------------------------------------------------- boot */
  function start() {
    repairRecords();
    // 订阅共享快照：有缓存时立即回调一次，之后每次刷新都会再次回调
    var snap = snapshot();
    if (snap) snap.subscribe(applyProject);
    refreshPlanPoints();
    installPlacementInterceptor();
    installDisarmGuards();
    ensureButton();
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      if (tick % 30 === 0) refreshPlanPoints();
      ensureButton();
      relabelFootprints();
      paintFootprints();
      relabelInspectorTitle();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
