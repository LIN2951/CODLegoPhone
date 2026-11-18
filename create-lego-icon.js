/**
 * 生成 Lego 小手机专属 Logo 图标
 * 基于源图叠加居中的 "Lego" 文字
 */
const fs = require('fs');
const path = require('path');

const SOURCE_IMAGE = path.join(__dirname, 'icons', 'lego-source.jpg');
const ICONS_DIR = path.join(__dirname, 'icons');

async function createIcons() {
    let sharp;
    try {
        sharp = require('sharp');
    } catch (e) {
        console.error('请先运行: npm install');
        process.exit(1);
    }

    if (!fs.existsSync(SOURCE_IMAGE)) {
        console.error('源图片不存在:', SOURCE_IMAGE);
        process.exit(1);
    }

    const sizes = [
        { size: 32, name: 'favicon-32' },
        { size: 180, name: 'apple-touch-icon' },
        { size: 192, name: 'icon-192' },
        { size: 512, name: 'icon-512' }
    ];

    for (const { size, name } of sizes) {
        const svgText = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <text x="50%" y="55%" text-anchor="middle" dominant-baseline="middle"
    font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(size * 0.22)}"
    font-weight="bold" fill="white" stroke="#2c3e50" stroke-width="${Math.max(1, size / 128)}">Lego</text>
</svg>`;

        try {
            const baseImg = await sharp(SOURCE_IMAGE)
                .resize(size, size)
                .toBuffer();

            const textSvg = Buffer.from(svgText);

            await sharp(baseImg)
                .composite([{
                    input: textSvg,
                    top: 0,
                    left: 0
                }])
                .png()
                .toFile(path.join(ICONS_DIR, `${name}.png`));

            console.log(`已生成: icons/${name}.png (${size}x${size})`);
        } catch (err) {
            console.error(`生成 ${name}.png 失败:`, err.message);
        }
    }

    // 生成 favicon.ico (使用 32x32 作为基础)
    try {
        const favicon32 = await sharp(SOURCE_IMAGE)
            .resize(32, 32)
            .toBuffer();
        const textSvg32 = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
  <text x="16" y="18" text-anchor="middle" dominant-baseline="middle"
    font-family="Arial" font-size="7" font-weight="bold" fill="white" stroke="#2c3e50" stroke-width="1">Lego</text>
</svg>`);
        await sharp(favicon32)
            .composite([{ input: textSvg32, top: 0, left: 0 }])
            .png()
            .toFile(path.join(__dirname, 'favicon.png'));
        console.log('已生成: favicon.png (根目录)');
    } catch (e) {
        console.warn('favicon 生成跳过:', e.message);
    }

    console.log('\nLogo 图标已保存到 icons/ 目录');
}

createIcons().catch(err => {
    console.error('执行失败:', err);
    process.exit(1);
});
