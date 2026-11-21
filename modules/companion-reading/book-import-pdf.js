import { assertBookSize, cleanLabel, partitionChapters } from './book-import-text.js';

const PDF_BASE = new URL('./vendor/pdfjs/', import.meta.url);
const MAX_PDF_PAGES = 2400;
const MAX_CANVAS_PIXELS = 3_000_000;
const MAX_SCAN_GROUP_PAGES = 12;

async function openPdf(blob) {
    const pdfjs = await import('./vendor/pdfjs/pdf.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.js', PDF_BASE).href;
    const task = pdfjs.getDocument({
        data: new Uint8Array(await blob.arrayBuffer()),
        cMapUrl: new URL('cmaps/', PDF_BASE).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('standard_fonts/', PDF_BASE).href,
        wasmUrl: new URL('wasm/', PDF_BASE).href,
        iccUrl: new URL('iccs/', PDF_BASE).href,
        isEvalSupported: false,
        maxImageSize: 40_000_000,
        canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    try {
        const document = await task.promise;
        return { document, destroy: () => task.destroy() };
    } catch (error) {
        await task.destroy().catch(() => {});
        if (error.name === 'PasswordException') {
            throw new Error('这个 PDF 需要密码。请保存一份解锁的副本后再导入。');
        }
        throw new Error('这个 PDF 无法打开，请确认文件完整。', { cause: error });
    }
}

function extractLines(items) {
    const lines = [];
    let current = '';
    let previous = null;
    function flush() {
        const content = current.trim();
        if (content) lines.push(content);
        current = '';
        previous = null;
    }
    for (const item of items) {
        if (!item.str && !item.hasEOL) continue;
        const vertical = item.dir === 'ttb';
        const axis = vertical ? 4 : 5;
        const flow = vertical ? item.transform[5] : item.transform[4];
        const lineHeight = Math.max(item.height || 0, previous?.height || 0, 5);
        if (previous && Math.abs(item.transform[axis] - previous.transform[axis]) > lineHeight * 0.5) flush();
        if (current && previous && !vertical && /^[A-Za-z0-9]/u.test(item.str) && /[A-Za-z0-9]$/u.test(current) &&
            flow - (previous.transform[4] + previous.width) > lineHeight * 0.12) current += ' ';
        current += item.str || '';
        previous = item;
        if (item.hasEOL) flush();
    }
    flush();
    return lines;
}

async function pdfOutline(pdf) {
    const groups = new Map();
    const stack = [...(await pdf.getOutline().catch(() => []) || [])].reverse();
    let handled = 0;
    while (stack.length && handled++ < 4000) {
        const item = stack.pop();
        const childItems = item.items || [];
        for (let index = childItems.length - 1; index >= 0; index--) stack.push(childItems[index]);
        const title = cleanLabel(item.title);
        if (!title || !item.dest) continue;
        try {
            const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
            if (!Array.isArray(dest) || dest[0] == null) continue;
            const pageIndex = Number.isInteger(dest[0]) ? dest[0] : await pdf.getPageIndex(dest[0]);
            if (pageIndex >= 0 && pageIndex < pdf.numPages && !groups.has(pageIndex + 1)) groups.set(pageIndex + 1, title);
        } catch {
            // Malformed bookmarks do not prevent opening their pages.
        }
    }
    return groups;
}

function pageRange(pages) {
    return pages.length === 1 ? `第 ${pages[0]} 页` : `第 ${pages[0]}–${pages.at(-1)} 页`;
}

export async function pdfBook(blob, report) {
    const reader = await openPdf(blob);
    try {
        const pdf = reader.document;
        if (pdf.numPages > MAX_PDF_PAGES) throw new Error('PDF 超过 2400 页，请拆分成数册后导入。');
        const [metadata, outline] = await Promise.all([pdf.getMetadata().catch(() => null), pdfOutline(pdf)]);
        const chapters = [];
        let chapterTitle = '';
        let group = null;
        let characters = 0;
        let scanPages = 0;
        const appendGroup = () => {
            if (!group) return;
            const title = group.title || '正文';
            if (group.scanned) {
                const label = `原页 · ${pageRange(group.pages)}`;
                chapters.push({
                    title: group.title ? `${group.title} · ${label}` : label,
                    paragraphs: [],
                    pdfPages: group.pages,
                });
            } else if (group.title) {
                const start = group.lines.length > 1 && cleanLabel(group.lines[0]) === group.title ? 1 : 0;
                const paragraphs = group.lines.slice(start);
                if (paragraphs.length) chapters.push({ title, paragraphs });
            } else {
                for (const chapter of partitionChapters(group.lines.map((text) => ({ text })), title)) chapters.push(chapter);
            }
            group = null;
        };
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            let lines;
            try {
                const { items } = await page.getTextContent();
                lines = extractLines(items);
            } catch {
                lines = [];
            } finally {
                page.cleanup();
            }
            characters += lines.reduce((length, line) => length + line.length, 0);
            assertBookSize(characters);
            const scanned = !lines.some((line) => /\p{L}/u.test(line));
            const startsChapter = outline.has(pageNumber);
            if (group && (startsChapter || group.scanned !== scanned || group.pages.length >= MAX_SCAN_GROUP_PAGES)) {
                appendGroup();
            }
            if (startsChapter) chapterTitle = outline.get(pageNumber);
            group ??= { title: chapterTitle, scanned, pages: [], lines: [] };
            if (scanned) {
                group.pages.push(pageNumber);
                scanPages++;
            } else {
                group.lines.push(...lines);
            }
            report(10 + Math.floor(pageNumber / pdf.numPages * 86), `正在分析 PDF 第 ${pageNumber} / ${pdf.numPages} 页`);
        }
        appendGroup();
        return {
            title: metadata?.info?.Title || metadata?.metadata?.get('dc:title'),
            author: metadata?.info?.Author || metadata?.metadata?.get('dc:creator'),
            chapters,
            pdfSource: scanPages ? blob : undefined,
            warnings: scanPages ? [`${scanPages} 页没有可提取文字，已保留原页。可以浏览原页，也可以写下感想和对方讨论。`] : [],
        };
    } finally {
        await reader.destroy().catch(() => {});
    }
}

export async function openPdfReader(blob) {
    const reader = await openPdf(blob);
    const renderings = new WeakMap();
    const running = new Set();
    let closed = false;
    return {
        async renderPage(pageNumber, canvas, maxWidth) {
            if (closed) return false;
            const previous = renderings.get(canvas);
            const render = { task: null };
            renderings.set(canvas, render);
            if (previous?.task) {
                previous.task.cancel();
                await previous.task.promise.catch(() => {});
            }
            let page;
            try {
                page = await reader.document.getPage(pageNumber);
                if (closed || renderings.get(canvas) !== render) return false;
                const natural = page.getViewport({ scale: 1 });
                const cssWidth = Math.max(1, Number(maxWidth) || 640);
                const deviceScale = Math.min(2, globalThis.devicePixelRatio || 1);
                const scale = Math.min(cssWidth * deviceScale / natural.width,
                    Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height)));
                const viewport = page.getViewport({ scale });
                canvas.width = Math.ceil(viewport.width);
                canvas.height = Math.ceil(viewport.height);
                canvas.style.width = `${cssWidth}px`;
                render.task = page.render({ canvas, viewport, background: 'white' });
                running.add(render.task);
                await render.task.promise;
                return !closed && renderings.get(canvas) === render;
            } catch (error) {
                if (closed || renderings.get(canvas) !== render || error?.name === 'RenderingCancelledException') return false;
                throw new Error(`无法显示 PDF 第 ${pageNumber} 页。`, { cause: error });
            } finally {
                running.delete(render.task);
                page?.cleanup();
            }
        },
        destroy() {
            if (closed) return Promise.resolve();
            closed = true;
            for (const task of running) task.cancel();
            return reader.destroy();
        },
    };
}
