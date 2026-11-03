/*
 * 原木风双人拉点布艺沙发 3D 模型（运行时补丁）。
 *
 * Record shape: carrier kind "sofa" (SPA 白名单内，会被原生渲染成自带沙发 →
 * 必须三层隐藏) + modelId "furniture.fabric_sofa"。纯 furniture 路径 A，
 * 不绑定 HA 实体。
 *
 * 结构：胡桃木底框 + 5 脚 + 左右侧封板，上面叠米白布艺的 2 坐垫 / 2 拉点
 * 靠背 / 左右扶手软垫。坐标原点 = 足迹中心地面点；几何按坐面朝 +Z 建模，
 * MODEL_YAW = π 后渲染朝向为 -Z（面向房间内侧，与 SPA 原生家具一致）。
 * 这是历史写法；新模型一律把几何直接建在 -Z、原点居中，
 * MODEL_YAW / MODEL_Z_OFFSET 均为 0（ha3d-model-modeling §6.1）。
 * 特殊材质：三套 visualStyle 下统一布艺 + 胡桃木 + 细描边。
 *
 * Debug: window.ha3dSofaProbe()
 */
(function () {
  "use strict";

  var MODEL_IDS = ["furniture.fabric_sofa"];
  var STYLE_KEY = "ha3d.home.sceneVisualStyle";
  var MODEL_FLAG = "ha3dSofa";
  var STOCK_CLAIM = "ha3dSofaStockHidden"; // 专属占用标记，不与 fridge/dining 共用
  var VERSION = 2;

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
  window.ha3dSofaDebug = stats;

  /* ------------------------------------------------------------ 尺寸（米） */
  var DIM = {
    width: 2.2,          // 整体外宽
    depth: 0.95,         // 整体外深
    height: 0.82,        // 整体外高
    legHeight: 0.15,
    legRadius: 0.03,
    frameThickness: 0.06,
    sideHeight: 0.65,
    sideThickness: 0.04,
    seatWidth: 1.05,
    seatDepth: 0.775,    // 前端对齐底框前沿，后端止于靠背前面
    seatThickness: 0.18,
    seatTopY: 0.42,      // 坐面离地高
    backHeight: 0.4,     // 坐垫顶(0.42) → 0.82
    backDepth: 0.22,
    armWidth: 0.28,
    armHeight: 0.48,
    tuftSize: 0.14,
    tuftStep: 0.155,
  };

  var TOTAL_HEIGHT = DIM.height; // 0.82
  var TOTAL_DEPTH = DIM.depth;   // 0.95
  var TOTAL_WIDTH = DIM.width;   // 2.20
  var FRAME_TOP_Y = DIM.legHeight + DIM.frameThickness; // 0.21
  /* 几何按坐面朝 +Z 建模；翻 180° 后渲染朝向为 -Z（面向房间内侧），
   * 与 SPA 原生家具一致。原点在包围盒中心（z=0），翻转对称，
   * 因此不需要 Z 中心补偿（MODEL_Z_OFFSET = 0）。 */
  var MODEL_YAW = Math.PI;
  var MODEL_Z_OFFSET = 0;

  var SCAN_INTERVAL = 700;

  /* ------------------------------------------------------------ 工具 */
  function log() {
    if (!window.HA3D_SOFA_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home sofa]"].concat([].slice.call(arguments)));
    } catch (e) {}
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
          if (renderer.__ha3dSofaHooked) return;
          renderer.__ha3dSofaHooked = true;
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

  /* 圆柱：CylinderGeometry 缺失时退化为 48 边手写棱柱（借 BoxGeometry 的
   * BufferGeometry 底座），绝不因为缺构造器而放弃整个模型。 */
  function cylinderGeometry(T, radius, height, segments) {
    if (T.CylinderGeometry) return new T.CylinderGeometry(radius, radius, height, segments || 32);
    try {
      var probe = new T.BoxGeometry(0.01, 0.01, 0.01);
      var battr = probe.attributes.position.constructor;
      var bgeo = Object.getPrototypeOf(probe.constructor);
      probe.dispose();

      var n = 48;
      var positions = [];
      var indices = [];
      var i;
      var k;
      // 两圈顶点：0..n-1 = 底圈(y=-h/2)，n..2n-1 = 顶圈(y=+h/2)，角度递增
      for (i = 0; i <= 1; i += 1) {
        var yy = (i === 0 ? -0.5 : 0.5) * height;
        for (k = 0; k < n; k += 1) {
          var a = (k / n) * Math.PI * 2;
          positions.push(Math.cos(a) * radius, yy, Math.sin(a) * radius);
        }
      }
      var cBottom = 2 * n;
      var cTop = 2 * n + 1;
      positions.push(0, -height / 2, 0);
      positions.push(0, height / 2, 0);
      for (i = 0; i < n; i += 1) {
        var j = (i + 1) % n;
        var a0 = i;
        var b0 = j;
        var a1 = n + i;
        var b1 = n + j;
        // 侧面：外法线朝外（右手定则，环向 × 向上 = 指向轴外为反 → 取反序）
        indices.push(a0, b1, b0);
        indices.push(a0, a1, b1);
        // 底盖法线 -Y、顶盖法线 +Y
        indices.push(a0, b0, cBottom);
        indices.push(a1, cTop, b1);
      }
      var g = new bgeo();
      g.setAttribute("position", new battr(positions, 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    } catch (err) {
      // 最后的保底：细方柱
      return new T.BoxGeometry(radius * 1.6, height, radius * 1.6);
    }
  }

  /* -------------------------------------------------------------- 材质 */
  function fabricMaterial(T, color) {
    if (T.MeshPhysicalMaterial) {
      return new T.MeshPhysicalMaterial({
        color: new T.Color(color),
        roughness: 0.92,
        metalness: 0,
        clearcoat: 0,
        clearcoatRoughness: 1,
      });
    }
    return new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.92, metalness: 0 });
  }

  function woodMaterial(T, color) {
    if (T.MeshStandardMaterial) {
      return new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.72, metalness: 0 });
    }
    return fabricMaterial(T, color);
  }

  function outlineMaterial(T) {
    if (!T.MeshBasicMaterial) return null;
    return new T.MeshBasicMaterial({
      color: new T.Color(0x2e2a26),
      side: T.BackSide || 1, // BackSide 常量借不到时用数值 1（three 约定）
    });
  }

  /* ------------------------------------------------ 拾取的面料颜色 */
  /* inspector-surface-color.js 会把 surfaceColor 写到家具记录上；沙发的
   * 色板语义 = 布艺软垫（坐垫/靠背/扶手/拉点），木框架保持胡桃木。 */
  function surfaceColorOf(entry) {
    var rec = entry && entry.furniture;
    var raw = rec && rec.surfaceColor;
    if (typeof raw !== "string") return null;
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null;
  }

  function shadeHex(hex, amount) {
    var base = parseInt(hex.slice(1), 16);
    var r = (base >> 16) & 0xff;
    var g = (base >> 8) & 0xff;
    var b = base & 0xff;
    var t = Math.abs(amount);
    var target = amount < 0 ? 0 : 255;
    return (
      ((Math.round(r + (target - r) * t) & 0xff) << 16) |
      ((Math.round(g + (target - g) * t) & 0xff) << 8) |
      (Math.round(b + (target - b) * t) & 0xff)
    );
  }

  /* -------------------------------------------------------------- 模型 */
  function buildSofa(T, styleName, surfaceHex) {
    var group = new T.Group();
    group.name = "ha3d-sofa";

    var fabColor = surfaceHex ? parseInt(surfaceHex.slice(1), 16) : 0xede6d8;
    var tuftColor = surfaceHex ? shadeHex(surfaceHex, -0.08) : 0xddd3c0;
    var fab = fabricMaterial(T, fabColor);
    var fabTuft = fabricMaterial(T, tuftColor);
    var wood = woodMaterial(T, 0x5c4433);
    var woodLeg = woodMaterial(T, 0x4e3a2b);
    var outline = outlineMaterial(T);

    function finish(mesh, withOutline) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (withOutline && outline) {
        // 统一 ~6mm 细描边：BackSide 外壳按几何包围盒逐轴均匀放大
        try {
          var geo = mesh.geometry;
          if (!geo.boundingBox && geo.computeBoundingBox) geo.computeBoundingBox();
          var bb = geo.boundingBox;
          if (bb) {
            var dx = bb.max.x - bb.min.x;
            var dy = bb.max.y - bb.min.y;
            var dz = bb.max.z - bb.min.z;
            if (dx > 0.001 && dy > 0.001 && dz > 0.001) {
              var o = new T.Mesh(geo, outline);
              var ky = (dy + 0.012) / dy;
              o.scale.set((dx + 0.012) / dx, ky, (dz + 0.012) / dz);
              /* 缩放以几何中心为基准，会向上下各扩 6 mm；落地部件一旦下扩，
               * 深色描边就压到地板以下，看起来像"陷进地面"。把外壳上抬
               * (ky-1)*dy/2，让它的底面与本体齐平。 */
              o.position.set(mesh.position.x, mesh.position.y + ((ky - 1) * dy) / 2, mesh.position.z);
              group.add(o);
            }
          }
        } catch (err) {}
      }
      return mesh;
    }

    function part(geo, mat, x, y, z, withOutline) {
      var mesh = new T.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      return finish(mesh, withOutline);
    }

    /* --- 木质框架 --- */
    // 底框：宽 2.2 × 深 0.95 × 厚 0.06，跨 y 0.15~0.21
    part(
      roundedBoxGeometry(T, DIM.width, DIM.frameThickness, DIM.depth, 0.012),
      wood, 0, DIM.legHeight + DIM.frameThickness / 2, 0, true
    );

    // 5 根脚：前左/前中/前右/后左/后右
    var legXs = [-DIM.width / 2 + 0.15, 0, DIM.width / 2 - 0.15];
    var legZs = [DIM.depth / 2 - 0.16, -(DIM.depth / 2 - 0.16)];
    var legGeo = cylinderGeometry(T, DIM.legRadius, DIM.legHeight, 24);
    var li, lx, lz;
    for (li = 0; li < legXs.length; li += 1) {
      lx = legXs[li];
      lz = legZs[0];
      part(legGeo, woodLeg, lx, DIM.legHeight / 2, lz, false);
      if (li !== 1) {
        // 后排只有左右两根（无后中）
        part(legGeo, woodLeg, lx, DIM.legHeight / 2, legZs[1], false);
      }
    }

    // 左右侧封板：厚 0.04 × 深 0.95 × 高 0.65，y 0.15~0.80
    var sideGeo = roundedBoxGeometry(T, DIM.sideThickness, DIM.sideHeight, DIM.depth, 0.012);
    part(sideGeo, wood, -(DIM.width - DIM.sideThickness) / 2, DIM.legHeight + DIM.sideHeight / 2, 0, true);
    part(sideGeo, wood, (DIM.width - DIM.sideThickness) / 2, DIM.legHeight + DIM.sideHeight / 2, 0, true);

    /* --- 布艺软垫 --- */
    var halfSeat = DIM.seatWidth / 2;
    var seatCenterX = -(halfSeat + 0.01); // 左坐垫中心；右块对称，缝 0.02
    var seatY = DIM.seatTopY - DIM.seatThickness / 2; // 0.33
    var seatZ = DIM.depth / 2 - DIM.seatDepth / 2; // 前端贴底框前沿 0.0875
    var seatGeo = roundedBoxGeometry(T, DIM.seatWidth, DIM.seatThickness, DIM.seatDepth, 0.06);
    part(seatGeo, fab, seatCenterX, seatY, seatZ, true);
    part(seatGeo, fab, -seatCenterX, seatY, seatZ, true);

    // 靠背 ×2：竖直叠在坐垫后方，底边贴坐垫顶面，顶到 0.82
    var backY = DIM.seatTopY + DIM.backHeight / 2; // 0.62
    var backZ = -(DIM.depth / 2 - DIM.backDepth / 2); // -0.365
    var backGeo = roundedBoxGeometry(T, DIM.seatWidth, DIM.backHeight, DIM.backDepth, 0.08);
    var backFrontZ = backZ + DIM.backDepth / 2; // 靠背正面

    function addBack(cx) {
      part(backGeo, fab, cx, backY, backZ, true);
      // 拉点：4 行 × 3 列，小圆角盒深一档色、微凸 0.002（不穿透靠背）。
      // 纵向 4×0.14 盒在 0.40 高的靠背里排不下 0.155 间距，纵向压缩为
      // 0.09 间距（视觉上等价于拉点软包的密集行距），横向保持 0.155。
      var cols = 3;
      var rows = 4;
      var c;
      var r;
      for (r = 0; r < rows; r += 1) {
        for (c = 0; c < cols; c += 1) {
          var tx = cx + (c - (cols - 1) / 2) * DIM.tuftStep;
          var ty = backY + DIM.backHeight / 2 - 0.08 - r * 0.09;
          var tz = backFrontZ + 0.001; // 前面微凸 1mm
          var tGeo = roundedBoxGeometry(T, DIM.tuftSize, DIM.tuftSize, 0.02, 0.03);
          part(tGeo, fabTuft, tx, ty, tz, false);
        }
      }
    }
    addBack(seatCenterX);
    addBack(-seatCenterX);

    // 扶手软垫 ×2：叠在侧封板上方、坐垫两端。比靠背矮（顶 ~0.70 < 0.82），
    // 前端外扩鼓起，整体圆滚滚柔软：主体 + 顶圆盖 + 前外鼓包，并整体外张 ~6°。
    // 扁平化直接挂到模型组（不嵌套 subgroup），把外张 yaw 烘焙进各部件坐标，
    // 以便离线校验器与真实场景都得到一致的世界包围盒。
    var armTopY = 0.70;
    var armBottomY = 0.34; // 嵌入侧封板 0.15~0.80
    var armH = armTopY - armBottomY; // 0.36
    var armAY = (armTopY + armBottomY) / 2;
    var armX = DIM.width / 2 - DIM.sideThickness - DIM.armWidth / 2 - 0.02;
    var armDepth = DIM.depth - 0.13;

    function addArm(sign) {
      var yaw = sign * 0.1; // 外张 ~6°
      var cosY = Math.cos(yaw), sinY = Math.sin(yaw);
      function rot(lx, lz) {
        // 绕 Y 轴旋转局部偏移（扶手中心在 sign*armX,armAY,0）；返回相对中心的偏移
        return [lx * cosY + lz * sinY, -lx * sinY + lz * cosY];
      }
      // 主体：长圆角块，居中（z=0）
      var c0 = rot(0, 0);
      part(roundedBoxGeometry(T, DIM.armWidth, armH, armDepth, 0.1), fab, sign * armX + c0[0], armAY, c0[1], true);
      // 顶部圆盖（扶手顶饱满圆润），居中
      var c1 = rot(0, 0);
      part(roundedBoxGeometry(T, DIM.armWidth + 0.02, 0.24, armDepth + 0.02, 0.11), fab, sign * armX + c1[0], armAY, c1[1], true);
      // 前端外扩鼓包：只在最前端 + 外侧鼓起（圆角块），模拟外扩的扶手头
      var c2 = rot(sign * (DIM.armWidth / 2 - 0.05), armDepth / 2 - 0.12);
      part(roundedBoxGeometry(T, 0.12, 0.2, 0.18, 0.08), fab, sign * armX + c2[0], armAY + (armH / 2 - 0.04), c2[1], false);
    }
    addArm(-1);
    addArm(1);

    group.userData[MODEL_FLAG] = true;
    return group;
  }

  /* --------------------------------------------------------- 项目数据 */
  var project = null;
  var entries = {};

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
    log("project loaded, sofa entries:", stats.entries);
  }

  function loadProject() {
    fetch(apiBase() + "/api/projects/current", { credentials: "same-origin" })
      .then(function (r) {
        return r.json();
      })
      .then(function (res) {
        setProject(res && res.project);
      })
      .catch(function (e) {
        stats.lastError = "project load failed: " + String(e);
      });
  }

  function connectWs() {
    var url = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + apiBase() + "/ws";
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return;
    }
    ws.addEventListener("open", function () {
      try {
        ws.send(JSON.stringify({ type: "project.subscribe", requestId: "ha3d-sofa" }));
      } catch (e) {}
    });
    ws.addEventListener("message", function (e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg && msg.type === "project.updated") setProject(msg.payload);
      } catch (err) {}
    });
    ws.addEventListener("close", function () {
      window.setTimeout(connectWs, 3000);
    });
  }

  /* --------------------------------------------------------- 世界包围盒 */
  function isOwnPart(obj) {
    var node = obj;
    while (node) {
      if (node.userData && node.userData[MODEL_FLAG]) return true;
      node = node.parent;
    }
    return false;
  }

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

  /* ----------------------------------------------- 三层隐藏：第 1 层组匹配 */
  function findStockAnchor(scene, T, entry, claimedUid) {
    var rec = entry.furniture || {};
    var rw = typeof rec.width === "number" ? rec.width : TOTAL_WIDTH;
    var rd = typeof rec.depth === "number" ? rec.depth : TOTAL_DEPTH;
    var px = entry.device.position ? entry.device.position[0] : null;
    var pz = entry.device.position ? entry.device.position[2] : null;

    function isOwnGroup(g) {
      if (!g || !g.userData) return false;
      return g.userData.ha3dSofaStandalone || g.userData[MODEL_FLAG];
    }
    function footprintOk(box) {
      var sx = box.max.x - box.min.x;
      var sy = box.max.y - box.min.y;
      var sz = box.max.z - box.min.z;
      if (Math.max(sx, sy, sz) > 4 || Math.min(sx, sy, sz) < 0.05) return false;
      /* 旋转不变判据：比对 AABB 的水平对角线，而不是边长。
       *
       * 直接比边长在场景旋转时会失效 —— 旋转会把世界 AABB 撑大（45° 时
       * 边长变成 (w+d)/√2），足迹校验随之失败，匹配掉到"按形状乱找"的
       * 下一层 → 认错宿主（真实事故：冰箱认成了洗衣机，容器被写到别人的
       * 位置上，模型在房间里乱飞）。对角线长度在平面旋转下不变，用它做
       * 判据才与旋转无关。 */
      /* 旋转不变足迹判据（详见 appliance-fridge.js 同款说明）：AABB 对角线在
       * [√(w²+d²), w+d] 区间内都接受，任意旋转角度都能认到同一件家具，避免
       * 旋转中误判找不到宿主导致容器漂移（布艺沙发必现漂移的根因之一）。 */
      var diagBox = Math.sqrt(sx * sx + sz * sz);
      var diagRec = Math.sqrt(rw * rw + rd * rd);
      var diagMax = rw + rd;
      if (diagBox < diagRec - 0.5 || diagBox > diagMax + 0.5) return false;
      if (sx > diagMax + 0.25 || sz > diagMax + 0.25) return false;
      return true;
    }

    var best = null;
    var bestScore = Infinity;

    // 优先：SPA 用 focusEntityId 标记原生家具组，直接命中（最可靠，不依赖包围盒形状）。
    // 沙发的载体 kind 正好是 SPA 原生 "sofa"，原生网格是多部件（底座/坐垫/靠背/扶手），
    // 逐个网格按尺寸匹配很脆弱；直接隐藏整个原生组最稳妥。
    scene.traverse(function (obj) {
      if (best) return;
      if (!(obj.isGroup || obj.type === "Group")) return;
      if (isOwnPart(obj) || isOwnGroup(obj)) return;
      var fid = obj.userData && obj.userData.focusEntityId;
      if (fid !== entry.key && !(rec && fid === rec.id)) return;
      if (obj.userData && obj.userData.ha3dStockHidden) return;
      var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden);
      if (claim && claim !== claimedUid) return;
      var box = worldBoundsOfObject(T, obj);
      if (!box) return;
      best = { obj: obj, min: box.min };
    });
    if (best) return best;

    if (px !== null && pz !== null) {
      scene.traverse(function (obj) {
        if (!(obj.isGroup || obj.type === "Group")) return;
        if (isOwnPart(obj) || isOwnGroup(obj)) return;
        if (obj.userData && obj.userData.ha3dStockHidden) return; // fridge 占用
        var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden);
        if (claim && claim !== claimedUid) return;
        if (Math.abs((obj.position ? obj.position.x : 0) - px) > 0.35) return;
        if (Math.abs((obj.position ? obj.position.z : 0) - pz) > 0.35) return;
        var box = worldBoundsOfObject(T, obj);
        if (!box || !footprintOk(box)) return;
        var score = Math.sqrt((obj.position.x - px) * (obj.position.x - px) + (obj.position.z - pz) * (obj.position.z - pz));
        if (score < bestScore) {
          bestScore = score;
          best = { obj: obj, min: box.min };
        }
      });
    }

    /* 兜底：按足迹匹配单个 mesh（不含位置约束，但需要投影接近记录坐标）。 */
    if (!best) {
      scene.traverse(function (obj) {
        if (isOwnPart(obj) || isOwnGroup(obj)) return;
        if (obj.userData && obj.userData.ha3dStockHidden) return;
        var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden);
        if (claim && claim !== claimedUid) return;
        var b = worldBounds(T, obj);
        if (!b) return;
        var sx = b.max.x - b.min.x;
        var sy = b.max.y - b.min.y;
        var sz = b.max.z - b.min.z;
        if (Math.max(sx, sy, sz) > 4 || Math.min(sx, sy, sz) < 0.05) return;
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

  /* ----------------------------------------------- 三层隐藏：第 2 层 mesh 形状
   * 沙发是"高体件"（不像桌子那样是顶面平板），形状门据此放宽：
   * 有一定厚度、水平两个方向都覆盖记录一半以上、贴近地面。 */
  function hideStockMeshes(T, scene, entry, uid, wp) {
    var rec = entry.furniture || {};
    var rw = typeof rec.width === "number" ? rec.width : TOTAL_WIDTH;
    var rd = typeof rec.depth === "number" ? rec.depth : TOTAL_DEPTH;
    var rh = typeof rec.height === "number" ? rec.height : TOTAL_HEIGHT;
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
      if (ud[MODEL_FLAG] || ud.ha3dSofaStandalone) return;
      if (ud[STOCK_CLAIM] === uid) return; // 自己已藏
      if (ud.ha3dStockHidden || ud.ha3dDiningStockHidden || ud.ha3dWasherStockHidden) return; // 别的补丁占用
      // 透明 hitbox 必须保留：R3F 只认它，藏了就选不中
      var mat = obj.material;
      if (mat && mat.transparent && mat.opacity === 0) return;

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

      // 沙发形：覆盖大半足迹、有实质厚度、主体贴近地面
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

  /* 采纳原生家具变换：算 → 校验 → 写入 → 最后才隐藏宿主。 */

  /* 场景自动旋转时，容器必须**每帧**跟随宿主，否则会落后一整个轮询周期
   * （700 ms × 0.18 rad/s ≈ 7°，户型半径 20 m 处就是 2.4 m 的"漂移"）。
   * scene-origin-fix.js 提供统一的帧驱动，各补丁只注册一个回调。 */
  /* 场景自动旋转时，容器必须**每帧**跟随宿主，否则会落后一整个轮询周期
   * （700 ms × 0.18 rad/s ≈ 7°，户型半径 20 m 处就是 2.4 m 的"漂移"）。
   * scene-origin-fix.js 提供统一的帧驱动，各补丁只注册一个回调。
   *
   * 关键：宿主引用必须**按 uid 分别保存**。早期实现用了一个模块级共享的
   * `lastAdopt`，当同一补丁有 2+ 条记录（如两个子母茶几）时，第 1 条记录
   * 认领宿主后写满了共享变量，第 2 条记录的 hostLocked(uid) 看到这个共享宿主
   * 还活着，就直接复用了**第 1 条的宿主** —— 两条记录被写到同一个变换上，
   * 模型在场景里叠在一起。改为按 uid 存各自的宿主即可根治。 */
  var adoptedByUid = {}; // uid -> { container, stock, entry, kit }

  /* 宿主锁定：一旦认定就不再改（按 uid 各自锁定）。
   *
   * `findStockAnchor` 依赖世界包围盒，场景旋转时它可能在"原生家具组"和
   * "别的家具模型"之间摇摆；一旦认错宿主，容器就会被写到别人的位置上，
   * 模型在房间里乱飞（真实事故：冰箱认成了洗衣机）。锁定后宿主稳定，
   * 只有宿主被 React 重建（脱离场景）时才重新认定。 */
  function hostLocked(uid) {
    var a = adoptedByUid[uid];
    return !!(a && a.stock && a.stock.obj && a.stock.obj.parent);
  }

  function frameSync() {
    /* 一个补丁可能管多条记录，每条各自跟随自己的宿主。 */
    var keys = Object.keys(adoptedByUid);
    for (var i = 0; i < keys.length; i += 1) {
      var a = adoptedByUid[keys[i]];
      if (!a || !a.stock || !a.kit) continue;
      /* React 重渲染会重建原生 mesh：宿主一旦脱离场景，它的世界变换就冻结了，
       * 照抄会把模型拉回旧位置。这一帧跳过，等下一轮轮询换上新宿主。 */
      var host = a.stock && a.stock.obj;
      if (host && !host.parent) continue;
      if (!a.container.parent) continue; // 容器已被回收
      adoptStockTransform(a.kit, a.container, a.stock, a.entry, keys[i]);
    }
  }

  function publishFrameSync() {
    var fix = window.__ha3dSceneOriginFix;
    if (fix && fix.register) fix.register("furniture-sofa", frameSync);
  }

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
      /* 底面高度 = 地面高度，**不采纳宿主的包围盒最低点**。
       * 模型原点契约是"底面 y=0"，贴地只需把原点对齐到地板平面。
       * 宿主的 stock.min.y 是整个原生组的 AABB 最低点，会被装饰件 /
       * 旋转后 AABB / 未更新的 matrixWorld 拉低，一旦偏负容器就整体下压，
       * 表现为桌脚/支撑环穿进地板（室内比室外明显：父级楼层偏移不同）。 */
      var stockOrigin = stock.obj.getWorldPosition(new T.Vector3());
      var groundWorldY = stockOrigin.y;
      var baseY = inv
        ? new T.Vector3(0, groundWorldY, 0).applyMatrix4(inv).y
        : groundWorldY;

      var nums = [wp.x, wp.y, baseY, wp.z, wq.x, wq.y, wq.z, wq.w];
      for (var i = 0; i < nums.length; i += 1) {
        if (typeof nums[i] !== "number" || !isFinite(nums[i])) {
          stats.lastError = "adoptStockTransform: non-finite transform (index " + i + ")";
          return false;
        }
      }

      var rec = entry.furniture || {};
      if (typeof rec.width === "number" && typeof rec.height === "number" && typeof rec.depth === "number") {
        var sx = rec.width / TOTAL_WIDTH;
        var sy = rec.height / TOTAL_HEIGHT;
        var sz = rec.depth / TOTAL_DEPTH;
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

  /* 标记宿主已被占用并隐藏它（幂等）。 */
  function claimStock(stock, uid) {
    if (!stock || !stock.obj) return;
    if (!stock.obj.userData) stock.obj.userData = {};
    stock.obj.userData[STOCK_CLAIM] = uid;
    if (stock.obj.visible) {
      stock.obj.visible = false;
      stats.hiddenStock += 1;
    }
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

  var STANDALONE_NAME = "ha3d-sofa-standalone";

  function syncStandaloneTransform(container, entry) {
    var pos = entry.device.position || [0, 0, 0];
    container.position.set(pos[0], pos[1] || 0, pos[2] || 0);
    var rot = entry.device.rotation;
    if (Array.isArray(rot)) container.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  }

  function standaloneContainer(T, scene, entry) {
    var uid = entry.key;
    var key = STANDALONE_NAME + ":" + uid;
    var existing = null;
    scene.traverse(function (obj) {
      if (!existing && obj.name === key) existing = obj;
    });
    if (existing) return existing;

    var container = new T.Group();
    container.name = key;
    container.userData.focusEntityId = uid;
    container.userData.ha3dSofaStandalone = true;
    syncStandaloneTransform(container, entry);
    scene.add(container);
    log("standalone sofa container created for", uid);
    return container;
  }

  function attachModel(T, container, entry) {
    var styleName = currentStyle();
    var surface = surfaceColorOf(entry) || "";
    var existing = null;
    container.children.forEach(function (child) {
      if (!existing && child.userData && child.userData[MODEL_FLAG]) existing = child;
    });
    if (existing) {
      if (existing.userData.ha3dSofaStyle === styleName && (existing.userData.ha3dSofaSurface || "") === surface) {
        // 其它参数没变：只同步离地微调（状态类，不重建）
        if (window.ha3dModelLift) window.ha3dModelLift.sync(existing, entry);
        return false;
      }
      disposeModel(existing);
    }
    var model = buildSofa(T, styleName, surface || null);
    model.userData.ha3dSofaStyle = styleName;
    model.userData.ha3dSofaSurface = surface;
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
      stats.lastError = "no fabric sofa entries in the project";
      return;
    }

    var T = borrowThree(scene);
    var fatal = [];
    if (!T.Group) fatal.push("Group");
    if (!T.Mesh) fatal.push("Mesh");
    if (!T.Vector3) fatal.push("Vector3");
    if (!T.Color) fatal.push("Color");
    if (!T.BoxGeometry && !T.CylinderGeometry && !T.ExtrudeGeometry) fatal.push("no geometry class at all");
    stats.kitMissing = fatal.length ? fatal.join(",") : null;
    if (fatal.length) {
      stats.lastError = "three constructors unavailable: " + stats.kitMissing;
      return;
    }
    stats.degraded = {
      cylinder: !T.CylinderGeometry,
      shape: !T.Shape,
      extrude: !T.ExtrudeGeometry,
    };

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

      // 采纳原生沙发组变换；找不到就用记录坐标兜底
      /* ⚠️ `prev` 必须取 `adoptedByUid[uid]`，**不能**用外层的
       * `var prev = window.__THREE_DEVTOOLS__`（那是 three.js 的 devtools 全局，
       * `prev.stock` 恒为 undefined → "已锁定"分支会退化成"什么都不做"）。 */
      var prev = adoptedByUid[uid];
      var stock = hostLocked()
          ? prev.stock          // 已锁定：沿用，避免旋转时认错宿主
          : findStockAnchor(scene, T, entry, uid);
      if (stock && adoptStockTransform(T, target, stock, entry, uid)) {
        changed = true;
        /* 记住这一轮的宿主，帧驱动每帧照抄一次（旋转时零滞后）。 */
        adoptedByUid[uid] = { container: target, stock: stock, entry: entry, kit: T };
      } else if (!stock) {
        /* 宿主"找不到"往往只是**这一轮匹配不上**（旋转时原生模型的世界
         * AABB 膨胀，足迹匹配会失败），并不是宿主真的没了。此时**保留**
         * 上一次成功的宿主引用：它仍随场景实时旋转，帧驱动继续抄它，
         * 模型才不会原地不动、和旋转中的房间脱离。
         * 宿主真的被 React 重建时，frameSync 里的 parent 检查会兜住。 */
        if (!prev) syncStandaloneTransform(target, entry);
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
      if (o.userData && o.userData["ha3dSofaStandalone"] && o.userData.focusEntityId) {
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

  window.ha3dSofaProbe = function () {
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
