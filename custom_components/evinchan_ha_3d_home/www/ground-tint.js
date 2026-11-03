/*
 * 地面（楼板）颜色覆盖：白天 #7784a8 / 夜晚 #1f2447。
 *
 * 为什么不能靠改调色板
 *   地面色来自 SPA 里的调色板函数 Nt(theme, mode, style)，楼板实际用的是
 *   「地基色 foundation」与「地面色 ground」的线性混合：
 *
 *     c = theme==="night"||mode==="shade"||"security"
 *           ? d.foundation
 *           : T(d.foundation, d.ground, 0.28)     // 浅色模式的前景地板
 *
 *   Nt 是压缩产物里的模块内函数，没挂在 window 上，改不到；直接改
 *   assets/*.js 又会在升级 SPA 时被覆盖。所以这里走**场景层**：不碰调色板，
 *   直接改楼板 mesh 的材质颜色，升级 SPA 也不受影响。
 *
 * 为什么能稳定认出楼板
 *   Va（楼板组件）的渲染结构有指纹，且都不是常见值：
 *     - 外层 group：renderOrder = -2
 *     - 子 mesh：rotation.x = -PI/2（平面躺倒）
 *     - 材质：meshPhysicalMaterial / meshToonMaterial
 *   比"按颜色认"稳得多，也不会误伤墙、家具和下沉阴影层 Ua（renderOrder=-5）。
 *
 * 注意
 *   - cartoon / cream 风格的地板在 SPA 里根本不用上面那套色，为保持原风格
 *     不动，这里对它们不生效（见 isStudioStyle）。
 *   - 描边层（Edges）是独立 mesh 且不在 renderOrder=-2 组下，不会被一起染色。
 *
 * Debug: window.ha3dGroundDebug / window.ha3dGroundTint.apply()
 */
(function () {
  "use strict";

  if (window.__ha3dGroundTint) return; // 幂等

  var VERSION = 37;

  /* 目标地面色（用户指定）。以下均为运行时配置，
   * 会被 scene-colors.css 的 --sc-* 变量覆写（见 loadColorConfig） */
  var DAY_TARGET = "#7784a8"; // rgb(119,132,168)
  var NIGHT_TARGET = "#2a3057"; // rgb(42,48,87) 房间地板（夜间，深蓝紫）
  var SLAB_NIGHT_TARGET = "#454e8f"; // rgb(69,78,143) 楼板外沿厚度（夜间，亮一档靛蓝）
  var SLAB_DAY_TARGET = "#7784a8"; // 白天楼板（默认跟随日间地板色）
  var POOL_GLOW = 1.1; // 夜间光池自发光强度
  var POOL_ENABLED = true; // --sc-pool-enable: 0 可整体关闭光池（排查崩溃用）

  var stats = {
    version: VERSION,
    calls: 0,
    patched: 0,
    restored: 0,
    errors: 0,
    lastError: null,
  };
  window.ha3dGroundDebug = stats;

  function hexToRgb(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (!isFinite(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /* 卡通 / 米色风格在 SPA 里用的是另一套地板色（不经过 ground 混合），
     为保持原有风格配色，这里不动它们。 */
  function isStudioStyle() {
    if (document.querySelector(".visual-style-cartoon")) return true;
    if (document.querySelector(".visual-style-cream")) return true;
    return false;
  }

  function isDarkScene() {
    /* 白天 / 夜晚由 .theme-night 挂在祖先节点上决定 */
    if (document.querySelector(".theme-night")) return true;
    /* 场景模式 shade / security 在 SPA 里也走深色分支 */
    if (document.querySelector(".scene-mode-shade, .scene-mode-security")) {
      return true;
    }
    return false;
  }

  /* ------------------------------------------------ 页面背景昼夜切换 */
  /* SPA 的昼夜主题来自 HomeView 的 Qt()：本地时钟 7:00–17:59 为 "day"，
     其余为 "night"，每 60s 重算一次。但它只作为 React prop 进 3D 画布，
     presentation 模式下场景内不挂背景色，可见背景是 .home-scene 的 CSS
     渐变（ui-theme.css），且 .home-scene 的 className 不随昼夜变化。
     所以这里按**同一时钟规则**给 .home-scene / .home-workspace 挂/摘
     .ha3d-night，让页面背景跟着入夜。节流：最多每 10s 重估一次。 */
  var SKY_NIGHT_CLASS = "ha3d-night";
  var skyLastCheck = 0;
  var skyWasNight = null;
  var forceMode = null; // 调试：ha3dGroundTint.mode("day"|"night"|null) 强制覆盖时钟

  function isNightByClock() {
    if (forceMode === "day") return false;
    if (forceMode === "night") return true;
    var h = new Date().getHours();
    return !(h >= 7 && h < 18); // 与 SPA Qt() 完全一致
  }

  function applySkyTheme(force) {
    var now = Date.now();
    if (!force && now - skyLastCheck < 10000) return;
    skyLastCheck = now;
    var night = isNightByClock();
    /* 不能做「状态没变就跳过」的早退：React 可能随时重挂 .home-scene
     * （boot 首跑时它甚至还不存在，skyWasNight 却已被置位，此后永远补不上）。
     * classList.toggle(cls, force) 幂等，10s 一次的 querySelectorAll 开销可忽略。 */
    var nodes = document.querySelectorAll(".home-scene, .home-workspace");
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].classList.toggle(SKY_NIGHT_CLASS, night);
    }
    skyWasNight = night;
    stats.skyNight = night;
  }

  /* -------------------------------------------------- 场景扫描与着色 */
  var FLOOR_NAME = "ha3d-floor-tint";
  var ORIGINAL = "ha3d-floor-original";
  var STATE = "ha3d-floor-state"; // 当前着色态："day" | "night" | "night-slab" | "lit"
  var LIT_TEX = "ha3d-floor-lit-tex"; // per-room 克隆的渐变纹理（UV 已归一化）
  var ORIG_MAP = "ha3d-floor-orig-map"; // SPA 原始贴图（一般为 null），还原用
  var PAINT_MAT = "ha3d-floor-paint-mat"; // per-mesh 克隆材质（避免共享材质拉锯）
  var PAINT_ORIGMAT = "ha3d-floor-paint-origmat"; // 克隆前的共享材质引用
  var LIT_HOLD = "ha3d-floor-lit-hold"; // 灯光命中防抖（保持到该时间戳）

  function getScene() {
    return window.__ha3dCapturedScene || null;
  }

  /* 注意：必须用 Color.set('#rrggbb') 而不是 setRGB(r/255, ...)。
   *
   * 这个 SPA 的 renderer 输出 sRGB，three r152+ 下 Color.set() 会把 sRGB 十六进制
   * **正确地**转换进线性工作空间；而 setRGB() 默认把入参当作**线性值**，
   * 传 119/255 会被再转一次，实测出来是 #b6bed4（明显偏亮）而不是 #7784a8。
   * 这正是本补丁第一版着色"看起来没生效"的原因。 */
  function paint(root, hex, night, lightPts) {
    var changed = 0;
    if (!hexToRgb(hex)) return 0;
    root.traverse(function (o) {
      if (!o || o.type !== "Mesh" || !o.material) return;
      if (!o.userData || o.userData[FLOOR_NAME] !== true) return;
      var isRoom = !!(o.geometry && o.geometry.type === "ShapeGeometry");
      /* 开灯光池只落在房间地板上（ShapeGeometry），楼板永远走纯色。
       * 昼夜都有光池（设计稿白天开灯房间地板也是暖米色），只是实现不同：
       * 夜间用 emissiveMap 自发光（环境光暗，diffuse 会被压暗），
       * 白天用 map 漫反射（环境光亮，自发光反而会过曝）。 */
      var lit = !!(isRoom && lightPts && lightPts.length && underAnyLight(o, lightPts));
      /* 防抖：灯光命中状态保持 5 秒，避免边界房间逐帧抖动触发反复重编译 */
      if (lit !== !!o.userData[LIT_HOLD]) {
        if (lit) o.userData[LIT_HOLD] = Date.now() + 5000;
        else if (Date.now() < (o.userData[LIT_HOLD] || 0)) lit = true; // 保持期内视为仍开灯
        else o.userData[LIT_HOLD] = 0;
      }
      var want = lit ? (night ? "lit" : "lit-day") : night ? (isRoom ? "night" : "night-slab") : "day";
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.length !== 1) return; // 多材质网格暂不处理
      /* 材质可能被多个房间共享（同一 floorMaterialId），而各房间 lit/night/day
       * 状态不同 → 共享材质被逐帧改 emissiveMap + needsUpdate → 每帧重编译
       * 着色器 → three 在 getProgram 崩溃（"setting 'value' of undefined"）。
       * 所以 paint 一律用 per-mesh 克隆材质，原始材质仅作还原依据。 */
      var m = o.userData[PAINT_MAT];
      if (!m) {
        o.userData[PAINT_ORIGMAT] = mats[0];
        try {
          m = mats[0].clone();
          m.userData = {}; // 不继承旧状态戳，克隆后首次应用会重新记录
        } catch (err) {
          m = mats[0]; // 克隆失败退回共享材质（可能重现拉锯，但不崩）
        }
        o.userData[PAINT_MAT] = m;
        o.material = m;
      }
      /* 目标色/贴图期望：状态机之外**每帧校验实际值**。SPA 在房间聚焦/取消
       * 聚焦时会直接改写地板材质颜色（还原调色板），而我们的 STATE 戳不变
       * ——只看戳会永远跳过，地面就停在 SPA 写回的白天色（踩过的坑）。 */
      var expectColor =
        want === "lit" || want === "night"
          ? NIGHT_TARGET
          : want === "night-slab"
            ? SLAB_NIGHT_TARGET
            : want === "lit-day"
              ? "#ffffff"
              : isRoom
                ? DAY_TARGET
                : SLAB_DAY_TARGET;
      var mapOk =
        want === "lit"
          ? !!m.emissiveMap && !m.map
          : want === "lit-day"
            ? !!m.map && !m.emissiveMap
            : !m.emissiveMap && !m.map;
      if (
        m.color.getHexString &&
        "#" + m.color.getHexString() === expectColor &&
        mapOk
      ) {
        return;
      }
      m.userData[STATE] = want;
      var hadMap = !!m.map;
      var hadEmissive = !!m.emissiveMap;
      if (want === "lit" || want === "lit-day") {
        var baseTex = getLightTexture(root, night);
        var lt = null;
        if (baseTex) {
          /* ShapeGeometry 的 UV 是原始米坐标而非 0-1！不归一化的话渐变只在
           * 原点附近 1m 内可见、其余被 ClampToEdge 钳成棕色块（踩过的坑）。
           * 按几何包围盒 per-room 克隆并设置 repeat/offset，铺满整个房间，
           * 等效 CSS radial-gradient 的 ellipse at center。 */
          var cached = m.userData[LIT_TEX];
          if (cached && cached.night === night && cached.epoch === poolTexEpoch && cached.tex) {
            lt = cached.tex;
          } else {
            try {
              lt = baseTex.clone();
              var g2 = o.geometry;
              if (!g2.boundingBox) g2.computeBoundingBox();
              var bw = Math.max(1e-4, g2.boundingBox.max.x - g2.boundingBox.min.x);
              var bh = Math.max(1e-4, g2.boundingBox.max.y - g2.boundingBox.min.y);
              lt.repeat.set(1 / bw, 1 / bh);
              lt.offset.set(-g2.boundingBox.min.x / bw, -g2.boundingBox.min.y / bh);
              lt.needsUpdate = true;
            } catch (err) {
              lt = null;
            }
            m.userData[LIT_TEX] = { night: night, epoch: poolTexEpoch, tex: lt }; // tex=null 标记克隆失败，避免每帧重试
          }
        }
        if (want === "lit") {
          m.color.set(NIGHT_TARGET);
          if (m.emissive && m.emissive.set) m.emissive.set("#ffffff");
          if ("emissiveIntensity" in m) m.emissiveIntensity = POOL_GLOW;
          m.map = null;
          m.emissiveMap = lt || null;
          if (!m.emissiveMap && m.emissive && m.emissive.set) {
            /* 借不到 Texture 构造器时退化为暖色纯发光 */
            m.emissive.set("#a89484");
          }
        } else {
          /* 白天光池：漫反射贴图，颜色取白色让渐变本色显示 */
          m.color.set("#ffffff");
          if (m.emissive && m.emissive.set) m.emissive.set("#000000");
          m.emissiveMap = null;
          m.map = lt || null;
        }
      } else {
        if (m.emissiveMap) m.emissiveMap = null;
        if (m.emissive && m.emissive.set) m.emissive.set("#000000");
        if ("emissiveIntensity" in m) m.emissiveIntensity = 1;
        m.color.set(
          want === "night-slab"
            ? SLAB_NIGHT_TARGET
            : want === "night"
              ? NIGHT_TARGET
              : isRoom
                ? DAY_TARGET
                : SLAB_DAY_TARGET
        );
      }
      /* 只有贴图槽位真正变化才 needsUpdate（着色器重编译很贵）；
       * 与 SPA 的颜色拉锯只需要 setColor，每帧做也不重编译。
      * 但凡涉及 emissiveMap/map 的状态：无条件 needsUpdate —— emissiveMap
      * 赋值后若 program 未重编译，refreshMaterialUniforms 会在
      * T.emissiveMap.value 上崩（"setting 'value' of undefined"，踩过的坑）。
      * per-mesh 克隆下状态只在真实变化时进入本分支，重编译频率可控。 */
      if (want === "lit" || want === "lit-day") m.needsUpdate = true;
      else {
        var mapChanged = hadMap || hadEmissive;
        if (mapChanged) m.needsUpdate = true;
      }
      changed += 1;
    });
    return changed;
  }

  /* ---------------- 渲染自愈安全网 ----------------
   * SPA 每帧动画会写地板材质（颜色/透明度），与我们的 emissiveMap/map 写入
   * 之间存在 program ↔ 材质状态的时序错位：材质带着 emissiveMap 渲染时，
   * program 可能还是没编译它的旧版 → refreshMaterialUniforms 在
   * T.emissiveMap.value 上崩（"setting 'value' of undefined"）。
   * 赋值侧无论怎么补 needsUpdate 都可能被时序击穿，所以在渲染入口装
   * 自愈网：崩溃 → 给所有带 emissiveMap/map 的材质补 needsUpdate → 重试
   * 一次（只重试一次，真崩仍抛出）。实测崩溃从此归零。 */
  var GL_HEAL_FLAG = "__gtHeal";
  var glHealCount = 0;

  function installRenderHeal(root) {
    var gl = root && root.__r3f && root.__r3f.root && root.__r3f.root.getState().gl;
    if (!gl || gl[GL_HEAL_FLAG]) return;
    gl[GL_HEAL_FLAG] = true;
    var origRender = gl.render;
    gl.render = function (scene, camera) {
      try {
        return origRender.call(this, scene, camera);
      } catch (e) {
        if (String(e.message).indexOf("setting") < 0) throw e;
        var fixed = 0;
        scene.traverse(function (o) {
          if (!o.material) return;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i += 1) {
            var m = mats[i];
            if (m && (m.emissiveMap || m.map)) {
              m.needsUpdate = true;
              fixed += 1;
            }
          }
        });
        glHealCount += 1;
        stats.glHeals = glHealCount;
        requestRender();
        /* 重试一次：修复后若再崩则静默吞掉（跳过本帧渲染，下一帧自愈网
         * 继续兜底；不吞的话 SPA 过渡窗口期会刷 uncaught 报错） */
        try {
          return origRender.call(this, scene, camera);
        } catch (e2) {
          if (String(e2.message).indexOf("setting") < 0) throw e2;
          return null;
        }
      }
    };
  }

  /* ---------------- 夜间墙体/玻璃染色 ----------------
   * SPA 的夜间调色板墙色是浅灰蓝（#d7e2f1 系），设计稿里墙和玻璃是紫蓝
   * 半透明。所有 transparent 且 opacity<0.55 的材质（墙/窗/玻璃家具）夜间
   * 统一染成 #7f88c4；白天还原原色。地面 mesh 不在此列（paint 另行处理）。 */
  var WALL_FLAG = "ha3d-tint-wall";
  var WALL_ORIG = "ha3d-tint-wall-orig";
  var WALL_OPAC = "ha3d-tint-wall-opac";
  var WALL_NIGHT = "#7f88c4";
  var WALL_DAY = null; // null = 白天不染色（还原 SPA 原色），由 --sc-wall-day 配置
  var wallDayAlpha = null;

  /* ---- 墙体顶部轮廓（线框描边）染色 ----
   * SPA 把墙顶轮廓画成独立的 LineSegments（EdgesGeometry + LineBasicMaterial，
   * 调色板里的 wallEdgeColor）。这里对场景内全部线框对象按昼夜染色；
   * 家具描边如果也是线框会被一起染——设计稿里家具描边同样偏紫蓝，通常正好。
   * 变量缺失（null）时还原 SPA 原色。 */
  var EDGE_FLAG = "ha3d-tint-edge";
  var EDGE_ORIG = "ha3d-tint-edge-orig";
  var EDGE_NIGHT = null; // 由 --sc-wall-edge-night 配置
  var EDGE_DAY = null; // 由 --sc-wall-edge-day 配置

  function tintEdges(root, night) {
    var target = night ? EDGE_NIGHT : EDGE_DAY;
    root.traverse(function (o) {
      var isLine = o && (o.isLineSegments || o.isLine || o.type === "LineSegments" || o.type === "Line");
      if (!isLine || !o.material || !o.material.color || !o.material.color.set) return;
      var m = o.material;
      if (target) {
        if (o.userData[EDGE_FLAG] !== true) {
          o.userData[EDGE_FLAG] = true;
          if (o.userData[EDGE_ORIG] === undefined && m.color.getHexString) {
            o.userData[EDGE_ORIG] = "#" + m.color.getHexString();
          }
        } else if (m.color.getHexString && "#" + m.color.getHexString() === target) {
          return; // 已是目标色（每帧校验，SPA 改写后能自动纠正）
        }
        m.color.set(target);
      } else if (o.userData[EDGE_FLAG] === true) {
        o.userData[EDGE_FLAG] = false;
        var orig = o.userData[EDGE_ORIG];
        if (typeof orig === "string") m.color.set(orig);
      }
    });
  }

  function isHorizontalWorld(o) {
    try {
      var e = o.matrixWorld.elements;
      return Math.abs(e[10]) > 0.9; // Z 轴世界朝向 ≈ ±Y → 水平面
    } catch (err) {
      return false;
    }
  }

  function tintTranslucent(root, night) {
    var target = night ? WALL_NIGHT : WALL_DAY;
    var alpha = night ? wallAlpha : wallDayAlpha;
    root.traverse(function (o) {
      if (!o || o.type !== "Mesh" || !o.material) return;
      if (o.userData && o.userData[FLOOR_NAME] === true) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      for (var i = 0; i < mats.length; i += 1) {
        var m = mats[i];
        if (!m || !m.color || !m.color.set || !m.transparent || m.opacity >= 0.55) continue;
        if (target) {
          if (m.userData[WALL_FLAG] !== true) {
            m.userData[WALL_FLAG] = true;
            if (m.userData[WALL_ORIG] === undefined && m.color.getHexString) {
              m.userData[WALL_ORIG] = "#" + m.color.getHexString();
            }
            if (m.userData[WALL_OPAC] === undefined) m.userData[WALL_OPAC] = m.opacity;
            if (alpha !== null) m.opacity = alpha;
          } else if (
            m.color.getHexString &&
            "#" + m.color.getHexString() === target &&
            (alpha === null || m.opacity === alpha)
          ) {
            continue; // 已是目标色（每帧校验，SPA 改写后能自动纠正）
          }
          m.color.set(target);
          if (alpha !== null && m.opacity !== alpha) m.opacity = alpha;
        } else if (m.userData[WALL_FLAG] === true) {
          m.userData[WALL_FLAG] = false;
          var orig = m.userData[WALL_ORIG];
          if (typeof orig === "string") m.color.set(orig);
          if (m.userData[WALL_OPAC] !== undefined) m.opacity = m.userData[WALL_OPAC];
        }
      }
    });
  }

  /* ---------------- 开灯房间光池（夜间） ----------------
   * 判定：房间地板 XZ 包围盒内存在「点亮」的点光/射灯（intensity>0.05）。
   * 渐变纹理：借用场景里现成 Texture 实例的构造器（补丁拿不到 THREE 全局，
   * 与模型补丁 borrowThree 同思路），CanvasTexture 不可达但 base Texture
   * 可以直接吃 canvas。ShapGeometry 的 UV 覆盖房间包围盒，居中径向渐变
   * 正好形成「灯下亮、边缘融入夜色地板 #1f2447」的光池。 */
  /* 开灯光池渐变：夜间金黄发光，白天暖米色（设计稿餐厅地板）。
     边缘各自融入对应模式的地面色。 */
  var LIT_GRADIENT_NIGHT = [
    [0, "#f2d7a2"],
    [0.55, "#d3ab7c"],
    [0.85, "#6f604e"],
    [1, "#2a3057"],
  ];
  var LIT_GRADIENT_DAY = [
    [0, "#eed9b2"],
    [0.6, "#dcc39c"],
    [0.85, "#a8a89c"],
    [1, "#7784a8"],
  ];
  var litTexNight = null;
  var litTexDay = null;
  var litTexNightEpoch = -1; // 纹理构建时的配置纪元（配置变更则失效重建）
  var litTexDayEpoch = -1;
  var poolTexEpoch = 0; // 色标配置每成功解析一次就 +1
  var litTexNextTry = 0;
  var lightPtsCache = null;

  /* 只接受「纯 Texture / CanvasTexture」。场景里第一个带 map 的材质可能是
   * DataTexture（环境贴图）或 VideoTexture（摄像头画面）——用它们的构造器
   * new 一个出来是畸形纹理，GPU 上传时会在 three 的 setProgram/getProgram
   * 里抛 "Cannot set properties of undefined (setting 'value')"（踩过的坑）。 */
  function usableTextureCtor(Ctor) {
    try {
      var p = Ctor && Ctor.prototype;
      if (!p || p.isTexture !== true) return false;
      if (p.isDataTexture || p.isVideoTexture || p.isCompressedTexture) return false;
      if (p.isFramebufferTexture || p.isData3DTexture || p.isDataArrayTexture) return false;
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ---- THREE 命名空间：动态 import SPA 的 three 库 chunk ----
   * 场景里可能借不到任何普通 Texture 构造器（无贴图材质/无 shadow map 时，
   * 光池只能走纯色退化）。three 库本身是 ES module chunk（assets/three-*.js），
   * 动态 import 它的模块命名空间，从导出里扫出 Texture/CanvasTexture 构造器
   * ——从此光池纹理不再依赖场景运气。URL 通过 performance 资源记录发现
   * （chunk 文件名带 hash，写死会随 SPA 升级失效）。 */
  var THREE_NS = null;
  var THREE_NS_LOADING = false;

  function findThreeChunkUrl() {
    try {
      var entries = performance.getEntriesByType("resource");
      for (var i = entries.length - 1; i >= 0; i -= 1) {
        if (/three-[A-Za-z0-9_-]+\.js/.test(entries[i].name)) return entries[i].name;
      }
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function ensureThreeNamespace() {
    if (THREE_NS || THREE_NS_LOADING) return Promise.resolve(THREE_NS);
    var url = findThreeChunkUrl();
    if (!url) return Promise.resolve(null);
    THREE_NS_LOADING = true;
    return import(url)
      .then(function (mod) {
        var keys = Object.keys(mod);
        var Tex = null, CanvasTex = null;
        var found = { texture: null, canvasTexture: null };
        /* 注意：three 的 isTexture 标志在【构造函数】里设置，不在 prototype 上
         * （prototype 判定永远扫不中——踩过的坑）。所以逐个实例化验证，
         * try/catch 包住（WebGLRenderer 等构造器会抛错，属预期）。 */
        for (var i = 0; i < keys.length; i += 1) {
          var v = mod[keys[i]];
          if (typeof v !== "function") continue;
          try {
            var inst = new v({});
            if (
              inst &&
              inst.isTexture === true &&
              inst.isDataTexture !== true &&
              inst.isVideoTexture !== true &&
              inst.isCompressedTexture !== true
            ) {
              if (!Tex) {
                Tex = v;
                found.texture = keys[i];
              }
              if (inst.isCanvasTexture === true && !CanvasTex) {
                CanvasTex = v;
                found.canvasTexture = keys[i];
              }
            }
          } catch (err) {
            /* 非纹理类构造失败，属预期 */
          }
        }
        THREE_NS = { Texture: Tex, CanvasTexture: CanvasTex, found: found };
        THREE_NS_LOADING = false;
        return THREE_NS;
      })
      .catch(function () {
        THREE_NS_LOADING = false;
        return null;
      });
  }

  var poolLastReason = null; // 最近一次纹理构建结果（诊断用）

  function getLightTexture(root, night) {
    var cached = night ? litTexNight : litTexDay;
    var cachedEpoch = night ? litTexNightEpoch : litTexDayEpoch;
    if (cached && cachedEpoch === poolTexEpoch) {
      poolLastReason = "ok(缓存)";
      return cached;
    }
    /* 配置纪元变了：丢弃旧纹理与所有 per-room 克隆缓存 */
    if (night) litTexNight = null;
    else litTexDay = null;
    var now = Date.now();
    if (now < litTexNextTry) {
      /* 不覆盖 poolLastReason——它保存的是当初设置阀门的那次真实失败原因 */
      return null;
    }
    try {
      var Ctor = null;
      /* 首选：three 模块命名空间的 CanvasTexture / Texture（确定可用） */
      if (THREE_NS && THREE_NS.CanvasTexture) Ctor = THREE_NS.CanvasTexture;
      else if (THREE_NS && THREE_NS.Texture) Ctor = THREE_NS.Texture;
      /* 兜底：scene.environment（PMREM 环境贴图）是普通 Texture 的情况 */
      try {
        if (!Ctor && root.environment && root.environment.constructor && usableTextureCtor(root.environment.constructor)) {
          Ctor = root.environment.constructor;
        }
      } catch (err) {
        /* ignore */
      }
      if (!Ctor) {
        /* 借不到：5s 后重试（THREE_NS 可能仍在异步加载） */
        litTexNextTry = now + 5000;
        poolLastReason = "借不到 Texture 构造器（等 three 模块加载）";
        return null;
      }
      root.traverse(function (o) {
        if (Ctor || !o) return;
        try {
          var mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
          for (var i = 0; i < mats.length; i += 1) {
            var m = mats[i];
            if (!m) continue;
            var t = m.map || m.emissiveMap || m.envMap || m.alphaMap;
            if (t && t.constructor && usableTextureCtor(t.constructor)) {
              Ctor = t.constructor;
              return;
            }
          }
          /* 带阴影的灯有 shadow.map(WebGLRenderTarget)，其 .texture 也是 Texture 实例 */
          if (!Ctor && o.isLight && o.shadow && o.shadow.map && o.shadow.map.texture) {
            var st = o.shadow.map.texture.constructor;
            if (usableTextureCtor(st)) Ctor = st;
          }
        } catch (err) {
          /* 单个对象不可读就跳过 */
        }
      });
      if (!Ctor) {
        /* 场景借用也失败：5s 后重试 */
        litTexNextTry = now + 5000;
        poolLastReason = "场景里借不到 Texture 构造器";
        return null;
      }
      var c = document.createElement("canvas");
      c.width = c.height = 256;
      var ctx = c.getContext("2d");
      var g = ctx.createRadialGradient(128, 128, 8, 128, 128, 170);
      var stops = night ? LIT_GRADIENT_NIGHT : LIT_GRADIENT_DAY;
      for (var i = 0; i < stops.length; i += 1) {
        g.addColorStop(stops[i][0], stops[i][1]);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
      var tex = new Ctor(c);
      /* 兜底校验：实例必须真的是普通纹理（DataTexture 等的 image 结构不同） */
      if (!tex || tex.isTexture !== true || tex.isDataTexture || tex.isVideoTexture) {
        litTexNextTry = now + 5000;
        poolLastReason = "构造出的纹理校验失败";
        return null;
      }
      tex.needsUpdate = true;
      try {
        /* r152+ 的 colorSpace 是字符串 "srgb"（THREE.SRGBColorSpace），无需借枚举 */
        tex.colorSpace = "srgb";
      } catch (e) {
        /* 老版本走 encoding；失败也只是色略偏，不致命 */
      }
      if (night) {
        litTexNight = tex;
        litTexNightEpoch = poolTexEpoch;
      } else {
        litTexDay = tex;
        litTexDayEpoch = poolTexEpoch;
      }
    } catch (err) {
      litTexNextTry = Date.now() + 5000;
      poolLastReason = "构建异常: " + String(err && err.message ? err.message : err);
    }
    return night ? litTexNight : litTexDay;
  }

  /* 点亮的点光/射灯的世界 XZ 坐标（直接读 matrixWorld，不借 Vector3） */
  function scanLights(root) {
    var pts = [];
    root.traverse(function (o) {
      if (!o || !o.isLight) return;
      if (o.isAmbientLight || o.isHemisphereLight || o.isDirectionalLight) return;
      if (o.visible === false) return;
      var it = typeof o.intensity === "number" ? o.intensity : 0;
      if (it <= 0.05) return;
      var e = o.matrixWorld.elements;
      pts.push([e[12], e[14]]);
    });
    return pts;
  }

  /* 房间地板的世界 XZ 包围盒 [minX, maxX, minZ, maxZ] */
  function floorBoundsXZ(mesh) {
    try {
      var geo = mesh.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      var bb = geo.boundingBox;
      var e = mesh.matrixWorld.elements;
      var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (var i = 0; i < 8; i += 1) {
        var x = i & 1 ? bb.max.x : bb.min.x;
        var y = i & 2 ? bb.max.y : bb.min.y;
        var z = i & 4 ? bb.max.z : bb.min.z;
        var wx = e[0] * x + e[4] * y + e[8] * z + e[12];
        var wz = e[2] * x + e[6] * y + e[10] * z + e[14];
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz;
        if (wz > maxZ) maxZ = wz;
      }
      return [minX, maxX, minZ, maxZ];
    } catch (err) {
      return null;
    }
  }

  function underAnyLight(mesh, pts) {
    var bb = floorBoundsXZ(mesh);
    if (!bb) return false;
    var MARGIN = 0.3; // 灯贴墙时相邻房间也算（光晕本来就溢出门缝）
    for (var i = 0; i < pts.length; i += 1) {
      if (
        pts[i][0] >= bb[0] - MARGIN &&
        pts[i][0] <= bb[1] + MARGIN &&
        pts[i][1] >= bb[2] - MARGIN &&
        pts[i][1] <= bb[3] + MARGIN
      ) {
        return true;
      }
    }
    return false;
  }

  /* 让位：卡通/米色风格下把地面还原成 SPA 原本的配色。
     paint 现在用的是 per-mesh 克隆材质，所以直接把原始共享材质引用换回来
     （克隆体交给 GC），比逐项还原颜色/贴图更可靠。 */
  function restore(root) {
    var changed = 0;
    root.traverse(function (o) {
      if (!o || o.type !== "Mesh" || !o.material) return;
      if (!o.userData || o.userData[FLOOR_NAME] !== true) return;
      var clone = o.userData[PAINT_MAT];
      if (!clone) return;
      var origMat = o.userData[PAINT_ORIGMAT];
      if (origMat) o.material = origMat;
      o.userData[PAINT_MAT] = null;
      changed += 1;
    });
    return changed;
  }

  /* 标记「地面」相关的所有层。
   *
   * 实测场景里地面是**两层叠在一起**的，只改其中一层视觉上看不出变化：
   *
   *   1) 房间地面（真正占满视野的那层）—— ua 组件
   *      mesh(rotation.x=-PI/2, position.y≈0.025)
   *        geometry: ShapeGeometry（房间轮廓）
   *        material: MeshPhysicalMaterial，颜色取 project.materials 里
   *                  该房间 floorMaterialId 的 color（不是调色板！）
   *
   *   2) 楼板（露在户型外沿的底板）—— Va 组件
   *      group(renderOrder=-2)
   *        mesh(rotation.x=-PI/2, position.y≈-0.155)
   *        geometry: ExtrudeGeometry，材质 meshPhysicalMaterial
   *
   * 两者都要染色，否则会出现「外沿变了、房间内部还是原色」。
   * 用几何类型 + 躺倒姿态判定，不依赖压缩产物的变量名。
   */
  function isFlat(obj) {
    /* rotation.x ≈ -PI/2 表示平面躺倒（地面/楼板都是这么放的） */
    return Math.abs(obj.rotation && obj.rotation.x + Math.PI / 2) < 0.05;
  }

  function looksLikeRoomFloor(obj) {
    if (!obj.material) return false;
    if (!obj.geometry || obj.geometry.type !== "ShapeGeometry") return false;
    if (!isFlat(obj)) return false;
    /* 房间地面在 y≈0.025，楼板底下的对照面在 y≈-0.015，只取上表面 */
    return obj.position.y > 0.005 && obj.position.y < 0.06;
  }

  function looksLikeSlab(obj) {
    if (!obj.material) return false;
    if (!obj.geometry || obj.geometry.type !== "ExtrudeGeometry") return false;
    return isFlat(obj) && !!obj.parent && obj.parent.renderOrder === -2;
  }

  function tagFloors(scene) {
    var tagged = 0;
    scene.traverse(function (o) {
      if (!o || o.type !== "Mesh" || !o.material) return;
      if (!looksLikeRoomFloor(o) && !looksLikeSlab(o)) return;
      if (!o.userData) o.userData = {};
      o.userData[FLOOR_NAME] = true;
      tagged += 1;
    });
    return tagged;
  }

  /* demand 模式下 R3F 只在 invalidate 时重绘。
   * 低画质（render-quality < 高清）就是这个模式，不主动请求重绘的话，
   * 我们改完材质颜色画面**不会有任何变化**（本补丁踩过的坑）。 */
  function requestRender() {
    try {
      var scene = getScene();
      var root = scene && scene.__r3f && scene.__r3f.root;
      if (!root || typeof root.getState !== "function") return;
      var st = root.getState();
      if (st && typeof st.invalidate === "function") st.invalidate();
    } catch (err) {
      /* 重绘请求失败不影响下一次 tick 重新尝试 */
    }
  }

  function tick() {
    stats.calls += 1;
    try {
      applySkyTheme(false); // 节流 10s，时钟跨过 7/18 点时自动切日夜背景
      var scene = getScene();
      if (!scene) return;
      if (tagFloors(scene) === 0) return;
      /* 卡通/米色风格保持 SPA 原配色：把地面还原并让位 */
      if (isStudioStyle()) {
        if (restore(scene) > 0) {
          stats.restored += 1;
          window.__ha3dGroundTintApplied = null;
          requestRender();
        }
        tintTranslucent(scene, false); // 让位时墙/玻璃也还原
        tintEdges(scene, false); // 轮廓线还原
        return;
      }
      /* 夜晚判定：时钟（与 SPA Qt() 同规则）为主；shade/security 模式也走深色。
       * 但 mode("day"/"night") 强制预览时以 forceMode 为准——页面上残留的
       * .scene-mode-* 类会把 night 顶回 true，导致"背景切了白天、地面还是
       * 夜景"的分裂状态（踩过的坑）。 */
      var night = forceMode !== null ? isNightByClock() : isNightByClock() || isDarkScene();
      var hex = night ? NIGHT_TARGET : DAY_TARGET;
      /* 灯位每帧实时扫描：旋转/动画时地板包围盒也是本帧的 matrixWorld，
       * 若灯位用旧缓存，旋转会让未开灯区域被旧坐标"扫"进灯光范围，
       * 光池反复开关（踩过的坑）。scanLights 只遍历灯对象，开销可忽略。 */
      lightPtsCache = scanLights(scene);
      if (paint(scene, hex, night, POOL_ENABLED ? lightPtsCache : null) > 0) {
        stats.patched += 1;
        window.__ha3dGroundTintApplied = hex;
        requestRender();
      }
      /* 夜间把墙/窗/玻璃染成设计稿的紫蓝半透明 */
      tintTranslucent(scene, night);
      /* 墙顶轮廓线按昼夜染色 */
      tintEdges(scene, night);
      /* 渲染自愈安全网（幂等，装一次） */
      installRenderHeal(scene);
    } catch (err) {
      stats.errors += 1;
      stats.lastError = String(err && err.message ? err.message : err);
    }
  }

  /* ----------------------------------------------- 接入帧驱动 / rAF */
  var started = false;
  var rafId = null;

  function loop() {
    tick();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (started) return;
    started = true;
    /* 场景由模型补丁发布到 window.__ha3dCapturedScene。
       帧驱动（scene-origin-fix）的 R3F 订阅在渲染前执行，能保证换肤当帧生效；
       低画质下 SPA 用 frameloop="demand"，R3F 订阅不是每帧跑，故并行挂自有
       rAF 兜底（与 scene-origin-fix 的做法一致，两者互不干扰）。 */
    var origin = window.__ha3dSceneOriginFix;
    if (origin && typeof origin.register === "function") {
      origin.register("ground-tint", function () {
        tick();
      });
    }
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  /* 主题切换后立刻重涂一次（不用等下一帧） */
  function onThemeChange() {
    applySkyTheme(true); // 强制立即重估（跨过 7/18 点后首次交互即刻生效）
    tick();
  }

  function observeTheme() {
    if (typeof MutationObserver !== "function") return;
    var mo = new MutationObserver(onThemeChange);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      subtree: true,
    });
    if (document.body) {
      mo.observe(document.body, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true,
      });
    }
  }

  /* ---------------- 点击拾取（pick）----------------
   * 用 R3F store 里的 raycaster/camera 对点击位置求交，打印命中 mesh 的
   * 完整信息（几何类型/世界高度/透明度/颜色/是否与墙共材质）。 */
  var picking = false;
  function pickHandler(ev) {
    try {
      var scene = getScene();
      var root = scene && scene.__r3f && scene.__r3f.root;
      var st = root && typeof root.getState === "function" ? root.getState() : null;
      if (!st || !st.raycaster || !st.camera) {
        console.log("[ground-tint pick] R3F raycaster 不可用");
        return;
      }
      var canvas = ev.currentTarget || ev.target;
      var rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      var ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      st.raycaster.setFromCamera({ x: nx, y: ny }, st.camera);
      var hits = st.raycaster.intersectObjects(scene.children, true);
      if (!hits.length) {
        console.log("[ground-tint pick] 无命中");
        return;
      }
      var o = hits[0].object;
      var m = Array.isArray(o.material) ? o.material[0] : o.material;
      var wy = 0;
      try {
        wy = Math.round(o.matrixWorld.elements[13] * 100) / 100;
      } catch (err) {
        /* ignore */
      }
      var info = {
        geo: (o.geometry && o.geometry.type) || "?",
        worldY: wy,
        transparent: !!(m && m.transparent),
        opacity: m ? m.opacity : null,
        color: m && m.color ? "#" + m.color.getHexString() : null,
        horizontal: isHorizontalWorld(o),
        sharedWall: !!(m && m.userData && m.userData[WALL_FLAG] === true),
        name: o.name || "",
      };
      console.log("[ground-tint pick] 命中:", info);
      window.__ha3dLastPicked = info;
    } catch (err) {
      console.log("[ground-tint pick] err", err);
    }
  }

  /* ---------------- 颜色配置加载 ----------------
   * 唯一调色入口是 scene-colors.css 的 CSS 变量（:root { --sc-*: ... }）。
   * 颜色统一支持 rgba()/rgb()/#hex 三种写法；这里在启动/重载时读一次，
   * 归一化为内部 hex（three 的 per-frame 校验基于 getHexString）后覆写
   * 下方常量；变量缺失时保留内置默认，删掉任意一行都能安全回退。 */
  function parseColor(s) {
    /* "rgba(r,g,b,a)" / "rgb(r,g,b)" / "#rgb" / "#rrggbb" → {r,g,b,a}，失败 null */
    s = String(s || "").trim().toLowerCase();
    var m = s.match(/^#([0-9a-f]{3})$/);
    if (m) {
      var h = m[1];
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1,
      };
    }
    m = s.match(/^#([0-9a-f]{6})$/);
    if (m) {
      var h6 = m[1];
      return {
        r: parseInt(h6.slice(0, 2), 16),
        g: parseInt(h6.slice(2, 4), 16),
        b: parseInt(h6.slice(4, 6), 16),
        a: 1,
      };
    }
    m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      var p = m[1].split(",");
      if (p.length < 3) return null;
      var r = parseFloat(p[0]), g = parseFloat(p[1]), b = parseFloat(p[2]);
      var a = p.length > 3 ? parseFloat(p[3]) : 1;
      if ([r, g, b, a].some(function (x) { return !isFinite(x); })) return null;
      return { r: r, g: g, b: b, a: a };
    }
    return null;
  }

  function toHex(c) {
    var h = function (x) {
      var s = Math.round(Math.min(255, Math.max(0, x))).toString(16);
      return s.length < 2 ? "0" + s : s;
    };
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  function normColor(s) {
    var c = parseColor(s);
    return c ? toHex(c) : null;
  }

  /* 按顶层逗号切分——rgba(...) 内部的逗号不切（简单 split 会拆坏色标） */
  function splitTop(s, sep) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i += 1) {
      var ch = s[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      if (ch === sep && depth === 0) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  function parseStops(str) {
    /* "0% rgba(242,215,162,1), 55% rgba(...), ..." → [[0,"#f2d7a2"],...] */
    if (!str) return null;
    var out = [];
    var parts = splitTop(str, ",");
    for (var i = 0; i < parts.length; i += 1) {
      var m = parts[i].trim().match(/^([\d.]+)%\s+(.+)$/);
      if (!m) return null;
      var pos = parseFloat(m[1]) / 100;
      var c = normColor(m[2]);
      if (!isFinite(pos) || pos < 0 || pos > 1 || !c) return null;
      out.push([pos, c]);
    }
    return out.length >= 2 ? out : null;
  }

  function cssVar(name) {
    try {
      var s = getComputedStyle(document.documentElement).getPropertyValue(name);
      return s ? s.trim() : "";
    } catch (err) {
      return "";
    }
  }

  var wallAlpha = null; // --sc-wall-night 的 rgba alpha（<1 时应用到墙体透明度）

  function loadColorConfig() {
    var v = cssVar;
    var t;
    if ((t = normColor(v("--sc-floor-day")))) DAY_TARGET = t;
    if ((t = normColor(v("--sc-floor-night")))) NIGHT_TARGET = t;
    /* 白天楼板缺省跟随日间地板色 */
    if ((t = normColor(v("--sc-slab-day")))) SLAB_DAY_TARGET = t;
    else SLAB_DAY_TARGET = DAY_TARGET;
    if ((t = normColor(v("--sc-slab-night")))) SLAB_NIGHT_TARGET = t;
    if ((t = normColor(v("--sc-wall-night")))) {
      WALL_NIGHT = t;
      var wc = parseColor(v("--sc-wall-night"));
      wallAlpha = wc && wc.a < 1 ? wc.a : null;
    } else {
      wallAlpha = null;
    }
    /* 白天墙体：配置了才染色（alpha 同理），否则还原 SPA 原色 */
    if ((t = normColor(v("--sc-wall-day")))) {
      WALL_DAY = t;
      var dc = parseColor(v("--sc-wall-day"));
      wallDayAlpha = dc && dc.a < 1 ? dc.a : null;
    } else {
      WALL_DAY = null;
      wallDayAlpha = null;
    }
    /* 墙顶轮廓线：配置了才染色 */
    EDGE_NIGHT = normColor(v("--sc-wall-edge-night"));
    EDGE_DAY = normColor(v("--sc-wall-edge-day"));
    /* 墙顶金色光条功能已回退（墙顶面与整面墙共材质，无法单独染色） */
    /* 光池总开关：设 0/false/off 整体关闭光池（排查渲染崩溃用） */
    POOL_ENABLED = !/^(0|false|off)$/i.test(v("--sc-pool-enable") || "1");
    if ((t = v("--sc-pool-night-stops"))) {
      var pn = parseStops(t);
      if (pn) {
        LIT_GRADIENT_NIGHT = pn;
        poolTexEpoch += 1; // 色标变了：纹理与 per-room 克隆全部失效重建
      }
    }
    if ((t = v("--sc-pool-day-stops"))) {
      var pd = parseStops(t);
      if (pd) {
        LIT_GRADIENT_DAY = pd;
        poolTexEpoch += 1;
      }
    }
    var g = parseFloat(v("--sc-pool-glow"));
    if (isFinite(g) && g > 0) POOL_GLOW = g;
  }

  window.ha3dGroundTint = {
    version: VERSION,
    day: DAY_TARGET,
    night: NIGHT_TARGET,
    apply: onThemeChange,
    applied: function () {
      return window.__ha3dGroundTintApplied || null;
    },
    /* 页面背景当前是否处于夜间（时钟规则，与 SPA Qt() 一致） */
    skyNight: function () {
      return skyWasNight;
    },
    /* 调试：强制昼夜预览。mode("day") / mode("night") / mode(null) 恢复时钟 */
    mode: function (m) {
      if (m === "day" || m === "night" || m === null) forceMode = m;
      onThemeChange(); // 立即重涂地面/天空/墙体
      return forceMode;
    },
    /* 重读 scene-colors.css 配置并立即重涂（改完配置文件免刷新生效） */
    reload: function () {
      loadColorConfig();
      onThemeChange();
      return true;
    },
    /* 诊断：光池（开灯地板渐变）的配置与纹理状态。
       fallback=true 表示借不到 Texture 构造器、只能纯色发光（此时改色标无效，
       需要先解决纹理来源）。 */
    debugPool: function () {
      return {
        nightStops: LIT_GRADIENT_NIGHT,
        dayStops: LIT_GRADIENT_DAY,
        epoch: poolTexEpoch,
        nightTexReady: !!(litTexNight && litTexNightEpoch === poolTexEpoch),
        dayTexReady: !!(litTexDay && litTexDayEpoch === poolTexEpoch),
        threeNs: !!THREE_NS,
        threeFound: THREE_NS ? THREE_NS.found : null,
        lastReason: poolLastReason,
        fallbackColor: "#a89484",
      };
    },
    /* 诊断：列出场景中所有「高处水平面」候选（墙顶面识别的原始数据）。
       若顶面染色没生效，把本输出发我以校正启发式。 */
    debugTops: function () {
      var scene = getScene();
      if (!scene) return "no scene";
      var out = [];
      scene.traverse(function (o) {
        if (!o || o.type !== "Mesh" || !o.material) return;
        try {
          var e = o.matrixWorld.elements;
          var up = Math.abs(e[10]);
          var wy = e[13];
          if (up < 0.9 || wy < 0.2 || wy > 3.5) return;
          var m = Array.isArray(o.material) ? o.material[0] : o.material;
          if (!m || !m.color) return;
          out.push({
            geo: (o.geometry && o.geometry.type) || "?",
            worldY: Math.round(wy * 100) / 100,
            transparent: !!m.transparent,
            opacity: m.opacity,
            color: "#" + m.color.getHexString(),
            sharedWall: !!(m.userData && m.userData[WALL_FLAG] === true),
            name: o.name || "",
          });
        } catch (err) {
          /* ignore */
        }
      });
      return out;
    },
    /* 点击拾取：pick() 开关。开启后点击 3D 画布里想改颜色的面，
       控制台打印该 mesh 的完整信息——用于精确定位「墙顶面」等难识别对象。 */
    pick: function (on) {
      picking = typeof on === "boolean" ? on : !picking;
      var canvases = document.querySelectorAll("canvas");
      for (var i = 0; i < canvases.length; i += 1) {
        if (picking) canvases[i].addEventListener("click", pickHandler, true);
        else canvases[i].removeEventListener("click", pickHandler, true);
      }
      console.log("[ground-tint pick] " + (picking ? "已开启，点击画布上的目标面" : "已关闭"));
      return picking;
    },
  };

  function boot() {
    ensureThreeNamespace(); // 尽早开始加载 three 模块命名空间（异步）
    loadColorConfig();
    start();
    observeTheme();
    /* 场景可能晚于补丁就绪，重试若干次 */
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (getScene() || tries > 120) {
        clearInterval(timer);
        if (getScene()) onThemeChange();
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
