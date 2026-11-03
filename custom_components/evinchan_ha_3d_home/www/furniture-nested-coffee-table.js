/*
 * 黑白拼色圆形嵌套子母茶几 3D 模型（运行时补丁）。
 *
 * Record shape: carrier kind "coffee_table"（SPA 白名单内，会被原生渲染成
 * 自带方茶几 → 必须三层隐藏）+ modelId "furniture.nested_coffee_tables"。
 * 纯 furniture 路径 A，不绑定 HA 实体；两张台面支持配置颜色：
 *   surfaceColor   -> 大茶几台面（默认哑光白岩板）
 *   smallTopColor  -> 小茶几台面（默认哑光黑岩板）
 *
 * 结构：每张茶几 = 圆形薄圆角台面（岩板）+ 落地支撑圆环（黑金属）+
 * 3 根竖直细圆柱桌腿（黑金属）。全部部件同轴；小茶几沿 +X 偏置 0.55 m
 * （避开大茶几三根腿），一大一小呈参考图的相切姿态，一起移动/旋转/缩放。
 *
 * 特殊材质：不随三套 visualStyle 变（黑白拼色是产品固有色）；
 * 细描边（BackSide 外壳 ~6 mm）三套风格下都开，用于区分岩板与金属框架。
 *
 * 原点 = 大茶几台面圆心的地面投影点（底面 y=0），圆形无朝向语义，
 * MODEL_YAW = 0、MODEL_Z_OFFSET = 0。
 *
 * Debug: window.ha3dNestedProbe()
 */
(function () {
  "use strict";

  var MODEL_IDS = ["furniture.nested_coffee_tables"];
  var STYLE_KEY = "ha3d.home.sceneVisualStyle";
  var MODEL_FLAG = "ha3dNestedCoffee";
  var STOCK_CLAIM = "ha3dNestedStockHidden"; // 专属占用标记，不与其他补丁共用
  var VERSION = 1;

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
  window.ha3dNestedDebug = stats;

  /* ------------------------------------------------------------ 尺寸（米） */
  var DIM = {
    topThickness: 0.04, // 两张台面同厚
    topChamfer: 0.004, // 台面上缘小圆角
    ringHeight: 0.03, // 落地圆环高度
    ringTube: 0.024, // 圆环管厚（外径 - 内径的一半）
    legRadius: 0.015, // 桌腿半径（⌀0.03）
    big: {
      topDia: 0.8, // 台面直径
      totalHeight: 0.45, // 台面上表面离地
      ringDia: 0.72, // 落地圆环外径
      legOrbit: 0.3, // 桌腿分布半径（上端接台面、下端接圆环）
      legAngles: [30, 150, 270], // 三根腿角度；小茶几偏置沿 0°，落在两腿之间
    },
    small: {
      topDia: 0.6,
      totalHeight: 0.38,
      ringDia: 0.52,
      legOrbit: 0.21,
      offset: 0.55, // 小茶几圆心相对大茶几圆心的 +X 偏置
      legAngles: [90, 210, 330],
    },
  };

  /* 派生量 —— 显式定义，任何 position/scale 计算都从这里取数 */
  var BIG_TOP_Y = DIM.big.totalHeight - DIM.topThickness; // 0.41 台面底面
  var SMALL_TOP_Y = DIM.small.totalHeight - DIM.topThickness; // 0.34
  var BIG_RING_R = DIM.big.ringDia / 2; // 0.36
  var SMALL_RING_R = DIM.small.ringDia / 2; // 0.26
  var TOTAL_WIDTH = DIM.small.offset + DIM.small.topDia / 2 + DIM.big.topDia / 2; // 1.25
  var TOTAL_DEPTH = DIM.big.topDia; // 0.80
  var TOTAL_HEIGHT = DIM.big.totalHeight; // 0.45
  /* 模型以"大茶几圆心"为原点搭建，但记录 position 表示的是**包围盒中心**。
   * X 跨度是 [-bigR, offset + smallR]，中心相对原点偏 +X，偏移量为跨度的一半
   * 减去 bigR。建完后整组回移这个量，包围盒中心才与原点重合。 */
  var CENTER_X_OFFSET = (DIM.small.offset + DIM.small.topDia / 2 - DIM.big.topDia / 2) / 2; // 0.225
  var MODEL_YAW = 0;
  var MODEL_Z_OFFSET = 0;

  var SCAN_INTERVAL = 700;

  /* ------------------------------------------------------------ 工具 */
  function log() {
    if (!window.HA3D_NESTED_DEBUG) return;
    try {
      console.log.apply(console, ["[3d-home nested-coffee]"].concat([].slice.call(arguments)));
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
          if (renderer.__ha3dNestedHooked) return;
          renderer.__ha3dNestedHooked = true;
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
              var fromOpts = p.options && p.options.shape;
              if (!kit.Shape && shapes && shapes.length && shapes[0] && shapes[0].constructor && isUsableShape(shapes[0].constructor)) {
                kit.Shape = shapes[0].constructor;
              }
              if (!kit.Shape && single && single.constructor && isUsableShape(single.constructor)) {
                kit.Shape = single.constructor;
              }
              if (!kit.Shape && fromOpts && fromOpts.constructor && isUsableShape(fromOpts.constructor)) {
                kit.Shape = fromOpts.constructor;
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

  /* ------------------------------------- BufferGeometry 底座（借 BoxGeometry） */
  function bufferKit(T) {
    try {
      var probe = new T.BoxGeometry(0.01, 0.01, 0.01);
      var battr = probe.attributes.position.constructor;
      var bgeo = Object.getPrototypeOf(probe.constructor);
      probe.dispose();
      return { bgeo: bgeo, battr: battr };
    } catch (err) {
      return null;
    }
  }

  /* ------------------------------------------------------- 几何工厂（带回退） */
  /* 圆柱：CylinderGeometry 缺失时退化为 48 边手写棱柱。 */
  function cylinderGeometry(T, radius, height, segments) {
    if (T.CylinderGeometry) return new T.CylinderGeometry(radius, radius, height, segments || 32);
    var bk = bufferKit(T);
    if (bk) {
      var n = 48;
      var positions = [];
      var indices = [];
      var i;
      var k;
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
        indices.push(a0, b1, b0);
        indices.push(a0, a1, b1);
        indices.push(a0, b0, cBottom);
        indices.push(a1, cTop, b1);
      }
      try {
        var g = new bk.bgeo();
        g.setAttribute("position", new bk.battr(positions, 3));
        g.setIndex(indices);
        g.computeVertexNormals();
        return g;
      } catch (err) {}
    }
    return new T.BoxGeometry(radius * 1.6, height, radius * 1.6);
  }

  /* 落地支撑圆环：环形板（外径 rOuter、内径 rInner、高 height）。
   * 手写 BufferGeometry；绕序逐面核对过：外壁朝外、内壁朝轴、顶面朝上、底面朝下。
   * 借不到 BufferGeometry 时退化为实心圆盘（视觉上只少一个透空）。 */
  function ringGeometry(T, rOuter, rInner, height) {
    var bk = bufferKit(T);
    if (!bk) return cylinderGeometry(T, rOuter, height, 48);
    var n = 48;
    var halfH = height / 2;
    var positions = [];
    var indices = [];
    var i;
    for (i = 0; i < n; i += 1) {
      var a = (i / n) * Math.PI * 2;
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      // 每段 8 顶点：0 底外 1 底内 2 顶外 3 顶内
      positions.push(ca * rOuter, -halfH, sa * rOuter);
      positions.push(ca * rInner, -halfH, sa * rInner);
      positions.push(ca * rOuter, halfH, sa * rOuter);
      positions.push(ca * rInner, halfH, sa * rInner);
    }
    for (i = 0; i < n; i += 1) {
      var j = (i + 1) % n;
      var bo0 = i * 4;
      var bi0 = i * 4 + 1;
      var to0 = i * 4 + 2;
      var ti0 = i * 4 + 3;
      var bo1 = j * 4;
      var bi1 = j * 4 + 1;
      var to1 = j * 4 + 2;
      var ti1 = j * 4 + 3;
      // 外壁（法线朝外）：绕序使外法线沿径向朝外
      indices.push(bo0, to1, bo1, bo0, to0, to1);
      // 内壁（法线朝轴）：绕序使外法线沿径向朝内（指向轴心）
      indices.push(bi0, to1, to0, bi0, bi1, to1);
      // 顶面（法线 +Y）
      indices.push(to0, ti1, to1, to0, ti0, ti1);
      // 底面（法线 -Y）
      indices.push(bo0, bi1, bi0, bo0, bo1, bi1);
    }
    try {
      var g = new bk.bgeo();
      g.setAttribute("position", new bk.battr(positions, 3));
      g.setIndex(indices);
      g.computeVertexNormals();
      return g;
    } catch (err) {
      return cylinderGeometry(T, rOuter, height, 48);
    }
  }

  /* 圆形台面：圆盘 + 上缘小倒角。Shape 可用时走挤出（真圆角），
   * 否则退化为棱柱圆盘。 */
  function tableTopGeometry(T, dia, thickness, chamfer) {
    var r = dia / 2;
    if (T.ExtrudeGeometry && isUsableShape(T.Shape)) {
      var c = Math.min(chamfer, thickness / 3, r * 0.1);
      var rr = r - c;
      var s = new T.Shape();
      var seg = 56;
      for (var i = 0; i < seg; i += 1) {
        var a = (i / seg) * Math.PI * 2;
        var px = Math.cos(a) * rr;
        var py = Math.sin(a) * rr;
        if (i === 0) s.moveTo(px, py);
        else s.lineTo(px, py);
      }
      s.closePath();
      var geo = new T.ExtrudeGeometry(s, {
        depth: thickness - 2 * c,
        bevelEnabled: true,
        bevelSize: c,
        bevelThickness: c,
        bevelSegments: 1,
        curveSegments: 1,
        steps: 1,
      });
      geo.rotateX(-Math.PI / 2);
      geo.center();
      return geo;
    }
    return cylinderGeometry(T, r, thickness, 56);
  }

  /* -------------------------------------------------------------- 材质 */
  /* 特殊材质：黑白拼色是产品固有色，三套 visualStyle 下保持一致。 */
  function stoneMaterial(T, color) {
    if (T.MeshPhysicalMaterial) {
      return new T.MeshPhysicalMaterial({
        color: new T.Color(color),
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.5,
      });
    }
    return new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.42, metalness: 0 });
  }

  function metalMaterial(T, color) {
    if (T.MeshStandardMaterial) {
      return new T.MeshStandardMaterial({ color: new T.Color(color), roughness: 0.46, metalness: 0.72 });
    }
    return stoneMaterial(T, color);
  }

  function outlineMaterial(T) {
    if (!T.MeshBasicMaterial) return null;
    return new T.MeshBasicMaterial({
      color: new T.Color(0x191b1e),
      side: T.BackSide || 1, // BackSide 常量借不到时用数值 1（three 约定）
    });
  }

  /* ------------------------------------------------ 拾取的台面颜色 */
  /* surfaceColor = 大茶几台面，smallTopColor = 小茶几台面。
   * 桌腿 / 圆环永远是黑金属，不随色板变化。 */
  function colorOf(entry, key) {
    var rec = entry && entry.furniture;
    var raw = rec && rec[key];
    if (typeof raw !== "string") return null;
    return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null;
  }

  /* 用户微调的"离地高度"（米）走通用能力 www/model-lift.js。
   * 几何已经精确贴地（底面 y=0），但地板网格、阴影贴图、描边外壳等渲染因素
   * 仍可能让落地环看起来陷进去或浮起来 —— 这类偏差交给用户一眼微调。 */
  function liftModule() {
    return window.ha3dModelLift || null;
  }

  function liftOffOf(entry) {
    var lift = liftModule();
    if (lift) return lift.of(entry);
    /* 兜底：通用模块未加载时自己算（与 schema._lift_off 同规则）。 */
    var rec = entry && entry.furniture;
    var raw = rec && rec.liftOff;
    if (typeof raw !== "number" || !isFinite(raw)) return 0;
    if (raw > 0.1) return 0.1;
    if (raw < -0.1) return -0.1;
    return raw;
  }

  /* -------------------------------------------------------------- 模型 */
  function buildOneTable(T, spec, topMat, metalMat, outline, legAngles, orbit) {
    var g = new T.Group();
    g.name = "ha3d-nested-coffee-table";

    function add(geo, mat, x, y, z, withOutline) {
      var mesh = new T.Mesh(geo, mat);
      mesh.position.set(x || 0, y || 0, z || 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
      if (withOutline && outline) {
        // 细描边：BackSide 外壳按几何包围盒逐轴均匀放大 ~6 mm
        try {
          var geo2 = mesh.geometry;
          if (!geo2.boundingBox && geo2.computeBoundingBox) geo2.computeBoundingBox();
          var bb = geo2.boundingBox;
          if (bb) {
            var dx = bb.max.x - bb.min.x;
            var dy = bb.max.y - bb.min.y;
            var dz = bb.max.z - bb.min.z;
            if (dx > 0.001 && dy > 0.001 && dz > 0.001) {
              var o = new T.Mesh(geo2, outline);
              var kx = (dx + 0.012) / dx;
              var ky = (dy + 0.012) / dy;
              var kz = (dz + 0.012) / dz;
              o.scale.set(kx, ky, kz);
              /* 缩放以几何中心为基准，会向上下各扩 6 mm。落地环一旦这样
               * 下扩，深色描边就压到地板以下，看起来像圆环"陷进地面"。
               * 这里把外壳上抬 (ky-1)*dy/2，使它的**底面与本体底面齐平**。 */
              o.position.set(mesh.position.x, mesh.position.y + ((ky - 1) * dy) / 2, mesh.position.z);
              g.add(o);
            }
          }
        } catch (err) {}
      }
      return mesh;
    }

    var topY = spec.totalHeight - DIM.topThickness;

    // 1. 落地支撑圆环（黑金属）
    add(ringGeometry(T, spec.ringDia / 2, spec.ringDia / 2 - DIM.ringTube, DIM.ringHeight), metalMat, 0, DIM.ringHeight / 2, 0, true);

    // 2. 三根竖直桌腿：上端接台面底面，下端接圆环顶面（黑金属）
    var legLen = topY - DIM.ringHeight;
    var legGeo = cylinderGeometry(T, DIM.legRadius, legLen, 20);
    for (var i = 0; i < legAngles.length; i += 1) {
      var a = (legAngles[i] * Math.PI) / 180;
      add(legGeo, metalMat, Math.cos(a) * orbit, DIM.ringHeight + legLen / 2, Math.sin(a) * orbit, false);
    }

    // 3. 岩板台面（颜色可配置）
    add(tableTopGeometry(T, spec.topDia, DIM.topThickness, DIM.topChamfer), topMat, 0, topY + DIM.topThickness / 2, 0, true);

    return g;
  }

  function buildNestedTables(T, styleName, bigHex, smallHex) {
    var group = new T.Group();
    group.name = "ha3d-nested-coffee-tables";

    var bigColor = bigHex ? parseInt(bigHex.slice(1), 16) : 0xf2f0ea; // 哑光白岩板
    var smallColor = smallHex ? parseInt(smallHex.slice(1), 16) : 0x1e2124; // 哑光黑岩板
    var bigTop = stoneMaterial(T, bigColor);
    var smallTop = stoneMaterial(T, smallColor);
    var metal = metalMaterial(T, 0x26282b); // 哑光黑金属
    var outline = outlineMaterial(T);

    // 大茶几在原点；小茶几沿 +X 偏置（避开大茶几的腿）
    group.add(buildOneTable(T, DIM.big, bigTop, metal, outline, DIM.big.legAngles, DIM.big.legOrbit));
    var small = buildOneTable(T, DIM.small, smallTop, metal, outline, DIM.small.legAngles, DIM.small.legOrbit);
    small.position.set(DIM.small.offset, 0, 0);
    group.add(small);

    /* ⚠️ 水平居中：记录 position 是**足迹（包围盒）中心**，不是大茶几圆心。
     * 上面这样摆出来，X 跨度是 [-bigR, offset+smallR] = [-0.400, +0.850]，
     * 中心在 +0.225 —— 直接把模型挂到宿主原点，整组会往 +X 偏 0.225 m
     * （视觉上就是"茶几没有落在自己的足迹里"）。
     * 这里把整组回移半个 X 跨度，让包围盒中心与原点重合后，
     * adoptStockTransform 才能把足迹中心正确对齐。 */
    group.position.x = -CENTER_X_OFFSET;

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
    log("project loaded, nested coffee entries:", stats.entries);
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
        ws.send(JSON.stringify({ type: "project.subscribe", requestId: "ha3d-nested-coffee" }));
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
      return g.userData.ha3dNestedStandalone || g.userData[MODEL_FLAG];
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
       * 旋转中误判找不到宿主导致容器漂移。 */
      var diagBox = Math.sqrt(sx * sx + sz * sz);
      var diagRec = Math.sqrt(rw * rw + rd * rd);
      var diagMax = rw + rd;
      if (diagBox < diagRec - 0.5 || diagBox > diagMax + 0.5) return false;
      if (sx > diagMax + 0.25 || sz > diagMax + 0.25) return false;
      return true;
    }

    var best = null;
    var bestScore = Infinity;

    // 优先：SPA 用 focusEntityId 标记原生家具组，直接命中（最可靠）。
    scene.traverse(function (obj) {
      if (best) return;
      if (!(obj.isGroup || obj.type === "Group")) return;
      if (isOwnPart(obj) || isOwnGroup(obj)) return;
      var fid = obj.userData && obj.userData.focusEntityId;
      if (fid !== entry.key && !(rec && fid === rec.id)) return;
      if (obj.userData && obj.userData.ha3dStockHidden) return;
      var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden || obj.userData.ha3dSofaStockHidden || obj.userData.ha3dWasherStockHidden);
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
        var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden || obj.userData.ha3dSofaStockHidden || obj.userData.ha3dWasherStockHidden);
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
        var claim = obj.userData && (obj.userData[STOCK_CLAIM] || obj.userData.ha3dDiningStockHidden || obj.userData.ha3dSofaStockHidden || obj.userData.ha3dWasherStockHidden);
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
   * 原生 coffee_table 是"宽而平的板 + 矮腿"：套用桌面类形状门
   * （薄平板、位于台面高度、足迹吻合）。 */
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
      if (ud[MODEL_FLAG] || ud.ha3dNestedStandalone) return;
      if (ud[STOCK_CLAIM] === uid) return; // 自己已藏
      if (ud.ha3dStockHidden || ud.ha3dDiningStockHidden || ud.ha3dSofaStockHidden || ud.ha3dWasherStockHidden) return; // 别的补丁占用
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

      // 桌面形：宽而平、位于台面高度附近
      if (sy > Math.max(0.45, rh * 0.5)) return;
      if (sx < rw * 0.45 || sz < rd * 0.45) return;
      var cy = (b.min.y + b.max.y) / 2;
      if (Math.abs(cy - (rh - sy / 2)) > 0.5) return;

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
   * scene-origin-fix.js 提供统一的帧驱动，各补丁只注册一个回调。
   *
   * 关键：宿主引用必须**按 uid 分别保存**。早期实现用了一个模块级共享的
   * `lastAdopt`，当同一补丁有 2+ 条记录（如两个子母茶几）时，第 1 条记录
   * 认领宿主后写满了共享变量，第 2 条记录的 hostLocked() 看到这个共享宿主
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
    if (fix && fix.register) fix.register("furniture-nested", frameSync);
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
       *
       * 模型的原点契约是"台面圆心在地面的投影点（底面 y=0）"，所以贴地只需把
       * 原点对齐到地板平面。而宿主的 stock.min.y 是原生模型整个组的 AABB 最低点：
       * 它会把原生模型自带的装饰/旋转后的斜边/未更新的 matrixWorld 一起算进来，
       * 一旦偏负，容器就被整体下压 —— 表现就是桌脚和支撑环穿进地板（室内比
       * 室外明显，因为两组父级楼层偏移不同）。
       *
       * 地板高度取原生宿主**原点**的 y（SPA 把家具组原点放在地面），
       * 再转换到容器父级的局部空间。 */
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

  var STANDALONE_NAME = "ha3d-nested-coffee-standalone";

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
    container.userData.ha3dNestedStandalone = true;
    syncStandaloneTransform(container, entry);
    scene.add(container);
    log("standalone nested coffee container created for", uid);
    return container;
  }

  function attachModel(T, container, entry) {
    var styleName = currentStyle(); // 材质固定，仅作记录
    var surface = colorOf(entry, "surfaceColor") || "";
    var small = colorOf(entry, "smallTopColor") || "";
    var existing = null;
    container.children.forEach(function (child) {
      if (!existing && child.userData && child.userData[MODEL_FLAG]) existing = child;
    });
    if (existing) {
      // 变更检测必须包含两个颜色字段，否则色板保存后模型不动
      if ((existing.userData.ha3dNestedSurface || "") === surface && (existing.userData.ha3dNestedSmall || "") === small) {
        /* 颜色没变：只需同步 liftOff（状态类参数，改 y 即可，无需重建）。 */
        applyLiftOff(existing, entry);
        return false;
      }
      disposeModel(existing);
    }
    var model = buildNestedTables(T, styleName, surface || null, small || null);
    model.userData.ha3dNestedStyle = styleName;
    model.userData.ha3dNestedSurface = surface;
    model.userData.ha3dNestedSmall = small;
    /* X 方向要保留 buildNestedTables 里做的居中补偿（记录 position 是足迹
     * 中心，不是大茶几圆心）；写成 0 会把那 0.225 m 的偏移又加回来。
     * Y 方向叠加用户微调的 liftOff。 */
    model.userData.ha3dNestedLift = liftOffOf(entry);
    model.position.set(-CENTER_X_OFFSET, model.userData.ha3dNestedLift, MODEL_Z_OFFSET);
    model.rotation.set(0, MODEL_YAW, 0);
    container.add(model);
    return true;
  }

  /* 状态类参数：只改 y，不销毁几何。 */
  function applyLiftOff(model, entry) {
    var next = liftOffOf(entry);
    if ((model.userData.ha3dNestedLift || 0) === next) return false;
    model.userData.ha3dNestedLift = next;
    model.position.y = next;
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
      stats.lastError = "no nested coffee table entries in the project";
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

      // 采纳原生茶几组变换；找不到就用记录坐标兜底
      var prev = adoptedByUid[uid];
      var stock = hostLocked(uid)
          ? prev.stock                // 已锁定：沿用，避免旋转时认错宿主
          : findStockAnchor(scene, T, entry, uid);
      if (stock && adoptStockTransform(T, target, stock, entry, uid)) {
        changed = true;
        /* 按 uid 记住这一轮的宿主，帧驱动每帧照抄一次（旋转时零滞后）。
         * 每条记录各自保存，绝不共用（否则 2+ 条记录会复用到同一条宿主）。 */
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
      if (o.userData && o.userData["ha3dNestedStandalone"] && o.userData.focusEntityId) {
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

  window.ha3dNestedProbe = function () {
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

  /* 地板探测：模型底面 y=0 是"记录坐标的地面"，但 SPA 的地板网格可能被抬高
   * 或压厚，导致环形支撑看起来陷进去/浮起来。这里把所有"接近水平的薄片/大面"
   * mesh 的表面高度列出来，用来对照模型的 y=0 到底该对齐到哪。 */
  window.ha3dNestedFloors = function () {
    var scene = capturedScene;
    if (!scene) return { error: "no scene captured" };
    var T = borrowThree(scene);
    var hits = [];
    scene.traverse(function (o) {
      if (!o.isMesh || !o.geometry) return;
      if (isOwnPart(o)) return;
      var b = worldBounds(T, o);
      if (!b) return;
      var sx = b.max.x - b.min.x;
      var sy = b.max.y - b.min.y;
      var sz = b.max.z - b.min.z;
      /* 地板/基座特征：水平方向铺得开，垂直方向很薄 */
      if (sx < 1.5 || sz < 1.5) return;
      if (sy > 0.5) return;
      hits.push({
        name: o.name || "(unnamed)",
        geo: (o.geometry.type || "?"),
        minY: +b.min.y.toFixed(4),
        maxY: +b.max.y.toFixed(4),
        thickness: +sy.toFixed(4),
        sizeXZ: [+sx.toFixed(2), +sz.toFixed(2)],
        visible: o.visible !== false,
      });
    });
    hits.sort(function (a, b2) { return b2.maxY - a.maxY; });
    return hits;
  };

  /* 垂直定位诊断：回答"模型底面到底在哪、原生宿主的最低点是多少"。
   * 穿地排查用：如果 groundY 明显为负，说明 baseY 采纳了错误的宿主值。 */
  window.ha3dNestedGround = function () {
    var scene = capturedScene;
    if (!scene) return { error: "no scene captured" };
    var T = borrowThree(scene);
    var out = [];
    Object.keys(entries).forEach(function (uid) {
      var entry = entries[uid];
      var rec = entry.furniture || {};
      var model = null;
      var container = null;
      scene.traverse(function (o) {
        if (!model && o.userData && o.userData[MODEL_FLAG]) {
          model = o;
          container = o.parent;
        }
      });
      var stock = findStockAnchor(scene, T, entry, uid);
      var box = model ? worldBoundsOfObject(T, model) : null;
      out.push({
        uid: uid,
        modelId: rec.modelId,
        size: rec.width && rec.depth && rec.height ? [rec.width, rec.depth, rec.height] : null,
        containerY: container ? container.position.y : null,
        containerScale: container ? [container.scale.x, container.scale.y, container.scale.z] : null,
        modelMinY: box ? box.min.y : null,
        modelMaxY: box ? box.max.y : null,
        stockMinY: stock ? stock.min.y : null,
        stockFound: !!stock,
      });
    });
    return out;
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
