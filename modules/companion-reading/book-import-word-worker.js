import { find, read } from './vendor/cfb.js';

const UTF16 = new TextDecoder('utf-16le');
const WINDOWS = new TextDecoder('windows-1252');

function dataOf(container, path) {
    const data = find(container, path)?.content;
    if (!data?.length) return null;
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function byteRange(view, offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
        offset < 0 || length < 0 || offset + length > view.byteLength) {
        throw new Error('Word 二进制文件的内部数据不完整。');
    }
    return new Uint8Array(view.buffer, view.byteOffset + offset, length);
}

function summaryMetadata(container) {
    const result = {};
    try {
        const stream = dataOf(container, '/\u0005SummaryInformation');
        if (!stream || stream.getUint16(0, true) !== 0xFFFE || !stream.getUint32(24, true)) return result;
        const section = stream.getUint32(44, true);
        const count = Math.min(stream.getUint32(section + 4, true), 100);
        const properties = new Map();
        for (let index = 0; index < count; index++) {
            const offset = section + 8 + index * 8;
            properties.set(stream.getUint32(offset, true), section + stream.getUint32(offset + 4, true));
        }
        const cpOffset = properties.get(1);
        const cp = cpOffset != null ? stream.getUint16(cpOffset + 4, true) : 1252;
        const encoding = { 65001: 'utf-8', 932: 'shift_jis', 936: 'gb18030', 949: 'euc-kr', 950: 'big5' }[cp] ||
            (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : 'windows-1252');
        for (const [id, name] of [[2, 'title'], [4, 'author']]) {
            const offset = properties.get(id);
            if (offset == null) continue;
            const type = stream.getUint32(offset, true);
            const count = stream.getUint32(offset + 4, true);
            if (count > 1024 || (type !== 30 && type !== 31)) continue;
            const decoder = type === 31 ? UTF16 : new TextDecoder(encoding);
            result[name] = decoder.decode(byteRange(stream, offset + 8, count * (type === 31 ? 2 : 1))).replace(/\0+$/u, '');
        }
    } catch {
        // Summary properties are optional in legacy Word files.
    }
    return result;
}

function withoutFieldInstructions(text) {
    const parts = text.split(/([\u0013-\u0015])/u);
    const fields = [];
    let depth = 0;
    return parts.map((part) => {
        if (part === '\u0013') {
            fields.push(true);
            depth++;
        } else if (part === '\u0014' && fields.at(-1)) {
            fields[fields.length - 1] = false;
            depth--;
        } else if (part === '\u0015') {
            if (fields.pop()) depth--;
        } else if (!depth) {
            return part;
        }
        return '';
    }).join('').replace(/\u0007/gu, '\n');
}

function readWord(bytes) {
    const container = read(bytes, { type: 'array' });
    const doc = dataOf(container, '/WordDocument');
    if (!doc || doc.byteLength < 426 || doc.getUint16(0, true) !== 0xA5EC) {
        throw new Error('无法识别该 DOC。请使用 Word 97–2003 格式，或另存为 DOCX 再导入。');
    }
    const flags = doc.getUint16(10, true);
    if (flags & 0x8100) throw new Error('这个 Word 文件受密码保护，请保存一份解锁的副本后再导入。');
    const table = dataOf(container, flags & 0x0200 ? '/1Table' : '/0Table');
    if (!table) throw new Error('这个 DOC 缺少可读取的文字索引。');

    // MS-DOC FibRgLw97 and FibRgFcLcb97 locate the main text and its Clx piece table.
    const wordFields = 0x22 + 2 * doc.getUint16(0x20, true);
    const wideFields = wordFields + 2;
    const characters = doc.getUint32(wideFields + 3 * 4, true);
    if (characters > 12_000_000) throw new Error('提取的正文超过 1200 万字符，请把文件拆成几册后导入。');
    const offsets = wideFields + 4 * doc.getUint16(wordFields, true) + 2;
    const clxStart = doc.getUint32(offsets + 33 * 8, true);
    const clxSize = doc.getUint32(offsets + 33 * 8 + 4, true);
    const clxBytes = byteRange(table, clxStart, clxSize);
    const clx = new DataView(clxBytes.buffer, clxBytes.byteOffset, clxBytes.byteLength);
    let position = 0;
    while (clx.getUint8(position) === 1) position += 3 + clx.getUint16(position + 1, true);
    if (clx.getUint8(position) !== 2) throw new Error('这个 DOC 的文字索引格式无法读取。');
    const length = clx.getUint32(position + 1, true);
    const start = position + 5;
    const count = (length - 4) / 12;
    if (!Number.isInteger(count) || count < 0 || start + length > clx.byteLength) {
        throw new Error('这个 DOC 的文字索引不完整。');
    }
    const descriptors = start + (count + 1) * 4;
    const text = [];
    let textLength = 0;
    for (let index = 0; index < count; index++) {
        const first = clx.getUint32(start + index * 4, true);
        const end = Math.min(characters, clx.getUint32(start + (index + 1) * 4, true));
        if (first >= characters) break;
        if (end <= first) throw new Error('这个 DOC 的文字索引顺序无效。');
        const field = clx.getUint32(descriptors + index * 8 + 2, true);
        const compressed = (field & 0x40000000) !== 0;
        const offset = field & 0x3FFFFFFF;
        const size = end - first;
        textLength += size;
        if (textLength > characters) throw new Error('这个 DOC 的文字索引顺序无效。');
        const piece = compressed
            ? WINDOWS.decode(byteRange(doc, offset / 2, size))
            : UTF16.decode(byteRange(doc, offset, size * 2));
        text.push(piece);
    }
    return { text: withoutFieldInstructions(text.join('')), ...summaryMetadata(container) };
}

self.onmessage = ({ data }) => {
    try {
        self.postMessage(readWord(data));
    } catch (error) {
        self.postMessage({ error: /[\u3400-\u9FFF]/u.test(error?.message) ? error.message : '无法读取这个 DOC。请另存为 DOCX 再导入。' });
    }
};
