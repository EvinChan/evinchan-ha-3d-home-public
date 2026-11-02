# HA 3D JSON Skill 使用说明

## 这个 Skill 能做什么

它可以让 ChatGPT、Claude、Gemini 或其他 AI：

- 从文字或户型图生成新的 HA 3D 户型 JSON
- 根据已有 JSON 调整家具、房间和材质
- 检查 ID、房间、墙体、门窗和材质引用
- 在网络可达时通过接口创建或更新项目【需要打开HA服务端口访问】
- 无法连接时导出完整 JSON，手动导入 HA 3D

## 安装 Skill

1. 点击“下载 HA 3D Skill”下载 ZIP。
2. 直接告诉 AI 下载的zip 文件路径，让 AI 安装 Skill。

## 新建户型

把需求和 Skill 一起交给 AI，例如：

> 导入户型图纸让 AI 生成 JSON。生成可以导入 HA 3D 的完整 JSON。或者告诉AI自己提交到服务。

## 修改已有户型

先在 HA 3D 中点击“导出 JSON”，将文件交给 AI，并明确：

> 保留墙体和 Home Assistant 绑定，只把客厅沙发旋转 90 度并移动到电视柜对面。

## 导入方式

- **手动导入**：让 AI 返回完整 JSON，回到项目设置点击“导入 JSON”。
- **自动导入**：需要打开ha中的端口访问，获得3Dhome的IP端口并告诉AI！！！
