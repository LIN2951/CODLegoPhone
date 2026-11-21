export const MAX_BOOK_TEXT = 12_000_000;

const NUMERAL = '[0-9０-９零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+';
const CHINESE_HEADING = new RegExp(`^第\\s*${NUMERAL}\\s*[章回节節卷部篇集幕](.*)$`, 'u');
const SPECIAL_HEADING = /^(?:序|序言|引言|前言|楔子|引子|卷首语|卷首語|正文|尾声|尾聲|后记|後記|跋|附录|附錄|番外|终章|終章|完结感言|完結感言)(?:[：:、·.\s].+|[一二三四五六七八九十0-9]+.*)?$/u;
const ENGLISH_HEADING = /^(?:(?:chapter|part|book|section)\s+[\divxlcdm]+\b|preface\b|introduction\b|prologue\b|epilogue\b|afterword\b|appendix\b)/iu;
const CONTENTS_HEADING = /^(?:目\s*[录錄]|table of contents|contents)$/iu;
const TOC_PAGE_SUFFIX = /(?:\s*[.．·…⋯—–\t]{2,}\s*|\t+)[\divxlcdm一二三四五六七八九十]+\s*$/iu;
const BOOK_TITLE = /^\s*(?:书名|書名|标题|標題|Title)\s*[:：]\s*(.+)$/iu;
const BOOK_AUTHOR = /^\s*(?:作者|Author)\s*[:：]\s*(.+)$/iu;

export function cleanLabel(value) {
    return Array.from(String(value ?? '').replace(/[\u0000-\u001F\u007F\uFEFF]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, 160).join('');
}

export function filenameTitle(filename) {
    return cleanLabel(filename.replace(/\.[^.]+$/u, '').replace(/^《(.+)》$/u, '$1').replace(/[_-]{2,}/gu, ' ')) || '未命名书籍';
}

export function normalizedText(text) {
    return text.replace(/^\uFEFF/u, '').replace(/\r\n?|[\u000B\u000C\u2028\u2029]/gu, '\n').replace(/[\u0000-\u0008\u000E-\u001F\u007F]/gu, '');
}

export function assertBookSize(characters) {
    if (characters > MAX_BOOK_TEXT) {
        throw new Error('提取的正文超过 1200 万字符，请把文件拆成几册后导入。');
    }
}

function eastAsianScore(text) {
    const common = text.match(/[的一是在不了有和人這这個个來来大時时我以要他會会可到說说為为也你對对生能而子那得於于著着下自之家年過过發发後后作裡里去小多己麼么日好看起把還还兩两樣样學学聲声章節节]/gu)?.length ?? 0;
    const rare = text.match(/[\uE000-\uF8FF\uFFFD]/gu)?.length ?? 0;
    return common * 3 - rare * 4;
}

export function decodePlainText(bytes) {
    for (const [prefix, encoding] of [
        [[0xFF, 0xFE], 'utf-16le'],
        [[0xFE, 0xFF], 'utf-16be'],
        [[0xEF, 0xBB, 0xBF], 'utf-8'],
    ]) {
        if (prefix.every((byte, index) => bytes[index] === byte)) {
            return new TextDecoder(encoding).decode(bytes);
        }
    }
    const sampleLength = Math.min(bytes.length, 4096);
    const zeroes = [0, 0];
    for (let i = 0; i < sampleLength; i++) {
        if (bytes[i] === 0) zeroes[i % 2]++;
    }
    if (zeroes[0] + zeroes[1] > sampleLength / 8) {
        return new TextDecoder(zeroes[1] > zeroes[0] ? 'utf-16le' : 'utf-16be').decode(bytes);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        const encodings = ['gb18030', 'big5'].flatMap((encoding) => {
            try {
                const decoder = new TextDecoder(encoding, { fatal: true });
                const text = decoder.decode(bytes);
                return [{ text, score: eastAsianScore(text.slice(0, 12_000)) }];
            } catch {
                return [];
            }
        });
        encodings.sort((left, right) => right.score - left.score);
        return encodings[0]?.text ?? new TextDecoder('windows-1252').decode(bytes);
    }
}

export function chapterHeading(value) {
    const trimmed = value.trim();
    const title = trimmed.replace(/^#{1,6}\s+/u, '');
    if (!title || title.length > 96 || TOC_PAGE_SUFFIX.test(title)) return '';
    if (title !== trimmed) return title;
    const chineseSuffix = title.match(CHINESE_HEADING)?.[1];
    const sentence = /[。！？!?；;]$/u.test(title);
    if (chineseSuffix != null && (!sentence || /^[\s：:、—-]/u.test(chineseSuffix))) return title;
    if (!sentence && (SPECIAL_HEADING.test(title) || ENGLISH_HEADING.test(title))) return title;
    return '';
}

function stripContents(lines) {
    const start = lines.findIndex((entry, index) => index < 48 && CONTENTS_HEADING.test(entry.text));
    if (start < 0) return lines;
    let end = start + 1;
    const entries = new Set();
    for (; end < lines.length; end++) {
        const value = lines[end].text;
        if (!value) continue;
        const title = chapterHeading(value.replace(TOC_PAGE_SUFFIX, '').trim());
        if (entries.has(title) || (!title && !TOC_PAGE_SUFFIX.test(value))) break;
        if (title) entries.add(title);
    }
    if (end < lines.length && end > start + 1) {
        return [...lines.slice(0, start), ...lines.slice(end)];
    }
    return lines;
}

export function structuredText(lines, metadata = {}) {
    let title = cleanLabel(metadata.title);
    let author = cleanLabel(metadata.author);
    const titleEntry = lines.find((entry) => entry.bookTitle);
    if (!title && titleEntry) title = cleanLabel(titleEntry.text);
    let next = stripContents(lines.map((entry) => ({ ...entry, text: normalizedText(entry.text).trim() })));
    const first = next.findIndex((entry) => entry.text);
    if (first >= 0) {
        const value = next[first].text;
        const marked = value.match(BOOK_TITLE)?.[1] || value.match(/^《([^《》]{1,100})》$/u)?.[1];
        const isolated = value.length <= 32 && !/[，。！？、；.!?;]/u.test(value) && !chapterHeading(value) &&
            !next[first + 1]?.text && next.slice(first + 2, first + 9).some((entry) => chapterHeading(entry.text));
        if (!title && (marked || isolated)) title = cleanLabel(marked || value);
        if (marked || isolated || (title && value === title)) {
            next = next.filter((_, index) => index !== first);
        }
    }
    next = next.filter((entry) => !entry.bookTitle);
    const authorIndex = next.findIndex((entry, index) => index < 6 && BOOK_AUTHOR.test(entry.text));
    if (authorIndex >= 0) {
        author ||= cleanLabel(next[authorIndex].text.match(BOOK_AUTHOR)?.[1]);
        next = next.filter((_, index) => index !== authorIndex);
    }
    return { title, author, chapters: partitionChapters(next) };
}

export function partitionChapters(lines, fallback = '正文') {
    const chapters = [];
    let chapter = { title: fallback, paragraphs: [] };
    for (const { text, heading } of lines) {
        if (!text) continue;
        const title = heading === true ? text : heading || chapterHeading(text);
        if (title) {
            if (chapter.paragraphs.length) chapters.push(chapter);
            chapter = { title: cleanLabel(title), paragraphs: [] };
        } else {
            chapter.paragraphs.push(...text.split('\n').map((line) => line.trim()).filter(Boolean));
        }
    }
    if (chapter.paragraphs.length) chapters.push(chapter);
    return chapters;
}

export function plainBook(text) {
    const sample = text.slice(0, 4096);
    const unprintable = sample.match(/[\x00-\x08\x0E-\x1F\uFFFD]/gu)?.length ?? 0;
    if (unprintable > Math.max(8, sample.length * 0.02)) {
        throw new Error('这不是可读取的文本文件，请另存为 UTF-8 编码的 TXT 后再导入。');
    }
    assertBookSize(text.length);
    return structuredText(normalizedText(text).split('\n').map((line) => ({ text: line })));
}
