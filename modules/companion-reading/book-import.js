import { cleanLabel, decodePlainText, filenameTitle, normalizedText, plainBook, structuredText } from './book-import-text.js';

const MAX_FILE_SIZE = 64 * 1024 * 1024;
const MAX_LEGACY_WORD_SIZE = 20 * 1024 * 1024;
const SUPPORTED_FORMATS = new Set(['txt', 'doc', 'docx', 'pdf', 'epub']);
const SIGNATURE_OLE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const SIGNATURE_ZIP = [0x50, 0x4B, 0x03, 0x04];

const startsWith = (bytes, signature) => signature.every((value, index) => bytes[index] === value);

function readLegacyWord(bytes) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./book-import-word-worker.js', import.meta.url), { type: 'module' });
        const finish = (result, error) => {
            globalThis.clearTimeout(timeout);
            worker.terminate();
            if (error) reject(new Error(error));
            else resolve(result);
        };
        const timeout = globalThis.setTimeout(() => finish(null, '解析 DOC 用时过长，请尝试另存为 DOCX 后导入。'), 20_000);
        worker.onmessage = ({ data }) => finish(data, data.error);
        worker.onerror = (event) => {
            event.preventDefault();
            finish(null, '无法启动 DOC 解析，请尝试另存为 DOCX 后导入。');
        };
        worker.postMessage(bytes, [bytes.buffer]);
    });
}

export async function importBook(file, { onProgress } = {}) {
    const filename = String(file?.name || '');
    let format = filename.match(/\.([^.]+)$/u)?.[1].toLowerCase();
    if (!SUPPORTED_FORMATS.has(format)) throw new Error('请选择 TXT、Word（DOC 或 DOCX）、PDF 或 EPUB 文件。');
    if (!file.size) throw new Error('这个文件为空，请选择包含正文的书籍。');
    if (file.size > MAX_FILE_SIZE) throw new Error('单本书支持最大 64 MB，请拆分成数册后导入。');
    const report = (percent, message) => onProgress?.({ percent, message });
    report(2, '正在读取文件');
    const header = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    const ole = startsWith(header, SIGNATURE_OLE);
    const zip = startsWith(header, SIGNATURE_ZIP);
    const pdf = new TextDecoder().decode(header).includes('%PDF-');
    if (format === 'doc' && zip) format = 'docx';
    if (format === 'docx' && ole) throw new Error('这个 DOCX 可能已加密，请保存一份解锁的副本后再导入。');
    if (format === 'doc' && file.size > MAX_LEGACY_WORD_SIZE) {
        throw new Error('旧版 Word 文件最大支持 20 MB，请另存为 DOCX 后导入。');
    }
    report(8, '正在识别书名与目录');
    let book;
    if (format === 'pdf') {
        if (!pdf) throw new Error('文件内容与 PDF 格式不符。');
        const { pdfBook } = await import('./book-import-pdf.js');
        book = await pdfBook(file, report);
    } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (format === 'doc') {
            if (!ole) throw new Error('无法识别该 DOC。请另存为 DOCX 再导入。');
            const { text, ...metadata } = await readLegacyWord(bytes);
            book = structuredText(normalizedText(text).split('\n').map((line) => ({ text: line })), metadata);
        } else if (format === 'txt') {
            if (ole || zip || pdf) throw new Error('文件内容与 TXT 格式不符。');
            book = plainBook(decodePlainText(bytes));
        } else {
            if (!zip) throw new Error('文件内容与所选格式不符，或压缩结构已损坏。');
            const { docxBook, epubBook } = await import('./book-import-archive.js');
            try {
                book = format === 'epub' ? epubBook(bytes) : docxBook(bytes);
            } catch (error) {
                if (/[\u3400-\u9FFF]/u.test(error?.message)) throw error;
                throw new Error('书籍的压缩结构已损坏或受密码保护，无法导入。', { cause: error });
            }
        }
    }
    if (!book.chapters.length) throw new Error('未找到可阅读的正文，请检查文件内容。');
    if (book.chapters.length > 4000) throw new Error('书籍目录超过 4000 项，请拆分成数册后导入。');
    report(100, '目录已整理');
    return {
        ...book,
        title: cleanLabel(book.title) || filenameTitle(filename),
        author: cleanLabel(book.author),
        format,
        warnings: book.warnings || [],
    };
}

export async function openPdfReader(blob) {
    const module = await import('./book-import-pdf.js');
    return module.openPdfReader(blob);
}
