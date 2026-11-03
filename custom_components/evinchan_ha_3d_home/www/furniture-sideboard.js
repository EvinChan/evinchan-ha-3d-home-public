/*
 * 定制餐边柜 3D 模型（运行时补丁）。
 *
 * Record shape: carrier kind "sideboard"（SPA 白名单内，会被原生渲染 → 三层隐藏）
 * + modelId "furniture.sideboard"。纯 furniture 路径 A，不绑定 HA 实体。
 *
 * 造型：浅木色柜体 + 奶白哑光烤漆门板 + 黑色细框透明玻璃展示区。
 * 左侧通高玻璃展示塔（4 隔板），右上 4 扇封闭柜门 + 下方开放格，
 * 中段背板 + 台面，下方 3 扇大柜门 + 右侧上下 2 扇，地脚封边 + 顶封板。
 * 整体 2.2 × 0.35 × 2.5 m。
 *
 * 坐标约定（ha3d-model-modeling §6.1）：原点 = 包围盒中心地面点，
 * 正面直接朝 -Z，MODEL_YAW / MODEL_Z_OFFSET 均为 0。
 *
 * 特殊材质：三套 visualStyle 下统一「木纹 / 哑白烤漆 / 黑框 / 玻璃」，
 * 描边沿用奶油风格逻辑（outline = 0，无描边外壳）。
 * 可配置颜色（inspector-surface-color.js 写记录，schema.py 白名单）：
 *   doorColor    奶白门板（默认 #ede7da）
 *   cabinetColor 浅木柜体（默认 #c9a87c），黑框与玻璃固定不随参数变化。
 *
 * 骨架来自 model-template.js：区间足迹判据 / per-uid 宿主锁定 / 帧驱动 /
 * 无每轮静态写回（自动旋转漂移三硬规则，ha3d-model-integration §6.3）。
 *
 * Debug: window.ha3dSideboardProbe()
 */
(function () {
  "use strict";

  var MODEL_IDS = ["furniture.sideboard"];
  var STYLE_KEY = "ha3d.home.sceneVisualStyle";
  var MODEL_FLAG = "ha3dSideboard";
  var STOCK_CLAIM = "ha3dSideboardStockHidden"; // 专属占用标记，不与其他补丁共用
  var STANDALONE_FLAG = "ha3dSideboardStandalone";
  var SCAN_KEY = "furniture-sideboard";
  var VERSION = 5;

  /* 诊断对象必须在 hook 之前声明（var 提升不提升赋值）。 */
  var stats = {
    version: VERSION,
    runs: 0,
    entries: 0,
    attached: 0,
    models: 0,
    hiddenStock: 0,
    kitMissing: null,
    degraded: null,
    devtoolsHook: null,
    storeRoute: null,
    lastError: null,
    lastStack: null,
  };
  window.ha3dSideboardDebug = stats;

  /* ------------------------------------------------------------ 尺寸（米） */
  var DIM = {
    width: 2.2,
    depth: 0.35,        // 整体外深
    height: 2.5,
    depthBody: 0.33,    // 柜体进深（门凸出在前）
    depthDoor: 0.02,    // 门/框厚
    footHeight: 0.05,   // 地脚高
    footT: 0.02,        // 地脚封边厚
    panelT: 0.018,      // 隔板/背板/开放格板厚
    topCapT: 0.02,      // 顶封板厚
    glassZoneW: 0.55,   // 左玻璃区总宽
    colW: 0.4125,       // 右区单列宽
    seam: 0.008,        // 门缝
    frameT: 0.03,       // 黑框梃宽
    frameMidT: 0.025,   // 黑框中横梃高
  };

  /* 派生量 —— 全部显式定义，禁止引用 DIM 不存在的字段 */
  var TOTAL_W = DIM.width;
  var TOTAL_D = DIM.depth;
  var TOTAL_H = DIM.height;
  var BODY_BOTTOM = DIM.footHeight;                 // 0.05
  var BODY_TOP = TOTAL_H - DIM.topCapT;             // 2.48
  var LOWER_TOP = 0.95;                             // 下柜门顶
  var COUNTER_BOT = LOWER_TOP;                      // 台面 0.95→0.97
  var COUNTER_TOP = LOWER_TOP + DIM.panelT;         // 0.968 ≈ 台面顶
  var MID_TOP = 1.6;                                // 中段顶（上柜底）
  var NICHE_BOT = 1.32;
  var NICHE_TOP = 1.58;
  var GLASS_SPLIT_Y = 1.27;                         // 黑框中横梃中心

  /* z 平面：柜体 z ∈ [-0.155, +0.175]，门 z ∈ [-0.175, -0.155]，bbox 关于 0 对称 */
  var BODY_CENTER_Z = 0.01;
  var BODY_D = DIM.depthBody;
  var DOOR_CENTER_Z = -0.165;
  var GLASS_Z = -0.157;

  /* x 边界：左区 [-1.1, -0.55]，右区 4 列各 0.4125 */
  var X_LEFT = -TOTAL_W / 2;             // -1.1
  var GLASS_X0 = X_LEFT + DIM.glassZoneW; // -0.55
  var X_RIGHT = TOTAL_W / 2;             // 1.1

  var MODEL_YAW = 0;
  var MODEL_Z_OFFSET = 0;

  var SCAN_INTERVAL = 700;

  /* 默认色（记录未设置时使用） */
  var DEFAULT_DOOR_HEX = "#ede7da";
  var DEFAULT_CAB_HEX = "#c9a87c";
  var BLACK = 0x1e1e20;
  var GLASS_TINT = 0x2a2e30;

  /* ------------------------------------------------------------- 工具 */
  function log() {
    if (!window.HA3D_SIDEBOARD_DEBUG) return;
    try { console.log.apply(console, ["[3d-home sideboard]"].concat([].slice.call(arguments))); } catch (e) {}
  }

  function apiBase() {
    var parts = window.location.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && parts[0] === "api") return "/" + parts[0] + "/" + parts[1];
    return "";
  }

  function currentStyle() {
    try {
      var v = window.localStorage.getItem(STYLE_KEY);
      if (v === "cream" || v === "cartoon" || v === "glass") return v;
    } catch (e) {}
    return "glass";
  }

  /* ------------------------------------- 场景捕获（链式，绝不覆盖旧 hook） */
  var capturedScene = null;
  (function installHook() {
    try {
      function onEvent(e) {
        try {
          var renderer = e.detail;
          if (!renderer || typeof renderer.render !== "function") return;
          stats.rendererCaptured = true;
          if (renderer.__ha3dSideboardHooked) return;
          renderer.__ha3dSideboardHooked = true;
          var orig = renderer.render;
          renderer.render = function (scene, camera) {
            try {
              if (scene && scene.isScene) {
                capturedScene = scene;
                window.__ha3dCapturedScene = scene;
              }
            } catch (err) {}
            return orig.call(this, scene, camera);
          };
        } catch (err) {}
      }
      var prev = window.__THREE_DEVTOOLS__;
      if (prev && typeof prev.addEventListener === "function") {
        prev.addEventListener("observe", onEvent);
        prev.addEventListener("register", onEvent);
        stats.devtoolsHook = "chained";
      } else {
        var hook = new EventTarget();
        hook.addEventListener("observe", onEvent);
        hook.addEventListener("register", onEvent);
        window.__THREE_DEVTOOLS__ = hook;
        stats.devtoolsHook = "installed";
      }
    } catch (err) {
      stats.lastError = "devtools hook failed: " + String(err);
    }
  })();

  /* --------------------------------------------------------- borrow kit */
  function isUsableShape(C) {
    if (typeof C !== "function") return false;
    var proto = C.prototype;
    if (!proto) return false;
    return typeof proto.moveTo === "function" && typeof proto.quadraticCurveTo === "function";
  }

  function borrowThree(scene) {
    var kit = {
      Group: null, Mesh: null, Vector3: null, Color: null, Matrix4: null,
      BoxGeometry: null, CylinderGeometry: null, ExtrudeGeometry: null, Shape: null,
      MeshPhysicalMaterial: null, MeshToonMaterial: null,
      MeshStandardMaterial: null, MeshBasicMaterial: null,
    };
    try {
      scene.traverse(function (obj) {
        try {
          if (!obj) return;
          if (!kit.Group && obj.isGroup) kit.Group = obj.constructor;
          if (!kit.Mesh && obj.isMesh) kit.Mesh = obj.constructor;
          if (!kit.Vector3 && obj.position) kit.Vector3 = obj.position.constructor;
          if (!kit.Matrix4 && obj.matrixWorld) kit.Matrix4 = obj.matrixWorld.constructor;

          var geo = obj.geometry;
          if (geo) {
            var gn = geo.type || "";
            if (!kit.BoxGeometry && gn === "BoxGeometry") kit.BoxGeometry = geo.constructor;
            if (!kit.CylinderGeometry && gn === "CylinderGeometry") kit.CylinderGeometry = geo.constructor;
            if (!kit.ExtrudeGeometry && gn === "ExtrudeGeometry") kit.ExtrudeGeometry = geo.constructor;
            try {
              var p = geo.parameters || {};
              var shapes = p.shapes;
              var single = p.shape;
              if (!kit.Shape && shapes && shapes.length && shapes[0] && shapes[0].constructor && isUsableShape(shapes[0].constructor)) {
                kit.Shape = shapes[0].constructor;
              }
              if (!kit.Shape && single && single.constructor && isUsableShape(single.constructor)) {
                kit.Shape = single.constructor;
              }
            } catch (e) {}
          }

          var mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
          for (var i = 0; i < mats.length; i += 1) {
            var m = mats[i];
            if (!m || !m.constructor) continue;
            var mn = m.type || "";
            if (!kit.MeshPhysicalMaterial && mn === "MeshPhysicalMaterial") kit.MeshPhysicalMaterial = m.constructor;
            if (!kit.MeshToonMaterial && mn === "MeshToonMaterial") kit.MeshToonMaterial = m.constructor;
            if (!kit.MeshStandardMaterial && mn === "MeshStandardMaterial") kit.MeshStandardMaterial = m.constructor;
            if (!kit.MeshBasicMaterial && mn === "MeshBasicMaterial") kit.MeshBasicMaterial = m.constructor;
            if (!kit.Color && m.color) kit.Color = m.color.constructor;
          }
        } catch (e) {}
      });
    } catch (err) {
      log("borrowThree failed", err);
    }
    return kit;
  }

  /* ------------------------------------------------------- 几何工厂（带回退） */
  function roundedBoxGeometry(T, w, h, d, r) {
    if (!T.ExtrudeGeometry || !isUsableShape(T.Shape)) return new T.BoxGeometry(w, h, d);
    var rCorner = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
    var rBevel = Math.min(r, d / 2 - 0.001);
    if (rCorner <= 0.0005 || rBevel <= 0.0005) return new T.BoxGeometry(w, h, d);

    var sw = w - 2 * rCorner;
    var sh = h - 2 * rCorner;
    var s = new T.Shape();
    var x = -sw / 2;
    var y = -sh / 2;
    s.moveTo(x + rCorner, y);
    s.lineTo(x + sw - rCorner, y);
    s.quadraticCurveTo(x + sw, y, x + sw, y + rCorner);
    s.lineTo(x + sw, y + sh - rCorner);
    s.quadraticCurveTo(x + sw, y + sh, x + sw - rCorner, y + sh);
    s.lineTo(x + rCorner, y + sh);
    s.quadraticCurveTo(x, y + sh, x, y + sh - rCorner);
    s.lineTo(x, y + rCorner);
    s.quadraticCurveTo(x, y, x + rCorner, y);

    var geo = new T.ExtrudeGeometry(s, {
      depth: d - 2 * rBevel,
      bevelEnabled: true,
      bevelSize: rBevel,
      bevelThickness: rBevel,
      bevelSegments: 2,
      curveSegments: 4,
      steps: 1,
    });
    geo.center();
    if (typeof geo.computeBoundingBox === "function" && geo.boundingBox) {
      var bb = geo.boundingBox;
      var sx = bb.max.x - bb.min.x;
      var sy = bb.max.y - bb.min.y;
      var sz = bb.max.z - bb.min.z;
      if (sx > 0 && sy > 0 && sz > 0) geo.scale(w / sx, h / sy, d / sz);
    }
    return geo;
  }

  /* -------------------------------------------------------------- 材质 */
  function woodMaterial(T, color) {
    if (T.MeshStandardMaterial) {
      return new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.75, metalness: 0 });
    }
    return null;
  }

  function paintMaterial(T, color) {
    if (T.MeshPhysicalMaterial) {
      return new T.MeshPhysicalMaterial({
        color: new T.Color(color),
        roughness: 0.45,
        metalness: 0,
        clearcoat: 0.25,
        clearcoatRoughness: 0.5,
      });
    }
    return woodMaterial(T, color);
  }

  function frameMaterial(T) {
    if (T.MeshStandardMaterial) {
      return new T.MeshStandardMaterial({ color: new T.Color(BLACK), roughness: 0.4, metalness: 0.2 });
    }
    return null;
  }

  function glassMaterial(T) {
    if (T.MeshPhysicalMaterial) {
      return new T.MeshPhysicalMaterial({
        color: new T.Color(GLASS_TINT),
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.3,
      });
    }
    return null;
  }

  /* ------------------------------------------------ 拾取的参数颜色 */
  function hexColorOf(entry, key) {
    var rec = entry && entry.furniture;
    var raw = rec && rec[key];
    if (typeof raw !== "string") return null;
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null;
  }

  /* -------------------------------------------------------------- 模型 */
  function buildSideboard(T, doorHex, cabHex) {
    var group = new T.Group();
    group.name = "ha3d-sideboard";

    var doorColor = parseInt((doorHex || DEFAULT_DOOR_HEX).slice(1), 16);
    var cabColor = parseInt((cabHex || DEFAULT_CAB_HEX).slice(1), 16);
    var wood = woodMaterial(T, cabColor);
    var cream = paintMaterial(T, doorColor);
    var black = frameMaterial(T) || wood;
    var glass = glassMaterial(T);

    var fall = T.BoxGeometry;

    /* ---------------------------------------------------------------
     * X 轴镜像开关（MIRROR_X = -1）。
     *
     * 需求：参考图里**玻璃展示柜门在柜子的左边**（正面视角）。本模型
     * 最初把玻璃塔建在 −X 侧，正面看时落在画面右边，与参考图相反。
     *
     * 为什么用「坐标镜像」而不是 scale.x = -1 / rotation.y = π：
     *   - scale.x = -1 是负缩放，会翻转三角形绕序 → 法线朝内 → 背面剔除
     *     → 柜体「半透明 / 穿模」（与洗衣机那次事故同类）；
     *   - rotation.y = π 会把**正面也转过去**，门会跑到背面去；
     *   - 坐标镜像只改 position，不动任何几何 → 绕序 / 法线 / 描边全部不变，
     *     且各部件的相对关系（玻璃塔 ↔ 木纹侧板、开放格 ↔ 玻璃塔、
     *     下柜上下 2 扇门 ↔ 远离玻璃的一端）自动保持不变。
     * --------------------------------------------------------------- */
    var MIRROR_X = -1;

    function part(w, h, d, x, y, z, mat, radius) {
      var geo;
      try {
        geo = roundedBoxGeometry(T, w, h, d, radius === undefined ? 0.004 : radius);
      } catch (err) {
        geo = new fall(w, h, d);
      }
      var mesh = new T.Mesh(geo, mat);
      mesh.position.set(MIRROR_X * x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    }

    function centerX(x0, x1) { return (x0 + x1) / 2; }
    function spanY(y0, y1) { return (y0 + y1) / 2; }
    function colX(i) { return centerX(GLASS_X0 + i * DIM.colW, GLASS_X0 + (i + 1) * DIM.colW); }
    var doorW = DIM.colW - DIM.seam;

    /* --- 地脚封边（一圈，木色） --- */
    var footY = DIM.footHeight / 2;
    var footSpanD = TOTAL_D - 2 * DIM.footT;
    part(TOTAL_W, DIM.footHeight, DIM.footT, 0, footY, -(TOTAL_D / 2 - DIM.footT / 2), wood);
    part(TOTAL_W, DIM.footHeight, DIM.footT, 0, footY, TOTAL_D / 2 - DIM.footT / 2, wood);
    part(DIM.footT, DIM.footHeight, footSpanD, X_LEFT + DIM.footT / 2, footY, 0, wood);
    part(DIM.footT, DIM.footHeight, footSpanD, X_RIGHT - DIM.footT / 2, footY, 0, wood);

    /* --- 左右两侧端板：与柜框完全同色（木色） ---
     * 右侧端板原先是奶白色，从背面视角看会紧贴"中间开放隔"，
     * 容易被误读成隔板是白的。现在只有**门板**用奶白，
     * 其余一切（端板 / 侧板 / 背板 / 隔板 / 台面 / 地脚 / 顶封板）统一木色。 */
    var sideH = BODY_TOP - BODY_BOTTOM;
    part(DIM.panelT + 0.002, sideH, BODY_D, X_LEFT + 0.011, spanY(BODY_BOTTOM, BODY_TOP), BODY_CENTER_Z, wood);
    part(DIM.panelT + 0.002, sideH, BODY_D, X_RIGHT - 0.011, spanY(BODY_BOTTOM, BODY_TOP), BODY_CENTER_Z, wood);

    /* --- 左玻璃展示塔（内空 + 隔板） --- */
    var gInX0 = X_LEFT + 0.022;
    var gInX1 = GLASS_X0 - 0.002;
    var gW = gInX1 - gInX0;
    var gCX = centerX(gInX0, gInX1);
    // 右分隔板
    part(DIM.panelT, sideH, BODY_D, GLASS_X0 - DIM.panelT / 2, spanY(BODY_BOTTOM, BODY_TOP), BODY_CENTER_Z, wood);
    // 顶板 / 底板
    part(gW, DIM.panelT, BODY_D, gCX, BODY_TOP - DIM.panelT / 2, BODY_CENTER_Z, wood);
    part(gW, DIM.panelT, BODY_D, gCX, BODY_BOTTOM + DIM.panelT / 2, BODY_CENTER_Z, wood);
    // 背板（深一档，玻璃后可见层次）
    part(gW, sideH - 2 * DIM.panelT, DIM.panelT, gCX, spanY(BODY_BOTTOM, BODY_TOP), TOTAL_D / 2 - DIM.panelT / 2, wood);
    // 4 片水平隔板
    var shelfYs = [0.65, 1.15, 1.65, 2.05];
    for (var si = 0; si < shelfYs.length; si += 1) {
      part(gW - 0.01, DIM.panelT, BODY_D - 0.02, gCX, shelfYs[si], BODY_CENTER_Z, wood);
    }

    /* --- 玻璃门黑框 + 玻璃片 --- */
    part(DIM.frameT, sideH, DIM.depthDoor, X_LEFT + DIM.frameT / 2, spanY(BODY_BOTTOM, BODY_TOP), DOOR_CENTER_Z, black);
    part(DIM.frameT, sideH, DIM.depthDoor, GLASS_X0 - DIM.frameT / 2, spanY(BODY_BOTTOM, BODY_TOP), DOOR_CENTER_Z, black);
    var frameSpanW = DIM.glassZoneW - 2 * DIM.frameT;
    var frameCX = X_LEFT + DIM.glassZoneW / 2;
    part(frameSpanW, DIM.frameT, DIM.depthDoor, frameCX, BODY_TOP - DIM.frameT / 2, DOOR_CENTER_Z, black);
    part(frameSpanW, DIM.frameT, DIM.depthDoor, frameCX, BODY_BOTTOM + DIM.frameT / 2, DOOR_CENTER_Z, black);
    part(frameSpanW, DIM.frameMidT, DIM.depthDoor, frameCX, GLASS_SPLIT_Y, DOOR_CENTER_Z, black);
    if (glass) {
      part(frameSpanW, sideH - 2 * DIM.frameT, 0.004, frameCX, spanY(BODY_BOTTOM, BODY_TOP), GLASS_Z, glass, 0.002);
    }

    /* --- 右上柜体 + 4 扇封闭柜门 --- */
    var upY0 = MID_TOP;
    var upY1 = BODY_TOP;
    part(TOTAL_W - DIM.glassZoneW, upY1 - upY0, BODY_D, centerX(GLASS_X0, X_RIGHT), spanY(upY0, upY1), BODY_CENTER_Z, wood);
    for (var ui = 0; ui < 4; ui += 1) {
      part(doorW, upY1 - upY0 - DIM.seam, DIM.depthDoor, colX(ui), spanY(upY0 + DIM.seam / 2, upY1 - DIM.seam / 2), DOOR_CENTER_Z, cream, 0.008);
    }

    /* --- 开放格（镂空凹槽，跨左 2 列，前开口） --- */
    var nX0 = GLASS_X0;
    var nX1 = GLASS_X0 + 2 * DIM.colW;
    var nW = nX1 - nX0;
    var nCX = centerX(nX0, nX1);
    part(nW, DIM.panelT, BODY_D, nCX, NICHE_BOT + DIM.panelT / 2, BODY_CENTER_Z, wood);
    part(nW, DIM.panelT, BODY_D, nCX, NICHE_TOP - DIM.panelT / 2, BODY_CENTER_Z, wood);
    part(DIM.panelT, NICHE_TOP - NICHE_BOT - 2 * DIM.panelT, BODY_D, nX0 + DIM.panelT / 2, spanY(NICHE_BOT + DIM.panelT, NICHE_TOP - DIM.panelT), BODY_CENTER_Z, wood);
    part(DIM.panelT, NICHE_TOP - NICHE_BOT - 2 * DIM.panelT, BODY_D, nX1 - DIM.panelT / 2, spanY(NICHE_BOT + DIM.panelT, NICHE_TOP - DIM.panelT), BODY_CENTER_Z, wood);
    part(nW - 2 * DIM.panelT, NICHE_TOP - NICHE_BOT - 2 * DIM.panelT, DIM.panelT, nCX, spanY(NICHE_BOT + DIM.panelT, NICHE_TOP - DIM.panelT), TOTAL_D / 2 - DIM.panelT / 2, wood);

    /* --- 中段：背板 + 台面 --- */
    part(TOTAL_W - DIM.glassZoneW, MID_TOP - COUNTER_TOP, DIM.panelT, centerX(GLASS_X0, X_RIGHT), spanY(COUNTER_TOP, MID_TOP), TOTAL_D / 2 - DIM.panelT / 2, wood);
    part(TOTAL_W - DIM.glassZoneW, DIM.panelT, BODY_D, centerX(GLASS_X0, X_RIGHT), COUNTER_BOT + DIM.panelT / 2, BODY_CENTER_Z, wood);

    /* --- 下方柜体 + 3 扇大柜门 + 右侧上下 2 扇 --- */
    var loY0 = BODY_BOTTOM;
    var loY1 = LOWER_TOP;
    part(TOTAL_W - DIM.glassZoneW, loY1 - loY0, BODY_D, centerX(GLASS_X0, X_RIGHT), spanY(loY0, loY1), BODY_CENTER_Z, wood);
    for (var li = 0; li < 3; li += 1) {
      part(doorW, loY1 - loY0 - DIM.seam, DIM.depthDoor, colX(li), spanY(loY0 + DIM.seam / 2, loY1 - DIM.seam / 2), DOOR_CENTER_Z, cream, 0.008);
    }
    // 最右列上下 2 扇
    var splitMid = (loY0 + loY1) / 2;
    part(doorW, splitMid - loY0 - DIM.seam, DIM.depthDoor, colX(3), spanY(loY0 + DIM.seam / 2, splitMid - DIM.seam / 2), DOOR_CENTER_Z, cream, 0.008);
    part(doorW, loY1 - splitMid - DIM.seam, DIM.depthDoor, colX(3), spanY(splitMid + DIM.seam / 2, loY1 - DIM.seam / 2), DOOR_CENTER_Z, cream, 0.008);

    /* --- 顶封板（通长，木色） --- */
    part(TOTAL_W, DIM.topCapT, TOTAL_D, 0, TOTAL_H - DIM.topCapT / 2, 0, wood);

    group.userData[MODEL_FLAG] = true;
    return group;
  }

  /* --------------------------------------------------------- 项目数据 */
  var project = null;
  var entries = {};

  function isOwnPart(obj) {
    var node = obj;
    while (node) {
      if (node.userData && node.userData[MODEL_FLAG]) return true;
      node = node.parent;
    }
    return false;
  }

  function collectEntries() {
    var map = {};
    if (!project || !project.floors) {
      entries = map;
      return;
    }
    project.floors.forEach(function (floor) {
      (floor.furniture || []).forEach(function (item) {
        if (!item || MODEL_IDS.indexOf(item.modelId) < 0) return;
        if (!item.position || item.position.length < 2) return;
        var rot = typeof item.rotation === "number" ? item.rotation : 0;
        map["furniture:" + item.id] = {
          key: "furniture:" + item.id,
          furniture: item,
          floor: floor,
          device: {
            position: [item.position[0], 0, item.position[1]],
            rotation: [0, -rot, 0], // 编辑器以 -rotation 渲染家具
          },
        };
      });
    });
    entries = map;
  }

  function setProject(next) {
    if (!next || !next.floors) return;
    project = next;
    collectEntries();
    stats.entries = Object.keys(entries).length;
    log("project loaded, sideboard entries:", stats.entries);
  }

  function loadProject() {
    var snap = window.ha3dProjectSnapshot;
    if (snap) {
      snap.subscribe(applySnapshot);
      snap.request();
      return;
    }
    fetch(apiBase() + "/api/projects/current", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (res) { setProject(res && (res.project || res)); })
      .catch(function (e) { stats.lastError = "project load failed: " + String(e); });
  }

  function applySnapshot(projectOrRes) {
    setProject(projectOrRes && (projectOrRes.project || projectOrRes));
  }

  function connectWs() {
    var url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + apiBase() + "/ws";
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return; }
    ws.addEventListener("open", function () {
      try { ws.send(JSON.stringify({ type: "project.subscribe", requestId: "ha3d-sideboard" })); } catch (e) {}
    });
    ws.addEventListener("message", function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg && msg.type === "project.updated") setProject(msg.payload);
      } catch (err) {}
    });
    ws.addEventListener("close", function () { window.setTimeout(connectWs, 3000); });
  }

  /* --------------------------------------------------------- 世界包围盒 */
  function worldBounds(T, obj) {
    var geo = obj.geometry;
    if (!geo) return null;
    try {
      if (!geo.boundingBox && geo.computeBoundingBox) geo.computeBoundingBox();
      if (!geo.boundingBox) return null;
      obj.updateWorldMatrix(true, false);
      var bb = geo.boundingBox;
      var min = new T.Vector3(1e9, 1e9, 1e9);
      var max = new T.Vector3(-1e9, -1e9, -1e9);
      var c = new T.Vector3();
      for (var i = 0; i < 8; i += 1) {
        c.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(obj.matrixWorld);
        min.min(c);
        max.max(c);
      }
      return { min: min, max: max };
    } catch (err) {
      return null;
    }
  }

  /* Vector3 无下标访问，六个分量必须逐个展开。 */
  function worldBoundsOfObject(T, root) {
    var min = new T.Vector3(1e9, 1e9, 1e9);
    var max = new T.Vector3(-1e9, -1e9, -1e9);
    var found = false;
    root.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      var b = worldBounds(T, o);
      if (!b) return;
      found = true;
      if (b.min.x < min.x) min.x = b.min.x;
      if (b.min.y < min.y) min.y = b.min.y;
      if (b.min.z < min.z) min.z = b.min.z;
      if (b.max.x > max.x) max.x = b.max.x;
      if (b.max.y > max.y) max.y = b.max.y;
      if (b.max.z > max.z) max.z = b.max.z;
    });
    return found ? { min: min, max: max } : null;
  }

  /* --------------------------------- 宿主认领（旋转不变区间足迹判据） */
  var adoptedByUid = {}; // uid -> { container, stock, entry, kit }

  function hostLocked(uid) {
    var a = adoptedByUid[uid];
    return !!(a && a.stock && a.stock.obj && a.stock.obj.parent);
  }

  function footprintOk(box, rw, rd) {
    var sx = box.max.x - box.min.x;
    var sy = box.max.y - box.min.y;
    var sz = box.max.z - box.min.z;
    if (Math.max(sx, sy, sz) > 4 || Math.min(sx, sy, sz) < 0.05) return false;
    /* 旋转不变判据：AABB 水平对角线随 θ∈[0°,45°] 从 √(w²+d²) 增到 w+d，
     * 必须接受整个区间，不能等值判定（否则 ~45° 认不到宿主 → 漂移）。 */
    var diagBox = Math.sqrt(sx * sx + sz * sz);
    var diagRec = Math.sqrt(rw * rw + rd * rd);
    var diagMax = rw + rd;
    if (diagBox < diagRec - 0.5 || diagBox > diagMax + 0.5) return false;
    if (sx > diagMax + 0.25 || sz > diagMax + 0.25) return false;
    return true;
  }

  function findStockAnchor(T, scene, entry, claimedUid) {
    var rec = entry.furniture || {};
    var rw = typeof rec.width === "number" ? rec.width : TOTAL_W;
    var rd = typeof rec.depth === "number" ? rec.depth : TOTAL_D;
    var px = entry.device.position ? entry.device.position[0] : null;
    var pz = entry.device.position ? entry.device.position[2] : null;
    if (px === null || pz === null) return null;

    function isOwnGroup(g) {
      if (!g || !g.userData) return false;
      return g.userData[STANDALONE_FLAG] || g.userData[MODEL_FLAG];
    }

    var best = null;
    var bestScore = Infinity;

    /* 第 1 层：SPA 用 focusEntityId 标记原生家具组，直接命中（最可靠，
     * 不依赖包围盒形状，也天然旋转无关）。 */
    scene.traverse(function (obj) {
      if (best) return;
      if (!(obj.isGroup || obj.type === "Group")) return;
      if (isOwnPart(obj) || isOwnGroup(obj)) return;
      var ud0 = obj.userData || {};
      var fid = ud0.focusEntityId;
      if (fid !== entry.key && !(rec && fid === rec.id)) return;
      if (ud0.ha3dStockHidden) return;
      var claim0 = ud0[STOCK_CLAIM];
      if (claim0 && claim0 !== claimedUid) return;
      var box0 = worldBoundsOfObject(T, obj);
      if (!box0) return;
      best = { obj: obj, min: box0.min };
    });
    if (best) return best;

    /* 第 2 层：本地坐标 ≈ 记录坐标 + 旋转不变区间足迹判据。 */
    scene.traverse(function (obj) {
      if (!(obj.isGroup || obj.type === "Group")) return;
      if (isOwnPart(obj) || isOwnGroup(obj)) return;
      var ud = obj.userData || {};
      if (ud.ha3dModelStandalone) return;
      var claim = ud[STOCK_CLAIM];
      if (claim && claim !== claimedUid) return;   // 别的记录/补丁占用
      var lx = obj.position ? obj.position.x : 0;
      var lz = obj.position ? obj.position.z : 0;
      if (Math.abs(lx - px) > 0.35 || Math.abs(lz - pz) > 0.35) return;
      var box = worldBoundsOfObject(T, obj);
      if (!box || !footprintOk(box, rw, rd)) return;
      var score = Math.sqrt((lx - px) * (lx - px) + (lz - pz) * (lz - pz));
      if (score < bestScore) { bestScore = score; best = { obj: obj, min: box.min }; }
    });

    /* 第 3 层兜底：按足迹匹配单个 mesh（不含位置约束，但尽量接近记录坐标）。
     * 与 sofa / nested 同款，保证组级匹配落空时仍能找到原生模型隐藏。 */
    if (!best) {
      scene.traverse(function (obj) {
        if (isOwnPart(obj) || isOwnGroup(obj)) return;
        var udm = obj.userData || {};
        if (udm[STOCK_CLAIM] || udm.ha3dStockHidden) return;
        var b = worldBounds(T, obj);
        if (!b) return;
        var sx = b.max.x - b.min.x;
        var sy = b.max.y - b.min.y;
        var sz = b.max.z - b.min.z;
        if (Math.max(sx, sy, sz) > 4 || Math.min(sx, sy, sz) < 0.03) return;
        var horiz =
          (Math.abs(sx - rw) < 0.12 && Math.abs(sz - rd) < 0.12) ||
          (Math.abs(sx - rd) < 0.12 && Math.abs(sz - rw) < 0.12);
        if (!horiz) return;
        var score = 0;
        if (px !== null && pz !== null) {
          var cx = (b.min.x + b.max.x) / 2;
          var cz = (b.min.z + b.max.z) / 2;
          score = Math.sqrt((cx - px) * (cx - px) + (cz - pz) * (cz - pz));
        }
        if (score < bestScore) {
          bestScore = score;
          best = { obj: obj, min: b.min };
        }
      });
    }
    return best;
  }

  /* ------------------------------------------- 三层隐藏：第 2 层 mesh 形状 */
  function hideStockMeshes(T, scene, entry, uid, wp) {
    var rec = entry.furniture || {};
    var rw = typeof rec.width === "number" ? rec.width : TOTAL_W;
    var rd = typeof rec.depth === "number" ? rec.depth : TOTAL_D;
    var rh = typeof rec.height === "number" ? rec.height : TOTAL_H;
    var px = wp ? wp.x : entry.device.position ? entry.device.position[0] : null;
    var pz = wp ? wp.z : entry.device.position ? entry.device.position[2] : null;
    if (px === null || pz === null) return 0;

    var tol = Math.max(0.25, Math.min(rw, rd) * 0.35);
    var footTol = Math.max(0.12, Math.min(rw, rd) * 0.28);
    var hidden = 0;

    scene.traverse(function (obj) {
      if (!obj.isMesh || !obj.geometry) return;
      if (isOwnPart(obj)) return;
      var ud = obj.userData || {};
      if (ud[MODEL_FLAG] || ud[STANDALONE_FLAG]) return;
      if (ud[STOCK_CLAIM] === uid) return; // 自己已藏
      if (
        ud.ha3dStockHidden || ud.ha3dDiningStockHidden || ud.ha3dWasherStockHidden ||
        ud.ha3dSofaStockHidden || ud.ha3dNestedStockHidden || ud.ha3dFridgeStockHidden
      ) return; // 别的补丁占用
      var mat = obj.material;
      if (mat && mat.transparent && mat.opacity === 0) return; // 透明 hitbox 保留

      var b = worldBounds(T, obj);
      if (!b) return;
      var sx = b.max.x - b.min.x;
      var sy = b.max.y - b.min.y;
      var sz = b.max.z - b.min.z;
      if (!(sx > 0) || !(sz > 0)) return;
      if (Math.max(sx, sy, sz) > 4 || Math.min(sx, sy, sz) < 0.03) return;
      if (b.max.y > rh + 0.6) return;
      if (sy > rh * 1.6) return;

      var cx = (b.min.x + b.max.x) / 2;
      var cz = (b.min.z + b.max.z) / 2;
      if (Math.abs(cx - px) > tol || Math.abs(cz - pz) > tol) return;

      // 高柜体形：覆盖大半足迹、有实质厚度
      if (sy < 0.12) return;
      if (sx < rw * 0.45 || sz < rd * 0.45) return;
      if (b.min.y > 0.35) return;

      var nearSquare = Math.abs(sx - sz) < 0.06;
      var match =
        (Math.abs(sx - rw) < footTol && Math.abs(sz - rd) < footTol) ||
        (Math.abs(sx - rd) < footTol && Math.abs(sz - rw) < footTol) ||
        (nearSquare && Math.abs((sx + sz) / 2 - (rw + rd) / 2) < footTol * 1.6);
      if (!match) return;

      if (!obj.userData) obj.userData = {};
      obj.userData[STOCK_CLAIM] = uid;
      if (obj.visible) {
        obj.visible = false;
        hidden += 1;
      }
    });

    if (hidden) stats.hiddenStock += hidden;
    return hidden;
  }

  /* ----------------------------------------------------- 变换采纳 / 帧驱动 */
  function adoptStockTransform(T, container, stock, entry, uid) {
    try {
      stock.obj.updateWorldMatrix(true, false);
      var wp = stock.obj.getWorldPosition(new T.Vector3());
      var wq = stock.obj.getWorldQuaternion(new (stock.obj.quaternion.constructor)());
      var parent = container.parent;
      var inv = null;
      if (parent && T.Matrix4) {
        parent.updateWorldMatrix(true, false);
        inv = new T.Matrix4().copy(parent.matrixWorld).invert();
        wp.applyMatrix4(inv);
        var pq = new (stock.obj.quaternion.constructor)();
        parent.matrixWorld.decompose(new T.Vector3(), pq, new T.Vector3());
        wq.premultiply(pq.clone().invert());
      }
      /* 贴地对齐宿主原点的 y（地面），不用 AABB 最低点。 */
      var groundWorldY = stock.obj.getWorldPosition(new T.Vector3()).y;
      var baseY = inv ? new T.Vector3(0, groundWorldY, 0).applyMatrix4(inv).y : groundWorldY;

      var nums = [wp.x, wp.y, baseY, wp.z, wq.x, wq.y, wq.z, wq.w];
      for (var i = 0; i < nums.length; i += 1) {
        if (typeof nums[i] !== "number" || !isFinite(nums[i])) {
          stats.lastError = "adoptStockTransform: non-finite transform (index " + i + ")";
          return false;
        }
      }

      var rec = entry.furniture || {};
      if (typeof rec.width === "number" && typeof rec.height === "number" && typeof rec.depth === "number") {
        var sx = rec.width / TOTAL_W;
        var sy = rec.height / TOTAL_H;
        var sz = rec.depth / TOTAL_D;
        if (isFinite(sx) && isFinite(sy) && isFinite(sz) && sx > 0 && sy > 0 && sz > 0) {
          container.scale.set(sx, sy, sz);
        }
      }

      container.position.copy(wp);
      container.position.y = baseY;
      container.quaternion.copy(wq);
      claimStock(stock, uid);
      return true;
    } catch (err) {
      log("adoptStockTransform failed", err);
      return false;
    }
  }

  function claimStock(stock, uid) {
    if (!stock || !stock.obj) return;
    if (!stock.obj.userData) stock.obj.userData = {};
    stock.obj.userData[STOCK_CLAIM] = uid;
    if (stock.obj.visible) {
      stock.obj.visible = false;
      stats.hiddenStock += 1;
    }
  }

  function frameSync() {
    var keys = Object.keys(adoptedByUid);
    for (var i = 0; i < keys.length; i += 1) {
      var a = adoptedByUid[keys[i]];
      if (!a || !a.stock || !a.kit) continue;
      var host = a.stock && a.stock.obj;
      if (host && !host.parent) continue; // 宿主被 React 重建 → 等下一轮认领
      if (!a.container.parent) continue;
      adoptStockTransform(a.kit, a.container, a.stock, a.entry, keys[i]);
    }
  }

  function publishFrameSync() {
    var fix = window.__ha3dSceneOriginFix;
    if (fix && fix.register) fix.register(SCAN_KEY, frameSync);
  }

  function syncStandaloneTransform(container, entry) {
    var pos = entry.device.position || [0, 0, 0];
    container.position.set(pos[0], pos[1] || 0, pos[2] || 0);
    var rot = entry.device.rotation;
    if (Array.isArray(rot)) container.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  }

  function standaloneContainer(T, scene, entry) {
    var uid = entry.key;
    var key = "ha3d-sideboard-standalone:" + uid;
    var existing = null;
    scene.traverse(function (obj) {
      if (!existing && obj.name === key) existing = obj;
    });
    if (existing) return existing;

    var container = new T.Group();
    container.name = key;
    container.userData.focusEntityId = uid;
    container.userData[STANDALONE_FLAG] = true;
    syncStandaloneTransform(container, entry);
    scene.add(container);
    log("standalone sideboard container created for", uid);
    return container;
  }

  function disposeModel(model) {
    try {
      var seen = [];
      model.traverse(function (obj) {
        if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
        if (obj.material) {
          var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (var i = 0; i < mats.length; i += 1) {
            var m = mats[i];
            if (!m || seen.indexOf(m) >= 0) continue;
            seen.push(m);
            if (m.dispose) m.dispose();
          }
        }
      });
      if (model.parent) model.parent.remove(model);
    } catch (err) {}
  }

  function attachModel(T, container, entry) {
    var styleName = currentStyle();
    var door = hexColorOf(entry, "doorColor") || "";
    var cab = hexColorOf(entry, "cabinetColor") || "";
    var existing = null;
    container.children.forEach(function (child) {
      if (!existing && child.userData && child.userData[MODEL_FLAG]) existing = child;
    });
    if (existing) {
      var unchanged =
        existing.userData.ha3dSideboardStyle === styleName &&
        (existing.userData.ha3dSideboardDoor || "") === door &&
        (existing.userData.ha3dSideboardCab || "") === cab;
      if (unchanged) {
        if (window.ha3dModelLift) window.ha3dModelLift.sync(existing, entry);
        return false;
      }
      disposeModel(existing);
    }
    var model = buildSideboard(T, door || null, cab || null);
    model.userData.ha3dSideboardStyle = styleName;
    model.userData.ha3dSideboardDoor = door;
    model.userData.ha3dSideboardCab = cab;
    model.position.set(0, 0, MODEL_Z_OFFSET);
    if (window.ha3dModelLift) window.ha3dModelLift.applyY(model, entry, 0);
    model.rotation.set(0, MODEL_YAW, 0);
    container.add(model);
    return true;
  }

  /* ----------------------------------------------------------- 同步循环 */
  function syncScene() {
    stats.runs += 1;
    try {
      syncSceneInner();
    } catch (err) {
      stats.lastError = "syncScene threw: " + String(err && err.message ? err.message : err);
      stats.lastStack = err && err.stack ? String(err.stack).slice(0, 400) : null;
    }
  }

  function syncSceneInner() {
    publishFrameSync(); // 幂等：保证帧驱动一定注册上
    var scene = capturedScene;
    if (!scene) {
      stats.lastError = "no scene captured yet (renderer hook has not fired)";
      return;
    }
    var shared = window.__ha3dCapturedScene;
    if (!scene && shared && shared.isScene) scene = shared;
    stats.storeRoute = "renderer-hook";

    var ids = Object.keys(entries);
    stats.entries = ids.length;
    if (!ids.length) {
      stats.lastError = "no sideboard entries in the project";
      return;
    }

    var T = borrowThree(scene);
    var fatal = [];
    if (!T.Group) fatal.push("Group");
    if (!T.Mesh) fatal.push("Mesh");
    if (!T.Vector3) fatal.push("Vector3");
    if (!T.Color) fatal.push("Color");
    if (!T.BoxGeometry && !T.ExtrudeGeometry) fatal.push("no geometry class at all");
    stats.kitMissing = fatal.length ? fatal.join(",") : null;
    if (fatal.length) {
      stats.lastError = "three constructors unavailable: " + stats.kitMissing;
      return;
    }
    stats.degraded = { shape: !T.Shape, extrude: !T.ExtrudeGeometry };

    var changed = false;
    ids.forEach(function (uid) {
      var entry = entries[uid];
      var target = standaloneContainer(T, scene, entry);

      var extras = [];
      target.children.forEach(function (child) {
        if (child.userData && child.userData[MODEL_FLAG]) extras.push(child);
      });
      while (extras.length > 1) disposeModel(extras.pop());

      if (attachModel(T, target, entry)) changed = true;

      /* 宿主认领：已锁定沿用；找不到宿主**不要**写回静态记录坐标（会弹飞）。 */
      var prev = adoptedByUid[uid];
      var stock = hostLocked(uid)
        ? prev.stock
        : findStockAnchor(T, scene, entry, uid);
      if (stock && adoptStockTransform(T, target, stock, entry, uid)) {
        changed = true;
        adoptedByUid[uid] = { container: target, stock: stock, entry: entry, kit: T };
      } else if (!stock && !prev) {
        syncStandaloneTransform(target, entry); // 仅首次兜底
      }

      // 第 2 层隐藏每 tick 重跑：React 会重建原生 mesh
      var wp = null;
      if (stock) {
        try {
          stock.obj.updateWorldMatrix(true, false);
          wp = stock.obj.getWorldPosition(new T.Vector3());
        } catch (e) {
          wp = null;
        }
      }
      var n = hideStockMeshes(T, scene, entry, uid, wp);
      if (n) changed = true;
    });

    // 孤儿清理：记录已从 project 删除 → 释放 GPU 资源并移除空容器
    // （两阶段：先收集再清理，避免在 scene.traverse 回调里改 scene.children 导致漏清）
    var _orphans = [];
    scene.traverse(function (o) {
      if (o.userData && o.userData["ha3dSideboardStandalone"] && o.userData.focusEntityId) {
        var _uid = o.userData.focusEntityId;
        if (!entries[_uid]) _orphans.push(o);
      }
    });
    _orphans.forEach(function (o) {
      o.children.slice().forEach(function (ch) {
        if (ch.userData && ch.userData[MODEL_FLAG]) disposeModel(ch);
      });
      if (o.parent) o.parent.remove(o);
    });
    stats.attached = ids.length;
    stats.models = 0;
    scene.traverse(function (o) {
      if (o.userData && o.userData[MODEL_FLAG]) stats.models += 1;
    });
    stats.lastError = null;
    if (changed) {
      try {
        if (window.__ha3dCapturedScene && window.__ha3dCapturedScene.dispatchEvent) {
          window.__ha3dCapturedScene.dispatchEvent({ type: "change" });
        }
      } catch (err) {}
    }
  }

  window.ha3dSideboardProbe = function () {
    return {
      version: VERSION,
      captured: !!capturedScene,
      entries: Object.keys(entries).length,
      attached: stats.attached,
      models: stats.models,
      hiddenStock: stats.hiddenStock,
      kitMissing: stats.kitMissing,
      degraded: stats.degraded || null,
      devtoolsHook: stats.devtoolsHook,
      storeRoute: stats.storeRoute,
      lastError: stats.lastError,
      lastStack: stats.lastStack || null,
    };
  };

  function start() {
    loadProject();
    connectWs();
    publishFrameSync();
    window.setInterval(syncScene, SCAN_INTERVAL);
    window.setTimeout(syncScene, 1200); // 首帧不等轮询
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
