# 迷恋塔罗 · 许可与来源

本地适配核查日期：2026-09-11。

## 允许的用途

以下两项上游代码均为 ISC 许可，允许接入其他软件、收费或免费使用、复制、修改和分发。再分发时须保留原版权和完整许可声明；许可包含原作者的免责条款。ISC 不要求宿主软件整体公开源码。

- **Cove Tarot Companion**，Copyright (c) 2026 Cove Contributors。版本 `b26d64b3ab0292195aa96fc47e0e8c9382f06963`。来源：https://github.com/moonlin1213/cove-tarot-companion 。完整许可：[upstream/companion/LICENSE](upstream/companion/LICENSE)。复用了其牌组核验、原文综合提取和结果合同。
- **Tarot Ritual**，Copyright (c) 2026 Tarot Ritual contributors。连接器锁定的引擎版本 `04c6ee2c112e2da9a22bf0b5b4ec80d61ef401d5`。来源：https://github.com/moonlin1213/tarot-ritual 。完整许可：[upstream/tarot/LICENSE](upstream/tarot/LICENSE)。复用了 78 张牌数据、五种牌阵、Canvas 粒子牌面、解读提示词与安全文本渲染。

上游原始文件哈希与版本记录见 [upstream-source.json](upstream-source.json)。`cardface.js` 新增释放 Canvas 内存缓存的接口，并重置圆角遮罩透明度，避免粒子透明度使整张牌面变暗；其余引入文件未改动。手机界面、宿主适配、存储、缓存、备份和测试为 Lego 集成新增文件。

## 资源范围

公开引擎 README 明确说明：作者自用的受版权限制牌图未公开。这里使用源码程序绘制的抽象粒子牌面，不包含私人牌图、商业牌组扫描图或另外下载的牌图。代码许可不授权用户自行添加的第三方图片。

完整桌面引擎还声明 Three.js 为 MIT、Cinzel 与 Cormorant Garamond 为 SIL OFL 1.1，js-yaml 为 MIT、argparse 为 Python-2.0；**本模块未分发这些依赖、字体或其二进制**，使用浏览器 Canvas 与系统字体，因此没有额外的第三方运行依赖。若未来引入上述资产，需同时加入对应完整许可。

## 适配范围

这是一份基于开源核心的手机适配版，保留固定牌组、正逆位、整组揭示、原解读和同组陪伴视角。原桌面 CLI、本机账户导入、独立引擎服务器、Three.js 三维舞台与拍照识牌未载入 Lego。原项目的桌面运行要求不等于本适配版的手机实测证明。

AI 请求走 Lego 已有主 API；用户主动点击才调用。API 服务的价格、可用性和条款独立于上述代码许可。
