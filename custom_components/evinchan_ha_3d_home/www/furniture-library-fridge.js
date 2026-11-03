/*
 * Fridge button for the editor's furniture library (运行时补丁).
 *
 * The floor-plan editor's furniture library is hard-coded inside the minified
 * SPA bundle (`FloorplanEditor-*.js`) — its kind list does NOT contain
 * "fridge". Because the integration cannot edit the bundle, this patch
 * re-adds the "冰箱" card at runtime, following the same pattern as the other
 * runtime patches (appliance-fridge.js, room-panel.js, ...):
 *
 *   1. poll the DOM for the furniture library grid (`.furniture-library-grid`,
 *      with a fallback that locates any native library button's parent),
 *   2. inject a "冰箱" <button> that matches the native cards,
 *   3. on click + plan click, write a furniture record into the current
 *      floor-plan project through the SAME relative REST API the SPA itself
 *      uses ("./api/projects/current" then PUT "./api/projects/{id}") —
 *      document-relative, so it works no matter which path the panel is
 *      mounted under (e.g. /evinchan-3d-home or /api/evinchan_ha_3d_home).
 *
 * The record uses the carrier kind "cabinet" + modelId "appliance.fridge"
 * (see CARRIER_KIND below for why). After the PUT, the backend broadcasts
 * `project.updated`; the SPA re-renders the 2D footprint, this patch paints
 * the fridge pictogram + "冰箱" label on it, and `appliance-fridge.js` swaps in
 * the procedural 3D fridge by matching kind or modelId.
 *
 * Debug: set `window.HA3D_FRIDGE_DEBUG = true` (before or after load) and
 * inspect `window.ha3dFridgeLibDebug`.
 */
(function () {
  "use strict";

  // Mirrors schema.py `_FURNITURE_FALLBACK["fridge"] = (0.822, 0.6, 1.91)`.
  var DIM = { width: 0.822, depth: 0.6, height: 1.91 };
  var BUTTON_ID = "ha3d-fridge-library-button";
  var POLL_MS = 500;
  /* The SPA's internal furniture catalog (vt = {sofa:{label...}, ...}) is
   * hard-coded and has NO "fridge" entry — a furniture record with
   * kind:"fridge" makes the SPA crash (`vt[kind].label` of undefined, black
   * screen). So the card writes a KNOWN carrier kind ("cabinet") carrying
   * modelId "appliance.fridge"; `appliance-fridge.js` matches furniture by
   * that modelId and renders the 3D fridge. */
  var CARRIER_KIND = "cabinet";
  var MODEL_ID = "appliance.fridge";

  // Bump on every behavioural change: after a reload, read it in the console to
  // prove which build the browser is actually running (stale iframe caches made
  // earlier debugging ambiguous).
  var VERSION = 22;

  var stats = {
    version: VERSION,
    polls: 0,
    gridFound: false,
    injected: false,
    hostVia: null, // "grid" | "card" | "text"
    hostClass: null,
    nativeCards: 0,
    injections: 0,
    reinjections: 0,
    clicks: 0,
    armed: false,
    lastError: null,
  };
  window.ha3dFridgeLibDebug = stats;
  // Manual trigger for debugging in the console.
  window.HA3D_FRIDGE_LIB_FORCE = function () {
    ensureButton();
    return stats;
  };

  function log() {
    if (!window.HA3D_FRIDGE_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home fridge-lib]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /* ----------------------------------------------------- button injection */
  // The icon is the user-supplied fridge glyph; fills use currentColor so the
  // icon follows the card's ink colour like the native pictograms do.
  var ICON_SVG =
    '<svg viewBox="0 0 1024 1024" width="34" height="34" version="1.1" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M750.1 465.3m6.8 0l8.2 0q6.8 0 6.8 6.8l0 358.2q0 6.8-6.8 6.8l-8.2 0q-6.8 0-6.8-6.8l0-358.2q0-6.8 6.8-6.8Z"></path>' +
    '<path fill="currentColor" d="M283.7 356.2h-20.1c-6.8 0-14.4-5-14.4-11.8V141.9c0-6.8 7.6-13.7 14.4-13.7h20.1c6.8 0 14.8 6.9 14.8 13.7v202.6c0 6.8-8 11.8-14.8 11.8zM282.1 147.4a5.2 5.2 0 0 0-5.1-4.3h-6.7a4.8 4.8 0 0 0-4.6 4.3v188.9a5.6 5.6 0 0 0 4.7 5.1h6.7a6 6 0 0 0 5-5.1V147.4z"></path>' +
    '<path fill="currentColor" d="M283.7 692.9h-20.1c-6.8 0-14.4-5-14.4-11.8V478.6c0-6.8 7.6-13.7 14.4-13.7h20.1c6.8 0 14.8 6.9 14.8 13.7v202.6c0 6.8-8 11.8-14.8 11.8zM282.1 484.1a5.2 5.2 0 0 0-5.1-4.3h-6.7a4.8 4.8 0 0 0-4.6 4.3v188.9a5.6 5.6 0 0 0 4.7 5.1h6.7a6 6 0 0 0 5-5.1V484.1z"></path>' +
    '<path fill="currentColor" d="M780.3 968.5H243.7c-22.7 0-52-29.3-52-52V100.8c0-22.7 29.3-52 52-52h536.5c22.7 0 52 29.3 52 52v815.7c0 22.7-29.3 52-52 52z m-515.9-24.6h495.3c20.9 0 48-27.8 48-49.2V416.2H218.4a6.8 6.8 0 0 1-2.1-0.4v479.4c0 21.5 27.1 49.2 48.1 49.2zM759.6 73.5H264.4c-20.9 0-48 27.8-48 49.2V391.3a6.8 6.8 0 0 1 2.1-0.4H807.6V122.7c0-21.5-27.1-49.2-48-49.2z"></path>' +
    '<path fill="currentColor" d="M750.1 177.5v-24.6c0-3 3.3-4.9 10.1-4.9s11.8 1.9 11.8 4.9v24.6h-21.9z m21.9 19.2v158.8c0 3-4.9 5.8-11.8 5.8s-10.1-2.8-10.1-5.8V196.6h21.9z"></path>' +
    "</svg>";

  /* The card is a CLONE of a native furniture card, inserted as the FIRST
   * child of `.furniture-library-grid`.
   *
   * Being inside the grid matters: the grid is `display:grid` with
   * `grid-template-columns: 124px 124px`, so only real children get the
   * native card's width, alignment, wrapping and scroll behaviour. A floating
   * body-level card looked detached from the list and did not participate in
   * the layout.
   *
   * The hard part is React: the grid is a React-managed container and React
   * removes foreign nodes when it re-renders the list, which previously made
   * the card flicker away every 500 ms. That wipe is also what let a click
   * land on the native card underneath and arm the sofa. So:
   *
   *   - the node is CLONED from a native card, inheriting its classes and
   *     structure (identical look, zero custom CSS for the resting state);
   *   - a MutationObserver on the grid re-inserts it synchronously the moment
   *     React removes it, so the gap is a single microtask, not a full poll
   *     interval — the user can never click "through" a missing card;
   *   - the poll remains as a backstop for a grid that is replaced wholesale. */

  /* Build the card by CLONING a native furniture card: the clone inherits
   * whatever classes/structure the SPA's cards use, so it is styled exactly
   * like them (the native cards have an empty class attribute and are laid
   * out by the grid itself). Falls back to a from-scratch button. */
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
    btn.title = "添加冰箱（点击后点击画布放置）";
    btn.innerHTML =
      '<span class="furniture-pictogram fridge" aria-hidden="true">' + ICON_SVG + "</span>" +
      "<span><strong>冰箱</strong><small>" +
      DIM.width.toFixed(2) + " × " + DIM.depth.toFixed(1) + " m</small></span>";
    // The clone is inert markup; wire the handler once (cloneNode copies no
    // listeners, and re-adding a listener to a re-cloned node would stack).
    btn.addEventListener("click", onCardClick);
    if (placementArmed) {
      btn.classList.add("active");
      btn.setAttribute("aria-pressed", "true");
    }
    return btn;
  }

  function applyCardState() {
    var btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    // Native cards express selection with the `active` class; reuse it so the
    // armed state looks exactly like an armed native card.
    if (placementArmed) btn.classList.add("active");
    else btn.classList.remove("active");
    btn.setAttribute("aria-pressed", placementArmed ? "true" : "false");
  }

  /* ------------------------------------------------------- library lanes */
  /* Several patches inject their own card into the SAME React-owned grid
   * (.furniture-library-grid): this file (fridge), furniture-library-washer.js
   * and furniture-library-dining.js.
   *
   * Every one of them used to read "my card is not the grid's first child" as
   * "React wiped it" and then re-cloned + re-inserted it at the FRONT. With two
   * patches loaded, each pass pushed the other card back and the one sitting in
   * front took over grid.firstElementChild — so the two cards deleted and
   * rebuilt each other in a loop at the poll interval ("冰箱/洗衣机交替闪烁").
   *
   * The fix is a fixed lane order plus a strict ownership rule:
   *   - a card that is already a child of the grid is NEVER moved or rebuilt;
   *   - the insertion point is computed from the lane index only, so the card's
   *     position is stable no matter which patch ran last.
   * `#ha3d-fridge-library-button` < `#ha3d-washer...` < `#ha3d-dining-*`. */
  var LANE_ORDER = ["ha3d-fridge-library-button", "ha3d-washer-library-button", "ha3d-dining-table-button", "ha3d-dining-chair-button"];

  function laneIndexOf(id) {
    var i = LANE_ORDER.indexOf(id);
    return i < 0 ? LANE_ORDER.length : i;
  }

  // First grid child that belongs AFTER our lane. A foreign lane card that is
  // still earlier than its own slot must not block us, hence the comparison on
  // lane index instead of on "is it a lane card at all".
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

  function isVisible(el) {
    try {
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (e) {
      return true;
    }
  }

  // A native furniture card = a <button> containing a furniture pictogram.
  function findNativeCard() {
    var pics = document.querySelectorAll(".furniture-pictogram");
    for (var i = 0; i < pics.length; i += 1) {
      var card = pics[i].closest ? pics[i].closest("button") : null;
      if (card && card.id !== BUTTON_ID) return card;
    }
    return null;
  }

  // The grid the card belongs in: the visible one whenever possible.
  function findGrid() {
    var grids = document.querySelectorAll(".furniture-library-grid");
    var fallback = null;
    for (var i = 0; i < grids.length; i += 1) {
      if (isVisible(grids[i])) return grids[i];
      if (!fallback) fallback = grids[i];
    }
    return fallback;
  }

  /* Insert (or re-insert) the card at its lane position in the grid.
   * Returns the live button, or null when the grid does not exist. */
  function ensureCardInGrid() {
    var grid = findGrid();
    var btn = document.getElementById(BUTTON_ID);
    if (!grid) {
      stats.gridFound = false;
      return null;
    }
    stats.gridFound = true;
    stats.nativeCards = grid.querySelectorAll(".furniture-pictogram").length;
    /* Already inside the grid: leave it exactly where it is. Rebuilding or
     * re-inserting a card that is already in place is what made two library
     * patches fight over grid.firstElementChild (see CARD_LANE). */
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

  /* Re-insert the card the instant React removes it.
   *
   * `childList` mutations are delivered as a microtask right after the
   * mutation, so the card comes back within the same task — before the
   * browser can dispatch a click to whatever React rendered in its place.
   * This is what makes "click the card" reliable, unlike the old poll-only
   * approach where the card could be missing for up to 500 ms.
   *
   * The trigger is the narrowest possible one: OUR OWN node leaving the grid.
   * Any childList mutation counted as "we were removed" before, so the sibling
   * library patches' insertions re-triggered this observer on every pass. */
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
      // A grid that appears only later (view/floor switch) is caught by the
      // poll: ensureCardInGrid moves the card into it and re-targets the
      // observer, because the old grid no longer contains the card.
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* Poll backstop: the grid can be torn down and rebuilt (view switch, floor
   * change), which disconnects the observer target. A card that is already in
   * the live grid is left completely untouched — no re-clone, no re-insert —
   * so two co-existing library patches can no longer rebuild each other. */
  function ensureButton() {
    stats.polls += 1;
    try {
      ensureCardInGrid();
    } catch (err) {
      stats.lastError = String(err);
      /* never break the editor */
    }
  }

  /* ------------------------------------- two-step placement (native-like) */
  // The SPA's library cards work in two steps: click a card to arm the kind,
  // then click the plan to drop it. Our card mirrors that: clicking arms
  // fridge placement; the next pointerdown on `svg.floorplan-canvas` is
  // intercepted in the CAPTURE phase (so the SPA never sees it and will not
  // drop the sofa it still has armed), converted from screen to plan metres
  // through the SVG's CTM (its user units are metres — the footprint rects
  // use x=-width/2 etc.), and a fridge record is written at that position.

  var placementArmed = false;

  function setArmedVisual(on) {
    // The card carries its own inline styles (it lives on document.body, not
    // inside the SPA's stylesheet scope), so the armed state restyles it
    // directly instead of toggling a class.
    applyCardState();
  }

  function setArmed(on) {
    placementArmed = on;
    stats.armed = on;
    setArmedVisual(on);
  }

  function onCardClick() {
    setArmed(!placementArmed);
    if (placementArmed) {
      // Visually deselect the native card the SPA keeps armed (sofa by
      // default) so only one card looks selected. React may restore the class
      // on its next render — harmless, our interception still works.
      disarmNativeCards();
    }
    log("fridge placement armed:", placementArmed);
  }

  /* Escape always cancels an armed placement. The "click outside the plan
   * disarms" rule lives in handleDown (window capture) so it runs before the
   * SPA reacts, in the same pass that decides whether to intercept. */
  function installDisarmGuards() {
    document.addEventListener(
      "keydown",
      function (e) {
        if (placementArmed && (e.key === "Escape" || e.keyCode === 27)) {
          setArmed(false);
          log("fridge placement disarmed (Escape)");
        }
      },
      true
    );
  }

  /* ------------------------------------ 2D label override ---------- */
  /* The SPA renders our fridge footprint with the CARRIER kind, so both the
   * on-canvas <text class="furniture-label"> and the inspector title read
   * "橱柜". The catalog (`vt`) inside the bundle cannot be extended (an
   * unknown kind crashes on `vt[kind].label`), so the rendered text is
   * corrected after each paint.
   *
   * IDENTIFICATION MUST NOT USE SIZE. The editor lets the user resize the
   * item, so a fridge can be 1.00 × 0.60 m or anything else; the old
   * size-match (0.822 × 0.60) silently stopped matching after a resize and
   * the card fell back to "橱柜" — exactly the reported bug. Instead the
   * fridge records are read from the project (`modelId === MODEL_ID`) and
   * matched to the rendered footprints by PLAN POSITION:
   *
   *   <g class="plan-furniture" transform="translate(x z) rotate(deg)">
   *     <rect class="furniture-footprint cabinet">
   *     <text class="furniture-label">橱柜</text>
   *   </g>
   *
   * The <g> translate is the item's plan coordinate, the same value stored in
   * `item.position`, so this stays correct for any size or rotation. */

  // Plan coordinates of every fridge record, refreshed from the API.
  var fridgePlanPoints = [];

  /* 从共享快照里算出本补丁的记录坐标。快照层保证"同一时刻只有一个
   * /api/projects/current 在途"，各补丁不再各拉一份完整项目。 */
  function applyFridgeProject(project) {
    if (!project || !project.floors) return;
    var pts = [];
    project.floors.forEach(function (floor) {
      (floor.furniture || []).forEach(function (item) {
        if (!item || item.modelId !== MODEL_ID) return;
        if (!item.position || item.position.length < 2) return;
        pts.push([Number(item.position[0]), Number(item.position[1])]);
      });
    });
    fridgePlanPoints = pts;
    stats.fridgePlanPoints = pts.length;
  }

  function snapshot() {
    return window.ha3dProjectSnapshot || null;
  }

  function refreshFridgePlanPoints() {
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
        applyFridgeProject(res && (res.project || res));
      })
      .catch(function (err) {
        stats.lastError = String(err);
      });
  }

  // Parse `translate(x z) rotate(deg)` from a plan-furniture <g>.
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

  /* Which rendered footprint groups belong to a fridge record.
   * Returns the <g class="plan-furniture"> nodes (never the rects: the group
   * is what carries the position, and the label lives inside it). */
  function fridgeFootprintGroups(svg) {
    var out = [];
    if (!svg || !fridgePlanPoints.length) return out;
    var groups = svg.querySelectorAll("g.plan-furniture");
    for (var i = 0; i < groups.length; i += 1) {
      var pos = planGroupTransform(groups[i]);
      if (!pos) continue;
      for (var j = 0; j < fridgePlanPoints.length; j += 1) {
        var p = fridgePlanPoints[j];
        // 1 cm tolerance: the SVG carries the same float the API returned.
        if (Math.abs(pos[0] - p[0]) < 0.01 && Math.abs(pos[1] - p[1]) < 0.01) {
          out.push(groups[i]);
          break;
        }
      }
    }
    return out;
  }

  function relabelFridgeFootprints() {
    try {
      var svg = document.querySelector("svg.floorplan-canvas");
      if (!svg) return;
      var groups = fridgeFootprintGroups(svg);
      for (var i = 0; i < groups.length; i += 1) {
        var label = groups[i].querySelector("text.furniture-label");
        if (label && label.textContent !== "冰箱") label.textContent = "冰箱";
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* ------------------------------------ 2D footprint icon ---------- */
  /* The plan view draws every furniture item as a plain filled rect. For our
   * fridges we overlay the user-supplied fridge pictogram — a nested <svg> with
   * its own viewBox, so it scales exactly onto the footprint — and clear the
   * carrier kind's fill, keeping the footprint outline as the 2D placeholder.
   * pointer-events:none keeps the rect as the click target for selection. */
  var SVG_NS = "http://www.w3.org/2000/svg";
  var FRIDGE_ICON_PATH =
    "M849.565538 971.067077H178.254769a93.814154 93.814154 0 0 1-92.553846-92.553846V369.230769" +
    "a30.562462 30.562462 0 0 1 30.877539-30.877538h792.812307a33.358769 33.358769 0 0 1 32.807385" +
    "30.877538v509.243077a93.814154 93.814154 0 0 1-92.632616 92.593231zM380.849231 415.547077a38.596923" +
    " 38.596923 0 1 0 0 77.154461h262.340923a38.596923 38.596923 0 0 0 0-77.154461z m563.2-154.308923" +
    "H79.911385a30.562462 30.562462 0 0 1-30.877539-30.877539V137.846154a93.853538 93.853538 0 0 1" +
    " 92.593231-92.672h740.745846A93.853538 93.853538 0 0 1 974.966154 137.846154v92.514461a30.523077" +
    " 30.523077 0 0 1-30.838154 30.877539z";

  function makeFridgeIcon(w, h) {
    var iw = typeof w === "number" && isFinite(w) && w > 0 ? w : DIM.width;
    var ih = typeof h === "number" && isFinite(h) && h > 0 ? h : DIM.depth;
    var icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("class", "fridge-footprint-icon");
    icon.setAttribute("x", String(-iw / 2));
    icon.setAttribute("y", String(-ih / 2));
    icon.setAttribute("width", String(iw));
    icon.setAttribute("height", String(ih));
    icon.setAttribute("viewBox", "0 0 1024 1024");
    icon.setAttribute("preserveAspectRatio", "none");
    icon.setAttribute("pointer-events", "none");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", FRIDGE_ICON_PATH);
    path.setAttribute("fill", "#bfbfbf");
    icon.appendChild(path);
    return icon;
  }

  /* The right-hand inspector title is `vt[selected.kind].label` (hard-coded
   * catalog), so a selected fridge reads "橱柜". That value lives in React
   * state and is re-rendered on every update, so the rendered <h2> inside
   * `.inspector-title` is patched right after each paint.
   *
   * The selected item is identified by PLAN POSITION (see
   * fridgeFootprintGroups), never by size, so a resized fridge keeps the
   * "冰箱" title. */
  function relabelInspectorTitle() {
    try {
      var svg = document.querySelector("svg.floorplan-canvas");
      if (!svg) return;
      var groups = fridgeFootprintGroups(svg);
      var selectedIsFridge = false;
      for (var i = 0; i < groups.length; i += 1) {
        if (groups[i].querySelector("rect.furniture-footprint.selected")) {
          selectedIsFridge = true;
          break;
        }
      }
      if (!selectedIsFridge) return;
      var h2 = document.querySelector(".inspector-title h2");
      if (h2 && h2.textContent !== "冰箱") h2.textContent = "冰箱";
      var small = document.querySelector(".inspector-title small");
      if (small && /家具/.test(small.textContent) && /橱柜/.test(small.textContent)) {
        small.textContent = small.textContent.replace(/橱柜/g, "冰箱");
      }
      // The summary card repeats the carrier label in its own heading
      // ("家具 / 橱柜"), which React re-renders independently of the title.
      var headings = document.querySelectorAll(".selection-summary-heading strong");
      for (var hi = 0; hi < headings.length; hi += 1) {
        if (headings[hi].textContent === "橱柜") headings[hi].textContent = "冰箱";
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  function paintFridgeFootprints() {
    try {
      var svg = document.querySelector("svg.floorplan-canvas");
      if (!svg) return;
      var groups = fridgeFootprintGroups(svg);
      for (var i = 0; i < groups.length; i += 1) {
        var g = groups[i];
        var rect = g.querySelector("rect.furniture-footprint");
        if (!rect) continue;
        rect.style.fill = "none";
        // `fill:none` alone would make the rect hit-test transparent (SVG's
        // default pointer-events only counts painted areas), so the footprint
        // could no longer be clicked in the editor. Force it to keep receiving
        // pointer events over its whole box.
        rect.style.pointerEvents = "all";
        if (!g.querySelector(".fridge-footprint-icon")) {
          // Size the pictogram to the CURRENT footprint so a resized fridge
          // still gets an icon that fills its box.
          var w = parseFloat(rect.getAttribute("width")) || DIM.width;
          var h = parseFloat(rect.getAttribute("height")) || DIM.depth;
          g.insertBefore(makeFridgeIcon(w, h), rect.nextSibling);
        }
      }
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  function nativeLibraryCards() {
    var all = document.querySelectorAll(
      ".furniture-library-grid > button, [class*='furniture-library'] button"
    );
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

  // A click on a native card hands selection back to the SPA: disarm ours so
  // the canvas drops the native kind again.
  function installNativeCardHandoff() {
    document.addEventListener(
      "click",
      function (e) {
        if (!placementArmed) return;
        var target = e.target;
        if (!target || !target.closest) return;
        if (target.closest("#" + BUTTON_ID)) return;
        var card = target.closest("button");
        if (!card || card.id === BUTTON_ID) return;
        if (!card.querySelector(".furniture-pictogram")) return;
        placementArmed = false;
        stats.armed = false;
        setArmedVisual(false);
        log("fridge placement disarmed (native card selected)");
      },
      true
    );
  }

  /* Screen -> plan metres. The canvas viewBox is in metres (footprints use
   * x=-width/2, width=2.2 ...), so the CTM inverse gives plan coordinates.
   * Fallback: if the CTM is unavailable, map through the bounding rect and the
   * viewBox (keeps placement working instead of silently returning null, which
   * used to let the SPA's armed sofa drop instead). */
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
      /* fall through to the rect-based mapping */
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

  /* Intercept EVERY press/release event the SPA might use to drop furniture —
   * on WINDOW, capture phase.
   *
   * Why WINDOW and not document: the SPA registers its own placement handler
   * on `window` (measured: with document-capture interception, re-opening the
   * furniture panel and clicking the canvas dropped BOTH a fridge (ours) and
   * a sofa (the SPA's) — the SPA's window-capture listener ran BEFORE our
   * document-capture one, because window precedes document in the capture
   * path, and stopImmediatePropagation cannot retro-stop an earlier listener).
   * Registering on window makes ours the very first listener that runs, so
   * the stop actually shields the SPA.
   *
   * Both pointer AND mouse events are covered: a real click fires pointerdown
   * then mousedown (plus the up/click pair), and SPA builds differ on which
   * one triggers placement.
   *
   * WHY THE "placed" FLAG IS GONE FROM THE RELEASE PATH.
   * The previous build kept a boolean set for 1000 ms after a placement and
   * swallowed every canvas event while it was set. `click` is not guaranteed
   * while a click-to-cartesian handler with an early `return` sits in the SVG
   * capture path, so that boolean regularly stayed `true` for the full second:
   * the very next click on the plan was eaten, which is exactly the reported
   * "点了差不多一秒才落到画布上". Now only the arm used for THIS gesture is
   * consumed, and the pointer identity alone decides which release events
   * belong to a placement gesture. */
  var placedPointerId = null;
  var placedByMouse = false;

  /* Gesture lock for THIS placement only.
   *
   * A single canvas click emits pointerdown → pointerup → click. The old code
   * only stopped pointerdown, then released, so the trailing `click` flowed to
   * the SPA — whose window-capture click handler drops ITS own armed kind
   * (a sofa) and PUTs the whole in-memory project over the fridge record. The
   * old `gestureIsOurs` looked like it covered that, but `click` carries no
   * pointerId, so it fell through to `placedByMouse` (false for any pointer
   * gesture) and never blocked anything.
   *
   * A fixed 1 s boolean is NOT the answer either — that was the earlier
   * "点了差不多一秒才落到画布上" bug, where the next click got eaten. So the
   * lock is keyed by a gesture serial instead: every placement bumps
   * `gestureSerial`, and only the release/click that belongs to that same
   * serial is swallowed. The next independent click is untouched. */
  /* -1 表示"没有任何手势被锁"。若用 0 当初始值，由于 gestureSerial 也从 0 开始，
   * 页面刚加载时 blockingSerial === gestureSerial 会成立，导致**第一次点击就被
   * 当成"上一个放置手势的尾巴"封掉** —— 家具彻底点不动。 */
  var gestureSerial = 0;
  var blockingSerial = -1;

  function handleDown(e) {
    if (!placementArmed) return;
    var t = e.target;
    if (t && t.closest) {
      // Outside the canvas (toolbar, panels, library cards): disarm and let
      // the event flow through untouched so the SPA still reacts to it.
      if (!t.closest("svg.floorplan-canvas")) {
        if (!t.closest("#" + BUTTON_ID)) {
          setArmed(false);
          log("fridge placement disarmed (interaction outside the plan)");
        }
        return;
      }
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    /* Arm the gesture lock BEFORE the async placement, and disarm immediately:
     * `addFridgeAt` resolves over several microtasks (GET + PUT), so doing the
     * release afterwards kept the lock alive while an impatient second click
     * arrived. */
    if (e.type === "pointerdown") placedPointerId = e.pointerId;
    else placedByMouse = true;
    gestureSerial += 1;
    blockingSerial = gestureSerial;
    stats.clicks += 1;
    var pos = planPointFromEvent(e);
    if (pos) addFridgeAt(pos);
    // One-shot, exactly like a native card: the SPA places a single item and
    // un-highlights the card.
    setArmed(false);
  }

  function handleUp(e, type) {
    var t = e.target;
    if (!t || !t.closest || !t.closest("svg.floorplan-canvas")) return;
    /* Only the tail of the gesture that placed a fridge is blocked. Once the
     * `click` of that gesture has been swallowed the lock is cleared, so the
     * next click goes straight through. */
    if (blockingSerial !== gestureSerial) {
      if (placementArmed) setArmed(false);
      return;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    if (placementArmed) setArmed(false);
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
            if (placementArmed) handleDown(e);
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
  // Path-aware like the SPA (R3.2): when served under /api/<integration>/ the
  // API root is that prefix, otherwise fall back to the SPA's own document
  // relative "./api/..." form so the panel URL never breaks the endpoints.
  function apiUrl(path) {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1] + path;
    return "." + path;
  }

  function addFridgeAt(pos) {
    fetch(apiUrl("/api/projects/current"), { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("load project failed " + res.status);
        return res.json();
      })
      .then(function (res) {
        var project = res && (res.project || res);
        if (!project || !project.floors || !project.floors.length) {
          throw new Error("no project");
        }
        var floor = project.floors[0];
        var item = {
          id: "furniture-fridge-" + Date.now(),
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
        log("fridge furniture added at", pos);
        var snapAfter = snapshot();
        if (snapAfter) snapAfter.refresh();
        // 放置后自动选中，弹出属性卡片（与原生家具一致）
        if (window.ha3dSelectAfterPlace) window.ha3dSelectAfterPlace(pos);
        // One-shot placement: drop one fridge per arm, like a stamp, so a
        // forgotten armed state cannot litter the plan with cabinets.
        setArmed(false);
        // The new record must be known before the footprint can be identified
        // (identification is position-based), so refresh the list first and
        // paint once it lands. The interval tick re-applies it afterwards.
        refreshFridgePlanPoints();
        window.setTimeout(function () {
          paintFridgeFootprints();
          relabelFridgeFootprints();
          relabelInspectorTitle();
        }, 400);
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("add fridge failed", err);
      });
  }

  /* ------------------------------------------------ self-heal old data */
  /* Earlier builds of this patch wrote kind:"fridge" records, which crash the
   * SPA (`vt[kind].label` of undefined) on every project load. One-time
   * migration: rewrite any such record to the carrier kind + modelId so the
   * saved project becomes loadable again. */
  function repairLegacyFridgeRecords() {
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
            if (!item) return;
            // Old builds wrote kind:"fridge" (crashes the SPA catalog).
            if (item.kind === "fridge") {
              item.kind = CARRIER_KIND;
              item.modelId = MODEL_ID;
              changed += 1;
              return;
            }
            // Records left behind by the early one-shot click (v4-v5) were
            // cabinets with modelId null/absent, so `appliance-fridge.js` no
            // longer recognised them and the 3D view showed a plain cabinet.
            // Such a cabinet can only be ours when its size is the fridge size.
            if (
              item.kind === CARRIER_KIND &&
              item.modelId !== MODEL_ID &&
              Math.abs(item.width - DIM.width) < 0.02 &&
              Math.abs(item.depth - DIM.depth) < 0.02
            ) {
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
          log("repaired legacy fridge records:", changed);
        });
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("repair failed", err);
      });
  }

  /* ----------------------------------------------------------- boot */
  function start() {
    repairLegacyFridgeRecords();
    // 订阅共享快照：有缓存时立即回调一次，之后每次刷新都会再次回调
    var snap = snapshot();
    if (snap) snap.subscribe(applyFridgeProject);
    refreshFridgePlanPoints();
    installPlacementInterceptor();
    installNativeCardHandoff();
    installDisarmGuards();
    ensureButton();
    // The grid only exists while the editor view is open and may be rebuilt
    // (floor switch, mode change), so keep (re)injecting defensively.
    // The project data is re-read on a slower cadence than the repaint: the
    // SPA re-renders the footprints constantly, but the set of fridge records
    // only changes when the user adds/deletes/moves one.
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      if (tick % 30 === 0) refreshFridgePlanPoints();
      ensureButton();
      relabelFridgeFootprints();
      paintFridgeFootprints();
      relabelInspectorTitle();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
