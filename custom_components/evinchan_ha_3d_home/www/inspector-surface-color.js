/*
 * Surface colour picker for custom appliance models (运行时补丁).
 *
 * WHAT IT DOES
 *   Injects a "表面颜色" swatch row into the floor-plan editor's inspector
 *   panel whenever the selected furniture record belongs to one of our custom
 *   appliance models (fridge / washer / dining set). Picking a swatch writes
 *   `surfaceColor` onto the record and PUTs the project, which broadcasts
 *   `project.updated`; the 3D patches pick up the new value and rebuild the
 *   model with that colour. No page reload, no rebuild step.
 *
 * WHY A SEPARATE PATCH
 *   The picker is model-agnostic: it only needs to know which `modelId`s are
 *   recolourable and what to show as the swatch list. Keeping it in one file
 *   means adding a new model does not duplicate the whole inspector plumbing.
 *
 * WHY THE COLOUR LIVES ON THE RECORD
 *   Anything the SPA itself does not know about must survive
 *   `normalize_furniture` in schema.py, which rebuilds the record field by
 *   field and silently drops unknown keys. `surfaceColor` is therefore
 *   whitelisted there (validated as #rrggbb). Storing it client-side only
 *   (localStorage) would not follow the furniture item around and would be
 *   lost on another browser.
 *
 * HOW THE INJECTION SURVIVES REACT
 *   The inspector is React managed: it re-renders on every selection change and
 *   wipes foreign nodes. A MutationObserver on the panel re-inserts the row as
 *   soon as it disappears (microtask level), with the poll as a backstop.
 *
 * Debug: window.ha3dColorLibDebug
 */
(function () {
  "use strict";

  var VERSION = 2;

  /* One entry per recolorable model; `fields` lists every record key that model
   * exposes to the user. A model with more than one field shows one swatch row
   * per field, so a round table can offer "桌面颜色" and "餐椅颜色" separately
   * (the table record owns the six chairs it renders — see
   * furniture-dining-table.js).
   *
   * Each field:
   *   key      record key the swatch writes (#rrggbb, whitelisted in schema.py)
   *   label    what the inspector shows above the swatches
   *   presets  swatch palette
   *   fallback swatch shown as "current" when the record has no value yet
   */
  var SURFACE_PRESETS = ["#cfd3d7", "#b9bec4", "#8f9499", "#4b5055", "#2b2f33", "#e8e4dc"];
  var UPHOLSTERY_PRESETS = ["#7b5638", "#4a3728", "#a8825e", "#2f3439", "#6d7b8a", "#d8cfc2"];

  var TARGETS = [
    {
      modelId: "appliance.fridge",
      label: "冰箱",
      fields: [{ key: "surfaceColor", label: "表面颜色", presets: SURFACE_PRESETS, fallback: SURFACE_PRESETS[0] }],
    },
    {
      modelId: "appliance.washer",
      label: "洗衣机",
      fields: [
        {
          key: "surfaceColor",
          label: "表面颜色",
          presets: ["#dcdfe3", "#c2c7cc", "#8e949a", "#4c5257", "#22262b", "#eef0f1"],
          fallback: "#dcdfe3",
        },
      ],
    },
    {
      /* Table top and the chairs that belong to it are separate options: the
       * six chairs are part of the table model, so their colour cannot be set
       * from a chair record. */
      modelId: "furniture.dining_round_table",
      label: "餐桌",
      fields: [
        {
          key: "surfaceColor",
          label: "桌面颜色",
          presets: ["#f3f1ec", "#23262a", "#7b5638", "#5a6270", "#c9c2b4", "#3a3f47"],
          fallback: "#f3f1ec",
        },
        { key: "chairColor", label: "餐椅颜色", presets: UPHOLSTERY_PRESETS, fallback: "#7b5638" },
      ],
    },
    {
      modelId: "furniture.dining_chair",
      label: "餐椅",
      fields: [{ key: "surfaceColor", label: "表面颜色", presets: UPHOLSTERY_PRESETS, fallback: "#7b5638" }],
    },
    {
      /* 布艺沙发：色板 = 布艺软垫（坐垫/靠背/扶手/拉点），木框架保持胡桃木。 */
      modelId: "furniture.fabric_sofa",
      label: "沙发",
      fields: [{ key: "surfaceColor", label: "面料颜色", presets: UPHOLSTERY_PRESETS, fallback: "#d8cfc2" }],
    },
    {
      /* 子母茶几：两张岩板台面各自独立配置颜色；桌腿与落地圆环
       * 永远是黑金属，不随色板变化。 */
      modelId: "furniture.nested_coffee_tables",
      label: "子母茶几",
      fields: [
        {
          key: "surfaceColor",
          label: "大茶几台面",
          presets: ["#f2f0ea", "#23262a", "#c9c2b4", "#5a6270", "#8a6442", "#3a3f47"],
          fallback: "#f2f0ea",
        },
        {
          key: "smallTopColor",
          label: "小茶几台面",
          presets: ["#1e2124", "#f2f0ea", "#3a3f47", "#5a6270", "#8a6442", "#c9c2b4"],
          fallback: "#1e2124",
        },
      ],
    },
    {
      /* 定制餐边柜：奶白门板与浅木柜体各自独立配置；
       * 黑框与玻璃固定，不随色板变化。 */
      modelId: "furniture.sideboard",
      label: "餐边柜",
      fields: [
        {
          key: "doorColor",
          label: "门板颜色",
          presets: ["#ede7da", "#f4efe4", "#d9d2c2", "#cfc6b4", "#b8ada0", "#8a8177"],
          fallback: "#ede7da",
        },
        {
          key: "cabinetColor",
          label: "柜体颜色",
          presets: ["#c9a87c", "#d6bd97", "#b08d5e", "#9a7a50", "#7b6242", "#5c4433"],
          fallback: "#c9a87c",
        },
      ],
    },
    {
      /* 百合竹盆栽：只开放花盆基色（默认白底黑纹大理石的白）；
       * 黑纹、金福字贴纸、浅木枝干与鲜绿叶片固定不随色板变化。 */
      modelId: "furniture.dragon_tree",
      label: "百合竹盆栽",
      fields: [
        {
          key: "potColor",
          label: "花盆颜色",
          presets: ["#f2efe9", "#e3ddd2", "#c9c4ba", "#9aa5a1", "#b46a55", "#3f6f5a"],
          fallback: "#f2efe9",
        },
      ],
    },
  ];

  var ROW_CLASS = "ha3d-color-row";
  var ROW_ID = "ha3d-color-picker";
  var POLL_MS = 500;

  var stats = {
    version: VERSION,
    polls: 0,
    injected: 0,
    injections: 0,
    reinjections: 0,
    picks: 0,
    saves: 0,
    selectedModelId: null,
    currentColor: null,
    lastError: null,
  };
  window.ha3dColorLibDebug = stats;

  function log() {
    if (!window.HA3D_COLOR_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home color]"].concat(Array.prototype.slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  function apiUrl(path) {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1] + path;
    return "." + path;
  }

  function targetFor(modelId) {
    for (var i = 0; i < TARGETS.length; i += 1) {
      if (TARGETS[i].modelId === modelId) return TARGETS[i];
    }
    return null;
  }

  /* ---------------------------------------------------- record lookup */
  /* The selected item is identified by the SELECTED footprint on the canvas:
   * its <g class="plan-furniture"> translate equals item.position, so the
   * record can be found without relying on any size (which the editor lets the
   * user change). */
  var project = null;

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
        if (Math.abs(Number(it.position[0]) - pos[0]) < tol && Math.abs(Number(it.position[1]) - pos[1]) < tol) {
          return { item: it, floor: project.floors[f] };
        }
      }
    }
    return null;
  }

  function applyProject(p) {
    if (p && p.floors) project = p;
  }

  function snapshot() {
    return window.ha3dProjectSnapshot || null;
  }

  /* 走共享快照：多个补丁不再各拉一份完整项目（§6.1 性能预算）。 */
  function loadProject() {
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

  /* ------------------------------------------------------------ the UI */
  /* One field = one labelled swatch row. A target with several fields (the
   * round table: top + chairs) renders a titled block with a row per field, so
   * the two colours can be set independently. Inline styles only: the markup
   * lives inside React-owned containers and a stylesheet rule could be scoped
   * away by the SPA's CSS. */
  function buildFieldRow(field, currentColor) {
    var wrap = document.createElement("div");
    wrap.setAttribute("data-field", field.key);
    wrap.style.cssText = "display:flex;flex-direction:column;gap:8px;";

    var head = document.createElement("div");
    head.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;gap:8px;" +
      "font-size:12px;letter-spacing:0.02em;opacity:0.85;";
    var title = document.createElement("span");
    title.textContent = field.label;
    var value = document.createElement("span");
    value.textContent = String(currentColor || field.fallback || "").toUpperCase();
    value.style.cssText = "font-variant-numeric:tabular-nums;opacity:0.7;";
    head.appendChild(title);
    head.appendChild(value);
    wrap.appendChild(head);

    var swatches = document.createElement("div");
    swatches.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;";

    var active = (currentColor || "").toLowerCase();
    function applyActive(hex) {
      var buttons = swatches.querySelectorAll("button[data-color]");
      for (var i = 0; i < buttons.length; i += 1) {
        var on = buttons[i].getAttribute("data-color").toLowerCase() === hex.toLowerCase();
        buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
        buttons[i].style.border = "2px solid " + (on ? "rgba(64,158,255,0.95)" : "rgba(127,127,127,0.45)");
        buttons[i].style.boxShadow = on ? "0 0 0 2px rgba(64,158,255,0.28)" : "none";
      }
    }

    field.presets.forEach(function (hex) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.title = hex.toUpperCase();
      btn.setAttribute("data-color", hex);
      btn.setAttribute("aria-label", field.label + " " + hex.toUpperCase());
      var isActive = active === hex.toLowerCase();
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.style.cssText =
        "width:26px;height:26px;padding:0;border-radius:50%;cursor:pointer;" +
        "background:" + hex + ";" +
        "border:2px solid " + (isActive ? "rgba(64,158,255,0.95)" : "rgba(127,127,127,0.45)") + ";" +
        "box-shadow:" + (isActive ? "0 0 0 2px rgba(64,158,255,0.28)" : "none") + ";" +
        "transition:transform 120ms ease;";
      btn.addEventListener("mouseenter", function () {
        btn.style.transform = "scale(1.08)";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.transform = "scale(1)";
      });
      // stopPropagation: a click here must not be mistaken for a canvas or
      // inspector interaction that would change the selection.
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        pickColor(field.key, hex);
        applyActive(hex);
        value.textContent = hex.toUpperCase();
      });
      swatches.appendChild(btn);
    });

    /* Native colour input for anything outside the presets. */
    var custom = document.createElement("input");
    custom.type = "color";
    custom.setAttribute("aria-label", field.label + " 自定义颜色");
    custom.value = currentColor || field.fallback || "#ffffff";
    custom.style.cssText =
      "width:30px;height:26px;padding:0;border:none;border-radius:6px;cursor:pointer;background:transparent;";
    custom.addEventListener("input", function (e) {
      e.stopPropagation();
      value.textContent = String(custom.value || "").toUpperCase();
    });
    custom.addEventListener("change", function (e) {
      e.stopPropagation();
      pickColor(field.key, custom.value);
      applyActive(custom.value);
    });
    custom.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    swatches.appendChild(custom);
    wrap.appendChild(swatches);
    return wrap;
  }

  function buildBlock(target, values) {
    var block = document.createElement("div");
    block.id = ROW_ID;
    block.className = ROW_CLASS;
    block.setAttribute("data-model", target.modelId);
    block.style.cssText =
      "display:flex;flex-direction:column;gap:10px;padding:12px;margin:10px 0;" +
      "border:1px solid rgba(127,127,127,0.28);border-radius:10px;" +
      "background:rgba(127,127,127,0.06);";

    if (target.fields.length > 1) {
      var heading = document.createElement("div");
      heading.textContent = "颜色";
      heading.style.cssText = "font-size:12px;font-weight:600;opacity:0.9;";
      block.appendChild(heading);
    }

    for (var i = 0; i < target.fields.length; i += 1) {
      var field = target.fields[i];
      block.appendChild(buildFieldRow(field, values[field.key] || null));
    }
    return block;
  }

  function removeRow() {
    var existing = document.getElementById(ROW_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  }

  /* Insert the row into the inspector, right after the summary card so it
   * reads as a normal inspector section (not a floating overlay). */
  function ensureRow() {
    stats.polls += 1;
    try {
      var pos = selectedPlanPosition();
      if (!pos) {
        state.key = null;
        removeRow();
        return;
      }
      var found = findRecordAt(pos);
      if (!found) {
        // The project copy may be stale (first paint, or a record just added).
        loadProject();
        removeRow();
        return;
      }
      var modelId = found.item.modelId;
      var target = targetFor(modelId);
      if (!target) {
        state.key = null;
        removeRow();
        return;
      }

      /* Every field's value is part of the rebuild key, so changing the chair
       * colour rebuilds the block with the top colour still highlighted (and
       * vice versa) instead of resetting the other row. */
      var values = {};
      var keyParts = [modelId, pos[0], pos[1]];
      for (var fi = 0; fi < target.fields.length; fi += 1) {
        var fk = target.fields[fi].key;
        values[fk] = found.item[fk] || null;
        keyParts.push(fk + ":" + (values[fk] || ""));
      }
      var key = keyParts.join("|");
      stats.selectedModelId = modelId;
      stats.currentColor = values[target.fields[0].key] || null;
      stats.currentValues = values;

      var existing = document.getElementById(ROW_ID);
      if (existing && existing.getAttribute("data-key") === key && existing.parentNode) return;

      removeRow();
      var row = buildBlock(target, values);
      row.setAttribute("data-key", key);

      var host =
        document.querySelector(".selection-summary-card") ||
        document.querySelector(".inspector-panel") ||
        document.querySelector(".inspector-title");
      if (!host) return;
      if (host === document.querySelector(".selection-summary-card")) {
        host.parentNode.insertBefore(row, host.nextSibling);
      } else {
        host.appendChild(row);
      }
      stats.injected = 1;
      stats.injections += 1;
      watchInspector();
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  var state = { key: null };

  /* React wipes the injected row on every re-render of the inspector. */
  var observedPanel = null;
  var observer = null;
  var restoring = false;

  function watchInspector() {
    if (!window.MutationObserver) return;
    var panel = document.querySelector(".inspector-panel") || document.querySelector(".selection-summary-card");
    if (!panel) return;
    if (observedPanel === panel && observer) return;
    try {
      if (observer) observer.disconnect();
      observedPanel = panel;
      observer = new MutationObserver(function () {
        if (restoring) return;
        if (document.getElementById(ROW_ID)) return;
        restoring = true;
        try {
          ensureRow();
          stats.reinjections += 1;
        } catch (err) {
          stats.lastError = String(err);
        }
        restoring = false;
      });
      observer.observe(panel, { childList: true, subtree: true });
    } catch (err) {
      stats.lastError = String(err);
    }
  }

  /* --------------------------------------------------------- persistence */
  /* `fieldKey` is the RECORD KEY to write (surfaceColor / chairColor / ...).
   * The row is already repainted optimistically by buildFieldRow's handlers,
   * and the block is rebuilt from the fresh project after the save lands, so
   * the other field's swatch ring is never disturbed. */
  function pickColor(fieldKey, hex) {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    var pos = selectedPlanPosition();
    if (!pos) return;
    stats.picks += 1;
    state.key = "pending";

    fetch(apiUrl("/api/projects/current"), { credentials: "same-origin" })
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
            if (hit || !it || !it.position) return;
            if (Math.abs(Number(it.position[0]) - pos[0]) < 0.01 && Math.abs(Number(it.position[1]) - pos[1]) < 0.01) {
              hit = it;
            }
          });
        });
        if (!hit) throw new Error("record not found");
        hit[fieldKey] = hex.toLowerCase();
        return fetch(apiUrl("/api/projects/" + p.id), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(p),
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error("save failed " + res.status);
        stats.saves += 1;
        stats.currentColor = hex.toLowerCase();
        stats.lastSavedField = fieldKey;
        log("colour saved", fieldKey, hex);
        // 写操作后必须强制拉新：共享快照里还是保存前的旧数据
        var snapAfter = snapshot();
        if (snapAfter) snapAfter.refresh();
        else loadProject();
        state.key = null; // force a rebuild of the row with the new state
        window.setTimeout(ensureRow, 120);
      })
      .catch(function (err) {
        stats.lastError = String(err);
        log("colour save failed", err);
        state.key = null;
        window.setTimeout(ensureRow, 120);
      });
  }

  /* ------------------------------------------------------------- boot */
  function start() {
    // 订阅共享快照：有缓存时立即回调一次，之后每次刷新都会再次回调
    var snap = snapshot();
    if (snap) snap.subscribe(applyProject);
    loadProject();
    // The inspector only exists in the editor view; keep polling defensively
    // because switching floors / views rebuilds it.
    var tick = 0;
    window.setInterval(function () {
      tick += 1;
      // 共享层自带节流与在途合并，这里只做低成本触发
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
