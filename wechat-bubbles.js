/**
 * Lego 小手机 · 微信聊天气泡 HTML 拼装（从 app.js 迁出）
 * 依赖：app.js 的 isChatEmojiContent；wechat-emoji 的 resolveEmojiRefsInMessage；可选 Moments（运行时存在即可）
 * 顺序：app.js → … → wechat-emoji.js → 本文件 → wechat-ui.js
 */

/** 判断气泡 HTML 是否无可见内容（避免模型输出空段、表情解析失败等产生空白气泡） */
function isEmptyChatBubbleHtml(fragment) {
    const s = String(fragment || '').trim();
    if (!s) return true;
    if (/<\s*(img\b|svg\b|iframe\b|video\b|canvas\b)/i.test(s)) return false;
    if (/wechat-polaroid|chat-transfer-bubble|chat-location-bubble|chat-photo-flip|chat-gift-bundle|moments-polaroid/i.test(s)) {
        return false;
    }
    const stripped = s
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/(p|div|span|section)>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;|&#8203;|\u200b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return stripped.length === 0;
}

/** 模型偶发把 <img class="wechat-polaroid-img"> 放在 imgbox 外，导致灰框与真图上下分列；移入相框内 */
function normalizeWechatPolaroidDom(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.wechat-polaroid-wrap').forEach(function (wrap) {
        const box = wrap.querySelector('.wechat-polaroid-imgbox');
        if (!box) return;
        wrap.querySelectorAll('img.wechat-polaroid-img').forEach(function (img) {
            if (img.parentElement !== box) box.appendChild(img);
        });
    });
}

/** 必应拍立得图：缩略图常返回极小占位图且仍算「加载成功」，需换源兜底 */
function attachWechatPolaroidImgGuards(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('img.wechat-polaroid-img').forEach(function (img) {
        if (img.dataset.polaroidGuard === '1') return;
        img.dataset.polaroidGuard = '1';
        let pq = (img.getAttribute('data-pq') || '').trim();
        if (!pq && /[?&]q=/.test(img.src)) {
            try {
                const u = new URL(img.src, window.location.href);
                pq = decodeURIComponent(u.searchParams.get('q') || '').replace(/\+/g, ' ').trim();
            } catch (e) {}
        }
        img.setAttribute('data-pq', (pq || 'photo').slice(0, 120));

        const tryNext = function () {
            if (img.dataset.polaroidDone === '1') return;
            const st = parseInt(img.getAttribute('data-polaroid-stage') || '0', 10) + 1;
            img.setAttribute('data-polaroid-stage', String(st));
            const pqRaw = (img.getAttribute('data-pq') || 'photo').slice(0, 120);
            const bingQ = String(pqRaw).replace(/[^a-zA-Z0-9+]/g, '').slice(0, 200) || 'aesthetic';
            const bingEnc = encodeURIComponent(bingQ);
            if (st === 1) {
                img.src = `https://tse1.mm.bing.net/th?q=${bingEnc}&w=750&h=1000&c=7&rs=1`;
                return;
            }
            if (st === 2) {
                img.src = `https://tse2.mm.bing.net/th?q=${bingEnc}&w=750&h=1000&c=7&rs=1`;
                return;
            }
            if (st === 3) {
                const seed = encodeURIComponent(pqRaw.slice(0, 48).replace(/[^a-zA-Z0-9]/g, '') || 'lego');
                img.src = `https://picsum.photos/seed/${seed}/450/600`;
                return;
            }
            img.dataset.polaroidDone = '1';
            img.onerror = null;
            img.src = 'https://api.dujin.org/bing/m.php';
        };

        const onLoad = function () {
            if (img.dataset.polaroidDone === '1') return;
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            if (w > 0 && h > 0 && (w < 56 || h < 56)) tryNext();
        };
        img.addEventListener('load', onLoad);
        img.addEventListener('error', tryNext);
        if (img.complete) onLoad();
    });
}

/** 将文字内容和 HTML 格式世界书拆开，返回 { text, html }，用于分开展示到不同气泡 */
function splitTextAndHtmlWorldBook(content) {
    if (!content || typeof content !== 'string') return { text: '', html: '' };
    content = stripMarkdownCodeBlock(content.trim());
    content = decodeHtmlEntities(content);
    if (!looksLikeHtml(content)) return { text: content, html: '' };
    // 世界书格式：角色对白（纯文字）→ 换行 → HTML 内容。查找 HTML 块起始位置
    const htmlBlockRe = /\n\s*<(div|span|section|article|figure|table|img|svg|details|p|a\s)[\s>\/]/i;
    const m = content.match(htmlBlockRe);
    if (m) {
        const idx = content.indexOf(m[0]);
        const textPart = content.slice(0, idx).trim();
        const htmlPart = content.slice(idx).trim();
        return { text: textPart, html: htmlPart };
    }
    // 无换行分隔时，尝试查找首个块级标签
    const tagStartRe = /<(div|span|section|article|figure|table|img|svg|details|p)[\s>\/]/i;
    const tagMatch = content.match(tagStartRe);
    if (tagMatch) {
        const idx = content.indexOf(tagMatch[0]);
        const before = content.slice(0, idx).trim();
        if (!looksLikeHtml(before)) {
            return { text: before, html: content.slice(idx).trim() };
        }
    }
    return { text: '', html: content };
}

/** 构建消息气泡数组：文字与 HTML 世界书分开展示，文字内若有多个表情也拆成独立气泡 */
function buildMessageBubbles(content, options) {
    if (!content || typeof content !== 'string') return [];
    options = options || {};
    if (typeof resolveEmojiRefsInMessage === 'function' && typeof Moments !== 'undefined' && Moments.ui && typeof Moments.ui.momentsCollectAllEmojis === 'function') {
        content = resolveEmojiRefsInMessage(content, Moments.ui.momentsCollectAllEmojis());
    }
    const { text, html } = splitTextAndHtmlWorldBook(content);
    const bubbles = [];
    if (text) {
        const textHtml = buildMessageContentHtml(text, options);
        bubbles.push(...splitContentIntoBubbles(textHtml));
    }
    if (html) {
        const sanitized = sanitizeChatHtml(html);
        if (sanitized) {
            const htmlParts = splitHtmlIntoSeparateChatBubbles(sanitized);
            htmlParts.forEach(function (part) {
                const p = String(part || '').trim();
                if (!p) return;
                const chunks = splitContentIntoBubbles(p);
                chunks.forEach(function (c) {
                    const cc = String(c || '').trim();
                    if (cc) bubbles.push(cc);
                });
            });
        }
    }
    const kept = bubbles.filter(function (b) {
        return !isEmptyChatBubbleHtml(b);
    });
    if (kept.length) return kept;
    if (String(content || '').trim()) {
        return ['<span class="chat-bubble-fallback">（该条无可见文字或媒体）</span>'];
    }
    return [];
}

/** 将混合内容拆分为多个气泡：表情/图片单独一个气泡，文字单独一个气泡 */
function splitContentIntoBubbles(html) {
    if (!html || typeof html !== 'string') return [html];
    // 含 wechat-polaroid-wrap（含 <style> 标签或完整拍立得 HTML）：整段返回，
    // 避免按 <img> 拆分把样式块和结构块切碎，导致最终渲染成代码碎片。
    // 含拍立得相框类名也整段保留，禁止按 <img> 拆成多气泡（否则 img 与 imgbox 分属两个气泡，
    // normalizeWechatPolaroidDom 无法跨气泡把图移入框内 → 空灰框 + 图在旁错位）
    if (
        /<style\b/i.test(html) ||
        /\bwechat-polaroid-wrap\b/i.test(html) ||
        /\bwechat-polaroid-imgbox\b/i.test(html)
    ) {
        // 剥离 <style> 标签：样式已由 style.css 全局覆盖，<style> 在气泡 div 里
        // 属无效子节点，会被 isEmptyChatBubbleHtml 过滤而只留下结构 → 渲染成代码。
        // 去掉它使整个拍立得 HTML 成为一个完整有效的气泡。
        return [html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<style\b[^>]*\/?>/gi, '')];
    }
    if (!/<img/i.test(html)) return [html];
    const parts = [];
    const imgRe = /<img[^>]*>/gi;
    let lastIdx = 0;
    let m;
    while ((m = imgRe.exec(html)) !== null) {
        const before = html.slice(lastIdx, m.index).replace(/^\s+|\s+$/g, '');
        if (before) parts.push(before);
        const imgPart = m[0];
        // 每张图单独一个气泡，避免多条带图内容挤在同一气泡
        parts.push(imgPart);
        lastIdx = m.index + m[0].length;
    }
    const after = html.slice(lastIdx).replace(/^\s+|\s+$/g, '');
    if (after) parts.push(after);
    return parts.length ? parts : [html];
}

/** 将气泡片段包成 .chat-message-bubble；含拍立得时 trim + sanitize，避免内联 style / 残留片段导致横排错位 */
function mapPartsToChatMessageBubblesHtml(bubbleParts) {
    if (!bubbleParts || !bubbleParts.length) return '';
    return bubbleParts.map(function (p) {
        let body = String(p || '');
        if (/\bwechat-polaroid-wrap\b/i.test(body)) {
            body = sanitizeChatHtml(body).trim();
        }
        const polaroidCls =
            /\bwechat-polaroid-wrap\b/i.test(body) ? ' chat-message-bubble--polaroid-html' : '';
        return '<div class="chat-message-bubble' + polaroidCls + '">' + body + '</div>';
    }).join('');
}

/**
 * 模型常把「小图 + 文字 + 拍立得/卡片」包在一个 display:flex 容器里，导致挤在同一气泡。
 * 用 DOM 解析拆成多个并列气泡；仅当 flex/grid 且子项中疑似含图/卡片时才拆，避免误拆排版。
 */
function shouldSplitFlexRowForChatBubbles(el) {
    if (!el || el.nodeType !== 1 || el.children.length < 2) return false;
    const st = el.getAttribute('style') || '';
    if (!/display\s*:\s*(flex|inline-flex|grid)/i.test(st)) return false;
    let mediaOrCard = 0;
    Array.from(el.children).forEach(function (ch) {
        if (!ch || ch.nodeType !== 1) return;
        if (ch.tagName === 'IMG') mediaOrCard++;
        const sub = (ch.className || '') + ' ' + (ch.getAttribute('style') || '') + ch.innerHTML.slice(0, 400);
        if (/polaroid|wechat-polaroid|chat-photo|flip-root|art-vibe|moment|Daily|Record|拍立得/i.test(sub)) mediaOrCard++;
        if (ch.querySelector && ch.querySelector('img')) mediaOrCard++;
    });
    return mediaOrCard >= 1;
}

function explodeChatHtmlSegmentNode(node) {
    if (!node || node.nodeType !== 1) return [];
    if (shouldSplitFlexRowForChatBubbles(node)) {
        const out = [];
        Array.from(node.children).forEach(function (ch) {
            out.push.apply(out, explodeChatHtmlSegmentNode(ch));
        });
        return out.length ? out : [node.outerHTML];
    }
    return [node.outerHTML];
}

function splitHtmlIntoSeparateChatBubbles(html) {
    if (!html || typeof html !== 'string') return [''];
    const trimmed = html.trim();
    if (!trimmed) return [''];
    // 含拍立得 HTML（<style> 标签或 .wechat-polaroid-wrap）：整段返回，
    // 防止 DOM 把 <style> 和 div 分拆成两个气泡（<style> 被 isEmptyChatBubbleHtml
    // 过滤掉，只剩结构被渲染成代码碎片）。
    if (
        /<style\b/i.test(trimmed) ||
        /\bwechat-polaroid-wrap\b/i.test(trimmed) ||
        /\bwechat-polaroid-imgbox\b/i.test(trimmed)
    ) {
        return [trimmed];
    }
    try {
        const doc = new DOMParser().parseFromString(
            '<div class="chat-split-root">' + trimmed + '</div>',
            'text/html'
        );
        const root = doc.body.querySelector('.chat-split-root');
        if (!root) return [trimmed];
        const kids = Array.from(root.children);
        if (kids.length === 0) {
            const t = root.textContent.replace(/\s+/g, ' ').trim();
            return t ? [trimmed] : [''];
        }
        if (kids.length > 1) {
            const out = [];
            kids.forEach(function (ch) {
                out.push.apply(out, explodeChatHtmlSegmentNode(ch));
            });
            return out.length ? out : [trimmed];
        }
        return explodeChatHtmlSegmentNode(kids[0]);
    } catch (e) {
        return [trimmed];
    }
}

/** 对 HTML 内容做基础安全过滤，移除 script、iframe、事件处理器等 */
function sanitizeChatHtml(html) {
    if (!html || typeof html !== 'string') return '';
    const isAllowedImgOnError = (decoded) => {
        const s = String(decoded || '').replace(/\s+/g, ' ').trim();
        return (
            /^this\.onerror\s*=\s*null\s*;\s*this\.src\s*=\s*['"]https:\/\/api\.dujin\.org\/bing\/m\.php['"]$/i.test(s) ||
            /^this\.src\s*=\s*['"]https:\/\/api\.dujin\.org\/bing\/m\.php['"]$/i.test(s)
        );
    };
    const preservedOnErrors = [];
    let h = html.replace(/\s+onerror\s*=\s*(["'])((?:\\\1|.)*?)\1/gi, (full, q, inner) => {
        const decoded = inner
            .replace(new RegExp('\\\\' + q, 'g'), q)
            .replace(/\\(.)/g, '$1')
            .trim();
        if (isAllowedImgOnError(decoded)) {
            const id = preservedOnErrors.length;
            preservedOnErrors.push(full.trim());
            return ` data-chat-preserve-onerror="${id}"`;
        }
        return '';
    });
    h = h
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
        .replace(/<style\b[^>]*\/?>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
        .replace(/<embed\b[^>]*>/gi, '')
        .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
        .replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '')
        .replace(/javascript\s*:/gi, '');
    h = h.replace(/\s+data-chat-preserve-onerror="(\d+)"/g, (_, id) => {
        const idx = parseInt(id, 10);
        return preservedOnErrors[idx] != null ? preservedOnErrors[idx] : '';
    });
    // 模型常在拍立得相关标签上写 style="display:flex;flex-direction:row"，内联优先级高于 style.css，
    // 会导致相框与配文横排、配文被压成竖条；统一剥掉 class 含 wechat-polaroid 的标签上的 style
    h = h.replace(/<(\w+)\b([^>]*\bclass\s*=\s*["'][^"']*wechat-polaroid[^"']*["'][^>]*)>/gi, function (_full, tag, attrs) {
        const cleaned = String(attrs)
            .replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
            .replace(/\sstyle\s*=\s*'[^']*'/gi, '')
            .replace(/\sstyle\s*=\s*[^\s>]+/gi, '');
        return '<' + tag + cleaned + '>';
    });
    return h;
}

/** 解码可能的 HTML 实体（API 或传输层可能对 < > 等做了编码） */
function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** 检测内容是否包含 HTML 结构（用于决定是否启用 HTML 渲染） */
function looksLikeHtml(content) {
    if (!content || typeof content !== 'string') return false;
    return /<[a-z][a-z0-9]*[\s>\/]/i.test(content) || /<\/([a-z][a-z0-9]*)>/i.test(content) || content.includes('<img') || content.includes('<svg') || content.includes('<details');
}

/** 去除可能的 Markdown 代码块包裹（如 ```html ... ```） */
function stripMarkdownCodeBlock(str) {
    if (!str || typeof str !== 'string') return str;
    const m = str.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?```\s*$/);
    return m ? m[1].trim() : str;
}

/**
 * 将“外文（中文）”拆成可折叠的上下双语结构。
 * 只在好友明确选择非中文输出语言时启用；括号中必须含汉字，避免把普通补充说明误判成译文。
 */
function buildCollapsibleBilingualHtml(content, escapeHtml) {
    const source = String(content || '').trim();
    if (!source) return '';
    const translationRe = /[（(]([^（）()]*)[）)]/g;
    const pairs = [];
    let cursor = 0;
    let match;
    while ((match = translationRe.exec(source)) !== null) {
        const translation = String(match[1] || '').trim();
        if (!/[\u3400-\u9fff]/.test(translation)) continue;
        const original = source.slice(cursor, match.index).trim();
        if (!original) continue;
        pairs.push({ original: original, translation: translation });
        cursor = translationRe.lastIndex;
    }
    if (!pairs.length) return '';

    const tail = source.slice(cursor).trim();
    const pairHtml = pairs.map(function (pair) {
        return (
            '<details class="chat-bilingual-pair">' +
                '<summary class="chat-bilingual-original" title="点击展开中文翻译">' +
                    escapeHtml(pair.original).replace(/\r?\n/g, '<br>') +
                '</summary>' +
                '<div class="chat-bilingual-translation" lang="zh-CN">' +
                    escapeHtml(pair.translation).replace(/\r?\n/g, '<br>') +
                '</div>' +
            '</details>'
        );
    }).join('');
    const tailHtml = tail
        ? '<div class="chat-bilingual-tail">' + escapeHtml(tail).replace(/\r?\n/g, '<br>') + '</div>'
        : '';
    return '<div class="chat-bilingual-content">' + pairHtml + tailHtml + '</div>';
}

/** 将消息内容中的图片/表情 URL 渲染为 img 标签，支持文本中混入 URL；若包含 HTML 结构则渲染为 HTML（世界书美化等） */
function buildMessageContentHtml(content, options) {
    if (!content || typeof content !== 'string') return '';
    options = options || {};
    content = stripMarkdownCodeBlock(content.trim());
    content = decodeHtmlEntities(content);
    if (looksLikeHtml(content)) {
        return sanitizeChatHtml(content);
    }
    const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    if (isChatEmojiContent(content) && !/[\s<>]/.test(content)) {
        const src = content.startsWith('//') ? 'https:' + content : content;
        return `<img src="${escapeHtml(src)}" alt="表情" class="chat-emoji" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.onerror=null;this.classList.add('chat-emoji-broken');this.alt='加载失败';">`;
    }
    if (options.collapsibleTranslation) {
        const bilingualHtml = buildCollapsibleBilingualHtml(content, escapeHtml);
        if (bilingualHtml) return bilingualHtml;
    }
    const urlPattern = /(https?:\/\/[^\s<>"]+|\/\/[^\s<>"]+|data:image[^\s"<>]*)/g;
    let result = '';
    let lastIndex = 0;
    let m;
    while ((m = urlPattern.exec(content)) !== null) {
        result += escapeHtml(content.slice(lastIndex, m.index));
        const url = m[0].startsWith('//') ? 'https:' + m[0] : m[0];
        result += `<img src="${escapeHtml(url)}" alt="图片" class="chat-emoji" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="this.onerror=null;this.classList.add('chat-emoji-broken');this.alt='加载失败';">`;
        lastIndex = m.index + m[0].length;
    }
    result += escapeHtml(content.slice(lastIndex));
    return result;
}
