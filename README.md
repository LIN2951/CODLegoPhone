# Lego 小手机

一个在浏览器里运行的迷你互动手机模拟器：内置微信、朋友圈、推特、电话、购物、主题、系统设置等应用，支持接入 AI 接口（MiniMax 等）驱动好友聊天、语音通话与塔罗占卜等玩法。

## 运行

需要 Node.js（无框架依赖，原生 `http` 服务）：

```bash
node server.js
```

然后访问 <http://127.0.0.1:1030/>（默认端口 1030）。

Windows 也可以直接双击 `启动服务.bat`。

可选依赖：`npm install` 安装 `sharp` 后，商品图片会在服务端自动压缩；不安装也能运行（图片直接转发）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动服务（等同 `node server.js`） |
| `npm run build:html` | 将 `fragments/` 内联进 `index.html`，输出 `dist/index-inlined.html`（适合纯静态托管） |
| `npm run diagnose:api` | 诊断 API 连通性 |
| `npm run test:api-models` | API 模型相关测试 |
| `npm run test:proactive-message` | 主动消息相关测试 |
| `npm run create-icon` | 用 `icons/lego-source.jpg` 重新生成 PWA 图标（需要 `sharp`） |

## 目录结构

```
server.js              后端服务：静态文件 + AI/图片代理
index.html             手机主界面
app.js / *.js          前端各应用模块（微信、朋友圈、推特、电话等）
*.css                  样式
fragments/             运行时注入的 HTML 片段（构建时可内联）
assets/                字体、相机框、桌面图标等资源
icons/                 PWA / UI 图标
modules/milian-tarot/  塔罗占卜模块（自带上游引擎与测试）
scripts/               构建、测试、诊断、启动脚本
system_commands.json   系统指令
system_friend_*.json   内置 AI 好友人设
```

## 开源说明

- 项目不包含任何 API Key，AI 接口密钥由使用者在应用内自行填写。
- 若用于开源发布，请补充 `LICENSE` 文件。
