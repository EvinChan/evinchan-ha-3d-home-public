# Evinchan HA 3D Home（集成版 / Integration）

Home Assistant 的 **3D 户型图可视化与控制中心**。本仓库为**集成（Integration）**形态，兼容 HACS 分发，安装后在左侧侧边栏出现「3D Home」面板。

> 支持 Home Assistant **2025.1 及以上**版本。

## 特性

- 3D 户型可视化（楼层 / 墙体 / 房间 / 门窗 / 家具）
- 实体**实时状态同步**（WebSocket 推送，亚秒级）
- 设备控制（开关、灯光、窗帘、覆盖层等）
- **房间设备面板**：点击户型中的任意区域，右侧滑出该区域全部已绑定设备的卡片（含开关、亮度滑杆、窗帘开度、温度步进），随状态实时刷新
- **灯光渐亮 / 渐灭动画**：开灯时场景灯光按缓动曲线逐渐亮起，关灯时渐暗，避免硬切
- **深色科技风主题**：深蓝底 + 橙色高亮的玻璃拟态界面（无需重建前端，通过主题补丁覆盖）
- **窗帘开度联动**：通过 companion `sensor`（开度）/ `event`（开合完成）/ 工作状态自动映射到 `cover` 实体
- **天气面板**（保留，forecast 写入天气实体 `attributes.forecast`）
- 户型项目持久化（HA `Store`，落 `.storage`）
- 全程运行于 HA **进程内**，无需 token、无需独立容器、无需连接

## 架构速览

```
HA Core 进程
┌──────────────────────────────────────────────────────────────┐
│  www/ SPA (React+R3F, 预构建)  ──iframe──► 侧边栏「3D Home」   │
│      │ path-aware: 从 /api/evinchan_ha_3d_home/ 推导 API/WS    │
│      ├─ REST  ──► views.py (ThreeDHomeApiView)                │
│      └─ WS    ──► gateway.py (WebSocket 网关)                 │
│                         ▲ 广播                                 │
│  ha_client.py 监听 EVENT_STATE_CHANGED → _broadcast ──────────┘│
│  project_store.py 持久化户型  ◄── views.py (projects/*)        │
└──────────────────────────────────────────────────────────────┘
```

## 安装

### 方式一：HACS
1. HACS → 集成 → 右上角菜单 → 自定义仓库，添加**本仓库地址**（类别：集成）。
2. 搜索「Evinchan HA 3D Home」并安装，重启 HA。
3. 设置 → 设备与服务 → 添加集成 → 搜索「3D Home」完成配置。

### 方式二：手动
将 `custom_components/evinchan_ha_3d_home/` 复制到 HA 配置目录的 `custom_components/` 下，重启 HA，再按方式一第 3 步添加。

## 项目结构

```
evinchan-ha-3d-home-integration/
├── custom_components/evinchan_ha_3d_home/   # 集成代码（domain == 目录名）
│   ├── __init__.py        # 轻量 setup 编排；重模块在 async_setup_entry 延迟导入
│   ├── const.py           # DOMAIN / 前缀 / 面板 / 存储键 常量
│   ├── config_flow.py     # 配置流（仅 log_level 选项）
│   ├── schema.py          # 平面图 schema 的 Python 端口（@ha3d/schema）
│   ├── project_store.py   # 基于 HA Store 的项目持久化
│   ├── ha_client.py       # 进程内 HA 桥：实体快照/事件监听/广播/窗帘联动/天气
│   ├── views.py           # REST API + 静态资源视图
│   ├── gateway.py         # WebSocket 网关（合并推送）
│   ├── panel.py           # iframe 面板注册
│   ├── translations/      # en / zh-Hans
│   └── www/               # 预构建前端 + 注入式补丁脚本
├── hacs.json
├── README.md
├── info.md                # HACS 更新日志
├── LICENSE                # 源码可见但限制再分发 / 商用
├── OBFUSCATION.md         # 源码保护策略（许可证 + PyArmor）
├── obfuscate.sh           # 在目标 HA 环境生成混淆版
└── .github/workflows/validate.yml   # HACS 官方校验
```

## 许可证与源码保护

本仓库采用「**源码可见但限制再分发 / 商用**」的许可证（见 `LICENSE`）：

- 允许个人非商业安装、使用，以及为学习 / 透明性阅读源码；
- 禁止修改后再分发、禁止在 HACS / GitHub 等渠道发布衍生版本、禁止商用。

如需进一步技术屏障，维护者可参照 `OBFUSCATION.md` 在**与目标 HA 相同的环境**中执行 `obfuscate.sh`（PyArmor）生成防护版。**对外下载版发布的是受许可证保护的可读源码**，因为 HA 直接 `import` 源码，且 PyArmor 运行时与平台 / Python 版本绑定，无法在本机混淆后直接发布到用户 HA。

## 前端说明（重要）

前端 SPA 是**预构建产物**（提取自镜像 `docker.jmglink.cn/jmglink-ha-3d`，内置在 `www/`），**不重新构建**：

- **path-aware**：SPA 从 `window.location.pathname` 推导 API/WS 基址，因此后端改前缀无需改前端。
- **禁止直接修改 `www/assets/`**。任何前端行为增强通过新增 `www/*.js` 补丁脚本或 `www/*.css` 主题，并在 `www/index.html` 入口前引入（运行时注入）。现有补丁：

  | 文件 | 作用 |
  |------|------|
  | `number-input-fix.js` | 数字输入框行为修正 |
  | `view-orbit-fix.js` | 编辑视角手动旋转 |
  | `live-state-fast.js` | 状态同步低延迟 |
  | `room-panel.js` | 点击区域后右侧滑出该区域全部设备卡片，支持直接操作与实时刷新 |
  | `light-fade.js` | 灯具开关时场景灯光 intensity 缓动渐亮/渐灭 |
  | `ui-theme.css` | 深色科技风主题（重定义 SPA 的 CSS 变量 + 关键容器覆盖） |

- 主题与面板的布局联动：`room-panel.js` 打开时给 `<body>` 加 `ha3d-room-panel-open`，`ui-theme.css` 据此收缩 `.home-scene` 右侧宽度（变量 `--ha3d-room-panel-w`），确保不遮挡 SPA 自带的右侧面板。
- 调试开关：浏览器控制台设置 `window.HA3D_ROOM_PANEL_DEBUG = true` 或 `window.HA3D_LIGHT_FADE_DEBUG = true` 可打印补丁日志。

## 仓库

- 本仓库即为 HACS 自定义仓库来源；新建后请将其 GitHub / Gitee 地址添加到 HACS。
- 最低 HA 版本：`2025.1.0`（见 `hacs.json` / `manifest.json`）
