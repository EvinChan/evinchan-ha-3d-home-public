# Evinchan HA 3D Home（集成版 / Integration）

Home Assistant 的 **3D 户型图可视化与控制中心**。本仓库为**集成（Integration）**形态，兼容 HACS 分发，安装后在左侧侧边栏出现「3D Home」面板。

> 支持 Home Assistant **2025.1 及以上**版本。

## 特性

- 3D 户型可视化（楼层 / 墙体 / 房间 / 门窗 / 家具）
- 实体**实时状态同步**（WebSocket 推送，亚秒级）
- 设备控制（开关、灯光、窗帘、覆盖层等）
- **房间设备面板**：点击户型中的任意区域，右侧滑出该区域全部已绑定设备的卡片（含开关、亮度滑杆、窗帘开度、温度步进），随状态实时刷新
- **灯光渐亮 / 渐灭动画**：开灯时场景灯光按缓动曲线逐渐亮起，关灯时渐暗，避免硬切
- **深色科技风主题**：深蓝底 + 橙色高亮的玻璃拟态界面
- **窗帘开度联动**：通过 companion `sensor`（开度）/ `event`（开合完成）/ 工作状态自动映射到 `cover` 实体
- **天气面板**（forecast 写入天气实体 `attributes.forecast`）
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

### 方式一：HACS（推荐）

1. HACS → 集成 → 搜索「Evinchan HA 3D Home」→ 下载。
2. **重启 Home Assistant**（新增集成必须完整重启）。
3. 设置 → 设备与服务 → 添加集成 → 搜索「3D Home」完成配置。

> 若尚未出现在 HACS 默认列表中，可先手动添加一次自定义仓库：
> HACS → 右上角菜单 → 自定义仓库 → `https://github.com/EvinChan/evinchan-ha-3d-home-public` → 类别 **Integration**。

### 方式二：手动

将 `custom_components/evinchan_ha_3d_home/` 复制到 HA 配置目录的 `custom_components/` 下，重启 HA，再按方式一第 3 步添加。

## 项目结构

```
evinchan-ha-3d-home-public/
├── custom_components/evinchan_ha_3d_home/   # 集成代码（domain == 目录名）
│   ├── __init__.py        # 轻量 setup 编排；重模块延迟导入
│   ├── const.py           # DOMAIN / 前缀 / 面板 / 存储键
│   ├── config_flow.py     # 配置流（log_level 选项）
│   ├── strings.json       # 配置流源语言字符串
│   ├── translations/      # en / zh-Hans
│   ├── schema.py          # 平面图 schema 的 Python 端口
│   ├── project_store.py   # 基于 HA Store 的项目持久化
│   ├── ha_client.py       # 进程内 HA 桥：实体快照 / 事件 / 广播 / 联动
│   ├── views.py           # REST API + 静态资源视图
│   ├── gateway.py         # WebSocket 网关（合并推送）
│   ├── panel.py           # iframe 面板注册
│   ├── manifest.json      # 集成清单
│   ├── brand/icon.png     # HACS 品牌图标（Check brands 校验此处）
│   └── www/               # 预构建前端 SPA（Vite 产物）
├── brand/icon.png                  # 仓库展示用图标
├── .github/workflows/validate.yml  # HACS Action + Hassfest 校验
├── hacs.json
├── README.md
├── info.md                # HACS 更新日志
├── CHANGELOG.md
└── LICENSE                # MIT
```

## 许可证

本仓库采用 [MIT License](LICENSE)：允许自由使用、修改与再分发（包括商用），只需保留版权声明与许可文本。

Python 集成源码以明文提供，便于审计与二次开发；`www/assets/` 中的前端 SPA 是预构建并混淆的产物，前端改动请在源码工程中完成后重新构建。

## 前端说明

前端 SPA 是**预构建产物**，随集成一起分发：

- **path-aware**：SPA 从 `window.location.pathname` 推导 API/WS 基址，因此后端改前缀无需改前端。
- **不要直接修改 `www/assets/`**：该目录会在每次发布时被重新生成并覆盖。
- `www/index.html` 为入口；`www/*.css` 提供主题与昼夜配色（`scene-colors.css` 定义 CSS 变量），`www/license-guard.js` 为许可校验脚本。
- 主题与面板布局联动：房间面板打开时给 `<body>` 加 `ha3d-room-panel-open`，`ui-theme.css` 据此收缩 `.home-scene` 右侧宽度，避免遮挡。

## 仓库与支持

- GitHub（HACS 分发源）：<https://github.com/EvinChan/evinchan-ha-3d-home-public>
- Gitee 镜像：<https://gitee.com/evinchan/evinchan-ha-3d-home-public>
- 问题反馈：<https://github.com/EvinChan/evinchan-ha-3d-home-public/issues>
- 最低 HA 版本：`2025.1.0`（见 `hacs.json` / `manifest.json`）
