# 迷恋塔罗验收记录

日期：2026-09-11。交付版本：1.0.1；静态及牌面缓存 v2。

- 许可：连接器与锁定引擎的 ISC 原文已核验并保留；具体版本、资源范围与修改说明见 THIRD_PARTY_NOTICES.md。
- 模块规则：17 项通过，覆盖全部五种牌阵、78 张牌、正逆位、完整揭示、备份校验、原综合提取、文本转义与缓存作用域。
- 既有回归：主动消息 52 项、模型列表 22 项、音乐与 HTML 片段检查通过。
- 浏览器：Chrome 无头模式、全新随机端口/浏览器上下文、本机模拟 API，31 项检查通过，0 个未捕获页面异常；未产生外网功能请求。
- 关键路径：手选与代抽、完整刷新恢复、双标签仅一个请求、失败/取消/迟到响应、存储失败与无额外 API 的保存重试、好友与人设隔离、真实全应用导出/导入往返、损坏备份预检、离线 iframe 重载、缓存隔离、真实 IndexedDB 原子事务/CAS/删除与清空后防回写。
- 视觉：390×844、320×568、844×390、1024×768；无根节点横向溢出，短屏内容可滚动，查看牌义和所有操作入口可达。原粒子牌面已检查，修正继承透明度导致整体变暗的问题。
- 在线本地入口：1030 / lego-miniphone / PID 19400；20 个宿主/模块/原项目/许可资源 HTTP 200，响应逐字节匹配源码。严格 UTF-8 解码和相关 JS 语法通过。

证据在项目 `.claude/milian-tarot-review/verification/browser-results.json` 及同目录截图。早期 `failure*` 文件仅记录测试夹具启动时序，不代表最终结果；以最新 browser-results.json 为准。

复跑：

```powershell
node --test modules/milian-tarot/tests/core.test.js
node modules/milian-tarot/tests/browser-smoke.cjs "C:\Users\minami\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright"
```

浏览器测试允许通过第三个命令参数指定另一已安装 Chromium 浏览器路径。Playwright 从现有运行环境加载，不新增项目 npm 依赖。测试服务器只监听随机本机端口、结束即关闭；不使用用户的 1030 浏览器数据、密钥或聊天。

边界：未调用真实付费供应商；未在实体手机、Safari、WebView/APK 上实测；没有构建部署。牌义可离线使用，AI 需要有效的 Lego 主 API 配置。离线资源缓存范围仅塔罗模块，不能据此保证整个 Lego 主应用离线启动。
