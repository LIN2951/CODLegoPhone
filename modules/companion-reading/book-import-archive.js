import { unzipSync } from './vendor/fflate.js';
import { assertBookSize, chapterHeading, cleanLabel, partitionChapters, structuredText } from './book-import-text.js';

const MIB = 1024 * 1024;
const ZIP_TEXT_ENTRY_LIMIT = 24 * MIB;
const ZIP_TEXT_TOTAL_LIMIT = 72 * MIB;
const ZIP_COVER_LIMIT = 5 * MIB;
const TEXT_PART = /\.(?:xml|rels|opf|ncx|x?html?|htm)$/iu;
const RASTER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function unzip(bytes, accepts, perEntryLimit, totalLimit) {
    let count = 0;
    let total = 0;
    return unzipSync(bytes, { filter({ name, originalSize }) {
        if (++count > 12_000) throw new Error('压缩包里的文件太多，无法安全导入。');
        if (!accepts(name)) return false;
        total += originalSize;
        if (originalSize > perEntryLimit || total > totalLimit) {
            throw new Error('解包后的书籍内容过大，请拆分成数册后导入。');
        }
        return true;
    } });
}

function partText(files, path) {
    if (!Object.hasOwn(files, path)) return '';
    const bytes = files[path];
    if (bytes[0] === 0xFF && bytes[1] === 0xFE || bytes[0] === 0x3C && bytes[1] === 0) {
        return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF || bytes[0] === 0 && bytes[1] === 0x3C) {
        return new TextDecoder('utf-16be').decode(bytes);
    }
    return new TextDecoder().decode(bytes);
}

const nodes = (root, name) => Array.from(root?.getElementsByTagNameNS('*', name) ?? []);
const firstNode = (root, name) => nodes(root, name)[0];
const child = (root, name) => Array.from(root?.children ?? []).find((node) => node.localName === name);
const attr = (node, name) => Array.from(node?.attributes ?? []).find((item) => item.localName === name)?.value || '';

function parseXml(source) {
    if (!source || /<!ENTITY\s/iu.test(source)) return null;
    const record = new DOMParser().parseFromString(source, 'application/xml');
    return firstNode(record, 'parsererror') ? null : record;
}

function parseBookPage(source) {
    if (!source || /<!ENTITY\s/iu.test(source)) return null;
    const xml = parseXml(source);
    if (xml) return firstNode(xml, 'body') || xml.documentElement;
    const template = document.createElement('template');
    template.innerHTML = source;
    return template.content;
}

function relativeRef(base, reference) {
    if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(reference)) return null;
    const hashAt = reference.indexOf('#');
    const pathSource = (hashAt < 0 ? reference : reference.slice(0, hashAt)).split('?')[0];
    const fragmentSource = hashAt < 0 ? '' : reference.slice(hashAt + 1);
    let path = pathSource;
    let fragment = fragmentSource;
    try {
        path = decodeURIComponent(pathSource);
        fragment = decodeURIComponent(fragmentSource);
    } catch {
        return null;
    }
    if (/[\\\x00-\x1F]/u.test(path)) return null;
    if (!path) return base ? { path: base, fragment } : null;
    const parts = path.startsWith('/') ? [] : base.split('/').slice(0, -1);
    for (const item of path.split('/')) {
        if (!item || item === '.') continue;
        if (item === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else {
            parts.push(item);
        }
    }
    return { path: parts.join('/'), fragment };
}

function wordRelationships(files, part) {
    const path = part.replace(/([^/]*)$/u, '_rels/$1.rels');
    return nodes(parseXml(partText(files, path)), 'Relationship').filter((relation) =>
        attr(relation, 'TargetMode').toLowerCase() !== 'external');
}

function relationshipPath(relations, base, type) {
    const relation = relations.find((item) => attr(item, 'Type').endsWith('/' + type));
    return relativeRef(base, attr(relation, 'Target'))?.path || '';
}

function wordOutline(style) {
    const explicitLevel = attr(child(child(style, 'pPr'), 'outlineLvl'), 'val');
    return explicitLevel !== '' && /^[0-8]$/u.test(explicitLevel);
}

function wordStyles(files, path) {
    const styles = new Map();
    for (const node of nodes(parseXml(partText(files, path)), 'style')) {
        const id = attr(node, 'styleId');
        styles.set(id, {
            name: attr(child(node, 'name'), 'val'),
            base: attr(child(node, 'basedOn'), 'val'),
            outline: wordOutline(node),
        });
    }
    return styles;
}

function wordParagraphRole(paragraph, styles) {
    const properties = child(paragraph, 'pPr');
    let id = attr(child(properties, 'pStyle'), 'val');
    const visited = new Set();
    while (id && !visited.has(id)) {
        visited.add(id);
        const style = styles.get(id);
        const names = [id, style?.name || ''].map((name) => name.replace(/\s/gu, ''));
        if (names.some((name) => /^(?:TOC\d*|目录\d*|目錄\d*)$/iu.test(name))) return 'contents';
        if (names.some((name) => /^(?:Title|标题|標題)$/iu.test(name))) return 'title';
        if (style?.outline || names.some((name) => /^(?:heading|标题|標題)[1-9]$/iu.test(name))) return 'heading';
        id = style?.base;
    }
    if (/^[0-8]$/u.test(attr(child(properties, 'outlineLvl'), 'val'))) return 'heading';
    return 'body';
}

function wordParagraphText(paragraph) {
    const parts = [];
    const visit = (parent) => {
        for (const item of parent.children) {
            switch (item.localName) {
                case 't': parts.push(item.textContent); break;
                case 'tab': parts.push('\t'); break;
                case 'br':
                case 'cr': parts.push('\n'); break;
                case 'p':
                case 'del':
                case 'moveFrom':
                case 'pPr':
                    break;
                default: visit(item);
            }
        }
    };
    visit(paragraph);
    return parts.join('');
}

export function docxBook(bytes) {
    const files = unzip(bytes, (name) => TEXT_PART.test(name), ZIP_TEXT_ENTRY_LIMIT, ZIP_TEXT_TOTAL_LIMIT);
    const roots = wordRelationships(files, '');
    const mainPath = relationshipPath(roots, '', 'officeDocument') || 'word/document.xml';
    const main = parseXml(partText(files, mainPath));
    const body = firstNode(main, 'body');
    if (!body) throw new Error('这个文件缺少可读取的 Word 正文。若文档带有密码，请先保存一份解锁的副本。');
    const stylesPath = relationshipPath(wordRelationships(files, mainPath), mainPath, 'styles') || 'word/styles.xml';
    const styles = wordStyles(files, stylesPath);
    const corePath = relationshipPath(roots, '', 'core-properties') || 'docProps/core.xml';
    const core = parseXml(partText(files, corePath));
    const lines = [];
    let characters = 0;
    for (const paragraph of nodes(body, 'p')) {
        const role = wordParagraphRole(paragraph, styles);
        if (role === 'contents') continue;
        const text = wordParagraphText(paragraph);
        characters += text.length;
        assertBookSize(characters);
        lines.push({ text, heading: role === 'heading', bookTitle: role === 'title' });
    }
    return structuredText(lines, {
        title: firstNode(core, 'title')?.textContent,
        author: firstNode(core, 'creator')?.textContent,
    });
}

function getEpubToc(files, manifest, spineNode) {
    const byPath = new Map();
    function add(base, uri, text) {
        const ref = relativeRef(base, uri);
        const title = cleanLabel(text);
        if (!ref?.path || !title) return;
        if (!byPath.has(ref.path)) byPath.set(ref.path, new Map());
        const targets = byPath.get(ref.path);
        if (!targets.has(ref.fragment)) targets.set(ref.fragment, title);
    }
    const navEntry = [...manifest.values()].find((entry) => entry.properties.includes('nav'));
    if (navEntry) {
        const navPage = parseBookPage(partText(files, navEntry.path));
        const navs = navPage?.querySelectorAll('nav') ?? [];
        const nav = Array.from(navs).find((item) => /(?:^|\s)toc(?:\s|$)/u.test(attr(item, 'type'))) ||
            Array.from(navs).find((item) => attr(item, 'role') === 'doc-toc') || navs[0];
        for (const link of nav?.querySelectorAll('a[href]') ?? []) {
            add(navEntry.path, attr(link, 'href'), link.textContent);
        }
    }
    const ncxEntry = manifest.get(attr(spineNode, 'toc')) || [...manifest.values()].find((entry) =>
        entry.type === 'application/x-dtbncx+xml');
    if (ncxEntry) {
        for (const navPoint of nodes(parseXml(partText(files, ncxEntry.path)), 'navPoint')) {
            add(ncxEntry.path, attr(child(navPoint, 'content'), 'src'), firstNode(child(navPoint, 'navLabel'), 'text')?.textContent);
        }
    }
    return byPath;
}

const EPUB_SKIPPED = new Set(['head', 'style', 'script', 'noscript', 'iframe', 'object', 'svg', 'math', 'nav']);
const EPUB_BLOCKS = new Set(['p', 'section', 'article', 'div', 'li', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'tr', 'pre']);
const EPUB_HEADING = /^h[1-6]$/u;

function epubLines(page, targets) {
    const lines = [];
    const marked = new Set();
    let buffer = [];
    function flush() {
        const text = buffer.join('').replace(/\s+/gu, ' ').trim();
        if (text) lines.push({ text });
        buffer = [];
    }
    function addTarget(id) {
        if (!targets?.has(id) || marked.has(id)) return;
        flush();
        const text = targets.get(id);
        lines.push({ text, heading: true });
        marked.add(id);
    }
    function visit(node) {
        if (node.nodeType === 3 || node.nodeType === 4) {
            buffer.push(node.nodeValue);
            return;
        }
        if (node.nodeType !== 1 && node.nodeType !== 11) return;
        const tag = node.localName?.toLowerCase();
        if (EPUB_SKIPPED.has(tag) || node.hasAttribute?.('hidden') || attr(node, 'aria-hidden') === 'true') return;
        const id = attr(node, 'id') || (tag === 'a' && attr(node, 'name'));
        if (id) addTarget(id);
        if (tag === 'br') {
            flush();
            return;
        }
        if (EPUB_HEADING.test(tag)) {
            flush();
            const text = cleanLabel(node.textContent);
            const previous = lines.at(-1);
            if (text && text !== previous?.text) {
                lines.push({ text, heading: !targets?.size && /^h[1-3]$/u.test(tag) });
            }
            return;
        }
        if (EPUB_BLOCKS.has(tag)) flush();
        for (const item of node.childNodes) visit(item);
        if (EPUB_BLOCKS.has(tag)) flush();
    }
    addTarget('');
    visit(page);
    flush();
    return lines;
}

function epubCover(bytes, entry) {
    if (!entry || !RASTER_TYPES.has(entry.type)) return null;
    try {
        const files = unzip(bytes, (name) => name === entry.path, ZIP_COVER_LIMIT, ZIP_COVER_LIMIT);
        const cover = files[entry.path];
        return cover?.length ? new Blob([cover], { type: entry.type }) : null;
    } catch {
        return null;
    }
}

export function epubBook(bytes) {
    const files = unzip(bytes, (name) => TEXT_PART.test(name), ZIP_TEXT_ENTRY_LIMIT, ZIP_TEXT_TOTAL_LIMIT);
    const container = parseXml(partText(files, 'META-INF/container.xml'));
    const rootFile = attr(firstNode(container, 'rootfile'), 'full-path');
    const rootPath = relativeRef('', rootFile)?.path || Object.keys(files).find((name) => /\.opf$/iu.test(name));
    const packet = parseXml(partText(files, rootPath));
    const metadata = firstNode(packet, 'metadata');
    const spine = firstNode(packet, 'spine');
    if (!spine) throw new Error('这个 EPUB 缺少可读取的书籍结构。');
    const manifest = new Map();
    for (const item of nodes(firstNode(packet, 'manifest'), 'item')) {
        const path = relativeRef(rootPath, attr(item, 'href'))?.path;
        if (!path) continue;
        manifest.set(attr(item, 'id'), {
            path,
            type: attr(item, 'media-type'),
            properties: attr(item, 'properties').split(/\s+/u),
        });
    }
    const toc = getEpubToc(files, manifest, spine);
    const spineItems = nodes(spine, 'itemref');
    const hasPrimaryItems = spineItems.some((item) => attr(item, 'linear') !== 'no');
    let characters = 0;
    const chapters = [];
    for (const [index, item] of spineItems.entries()) {
        if (attr(item, 'linear') === 'no' && hasPrimaryItems) continue;
        const entry = manifest.get(attr(item, 'idref'));
        if (!entry || entry.properties.includes('nav')) continue;
        const page = parseBookPage(partText(files, entry.path));
        if (!page) continue;
        const targets = toc.get(entry.path);
        const lines = epubLines(page, targets);
        characters += lines.reduce((total, line) => total + line.text.length, 0);
        assertBookSize(characters);
        for (const chapter of partitionChapters(lines, spineItems.length > 1 ? `第 ${index + 1} 节` : '正文')) {
            chapters.push(chapter);
        }
    }
    if (!chapters.length) {
        throw new Error('这个 EPUB 无法提取正文。请确认它未受数字版权保护并包含文字。');
    }
    const coverMeta = nodes(metadata, 'meta').find((item) => attr(item, 'name').toLowerCase() === 'cover');
    const cover = epubCover(bytes, [...manifest.values()].find((item) => item.properties.includes('cover-image')) ||
        manifest.get(attr(coverMeta, 'content')));
    return {
        title: firstNode(metadata, 'title')?.textContent,
        author: nodes(metadata, 'creator').map((item) => cleanLabel(item.textContent)).filter(Boolean).join('、'),
        chapters,
        cover,
    };
}
