# 相伴阅读的本地文件解析依赖

- PDF.js 5.7.284，使用 pdfjs-dist 的 legacy 浏览器构建和随附字形、解码器资源。两个模块只将文件扩展名从 `.mjs` 改为 `.js`，以便小手机静态服务返回 JavaScript MIME。许可证在 `pdfjs/LICENSE` 与对应资源目录中。
- fflate 0.8.3，仅打包浏览器的 `unzipSync`。许可证在 `LICENSE-fflate`。
- SheetJS CFB 1.2.2，打包浏览器的 `read` 与 `find`，含 adler-32 1.3.1 和 crc-32 1.2.2。许可证在同目录的对应 `LICENSE-*` 文件中。

依赖随模块加载，解析时无需访问 CDN。书籍正文、封面和 PDF 原页由浏览器在本地读取。
