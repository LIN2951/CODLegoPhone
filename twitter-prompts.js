/**
 * Lego 小手机 · 推特/X — API 文案与 CommandManager 扩展
 * 依赖：app.js 中的 CommandManager、loadFriendsFromStorage、safeReadJsonFromStorage、parseJsonFromPossiblyEncodedStorage、
 * EMOJI_DATA_LS_KEY、formatMessageForApi、redactDataImageUrlsForApiPrompt、getWorldBookData；twitter-store.js（Twitter.store）
 * 加载顺序：app.js → moments-prompts.js → 本文件 → moments-ui.js → twitter-ui.js
 */
(function (global) {
    'use strict';

    /** 推特/X 全模块 API：好友↔用户私聊仅注入「最新 N 轮」完整来回（1 轮 = 用户一侧连续消息 + 好友一侧连续回复，与微信 CommandManager 轮定义一致） */
    var TWITTER_API_CHAT_HISTORY_MAX_ROUNDS = 8;
    /** 推荐 Tab：仅随机 1～3 名好友注入角色卡 + 私聊；私聊轮数固定为 8（与全站上限一致时可单独调） */
    var TWITTER_FOR_YOU_FRIEND_SAMPLE_MAX = 3;
    var TWITTER_FOR_YOU_CHAT_ROUNDS = 8;
    /** 用户主动发推相关互动：仅注入最新 3 轮私聊 */
    var TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS = 3;

    function twitterShuffleInPlace(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = arr[i];
            arr[i] = arr[j];
            arr[j] = t;
        }
        return arr;
    }

    /** 从本地好友（非群、未拉黑）中随机抽 1～3 人，用于推荐流 API 上文 */
    function twitterSampleFriendsForForYouFeed(allFriends) {
        var list = Array.isArray(allFriends) ? allFriends.filter(function (f) { return f && !f.blacklisted && !f.isGroup; }) : [];
        if (!list.length) return [];
        var cap = Math.min(TWITTER_FOR_YOU_FRIEND_SAMPLE_MAX, list.length);
        var count = 1 + Math.floor(Math.random() * cap);
        twitterShuffleInPlace(list);
        return list.slice(0, count);
    }

    /** 写入系统指令「推特规范①～④」时的统一说明（与 TWITTER_API_CHAT_HISTORY_MAX_ROUNDS 一致） */
    function twitterSpecChatHistoryUnifiedBanner() {
        var n = TWITTER_API_CHAT_HISTORY_MAX_ROUNDS;
        return (
            '【私聊记录 · 全推特统一】凡本指令涉及「好友 ↔ 用户」微信私聊：与 App 实际发往 API 的文本一致，**仅含最新 ' +
            n +
            ' 轮**完整来回。「1 轮」= 用户一侧连续消息块之后、好友一侧连续回复块（与微信记忆轮定义一致）。'
        );
    }

    function twitterWorldBookContentLooksLikeWechatDynamicTemplate(text) {
        const s = String(text || '').slice(0, 2500);
        if (!s || !/<[a-z]/i.test(s)) return false;
        if (/看你动态|私密动态|的私密动态|密友名单|密友名单·|仅你可见/.test(s)) return true;
        if (/正在输入中/.test(s) && /密友|私密动态/.test(s)) return true;
        return false;
    }
    
    function twitterShouldOmitWorldBookEntry(entry) {
        if (!entry || !entry.content) return true;
        const name = (entry.name || '').trim();
        if (/中英对照/.test(name)) return true;
        if (/功能性/.test(name) && /中英/.test(name)) return true;
        if (/看你动态|私密动态|密友|朋友圈|微信.*(模板|样式|HTML|美化|界面)|消息气泡|聊天界面|Story|Ins风|拍立得卡片/i.test(name)) return true;
        if (/功能指令|HTML|模板|CSS|脚本|组件|自动化|指令包|美化包|气泡样式|界面规范|私密聊天/i.test(name)) return true;
        const c = String(entry.content || '');
        const tagN = (c.match(/<[^>]+>/g) || []).length;
        if (tagN >= 10) return true;
        if (twitterWorldBookContentLooksLikeWechatDynamicTemplate(entry.content)) return true;
        return false;
    }
    
    function buildTwitterWorldBooksBlockFromFriends(friendList) {
        const friends = Array.isArray(friendList) ? friendList.filter(Boolean) : [];
        if (!friends.length) return '';
        const wbData = typeof getWorldBookData === 'function' ? getWorldBookData() : { entries: [] };
        const entries = wbData.entries || [];
        const ids = new Set();
        friends.forEach(f => {
            const wbIds = Array.isArray(f.worldBookIds) ? f.worldBookIds : (f.worldBookId ? [f.worldBookId] : []);
            wbIds.forEach(id => ids.add(String(id)));
        });
        const chunks = [];
        ids.forEach(id => {
            const wbEntry = entries.find(e => String(e.id) === String(id));
            if (!wbEntry || !wbEntry.content) return;
            if (twitterShouldOmitWorldBookEntry(wbEntry)) return;
            const mode = wbEntry.activationMode || 'global';
            chunks.push(`---
    世界书${wbEntry.name ? '《' + wbEntry.name + '》' : ''}（激活方式:${mode}）:
    ${wbEntry.content}
    `);
        });
        if (!chunks.length) return '';
        return `---\n【世界书设定·仅供推特/X任务】以下为**纯文字向**世界观与剧情参考；已自动跳过「中英对照」「功能性+中英」及「看你动态/私密动态/微信 HTML 模板」类条目。\n**禁止**将世界书中的任何 HTML/CSS 当作本条任务的输出结构；输出版式必须严格遵循下方「推特规范」时间轴 HTML。\n` + chunks.join('\n');
    }
    
    const TWITTER_CHINESE_OUTPUT_HARD_RULE = `---
    【推特·语言确则〃仅本条 API 调用、
    本任务仅用于 App 内「推特/X」界面，**不影响**微信等其他功能。
    
    【须为简体中文的部分」推文/评论**正文**、相对时间说明、互动区文案（如「评论数」「转推」等标签）、转推说明等叹述性文字须为**规范简体中文**。@handle、Lego_ 数字 ID 等技术标识保持原样。
    
    【账号「显示名」〃例外」HTML顶部该账号的**加粗显示名**（紧挥 @handle 之前那一项，不是 @ 本身）须与**角色卡**中该角色的本名/常用称呼**原文**一致：英文名写英文，德文名写德文，中文名写中文；**禁止**把整段显示名翻译成中文后再写入。若卡面同时给出中外文称呼，以卡上作为主要身份标识的那一种原文为准。
    
    【推荐流」约七成主帖为纯虚构路人；约三成主帖为卡面「关系网」类人物——显示名：路人**优先拉丁字母风格英文名**；卡面已写明的原名（含中文）**须与原文一致**。
    
    【正文」**禁止**整条推文或整段评论**正文**以外文为主（如连续多句英文/德文）；正文里的作品名、地名等可用中文叹述或括注译名。`;
    /** 世界书与推特输出边界：防止模型照抄「看你动态」等微信专用 HTML */
    const TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE = `---
    【世界书 · 推特任务｜输出边界｜最高优先级】
    好友关联的世界书条目（若有）**仅**供世界观、人际关系、用语与剧情灵感等**文字设定**参考。
    **绝对禁止**：复用或模仿世界书中为「微信 / 看你动态 / 私密动态 / 密友 / Story / 卡片弹层」等模块编写的 **HTML 结构、CSS 类名、大圆头像环、LIVE 角标、「正在输入中」药丸条、渐变故事卡** 等任何界面；也禁止输出与推特/X 时间轴明显不符的「单卡居中私密动态」版式。
    **绝对禁止输出 CSS 样式表**：不得输出 \`<style>\` 标签、不得输出 \`.class { … }\` / \`#id { … }\` 规则块、不得把样式代码当正文；样式由 App 全局 CSS 负责，你**只输出 HTML 推文 DOM**（含 \`class="tweet"\` 等）。
    **本条唯一合法 UI**：App 内「推特/X」时间轴主帖，须与激活的「推特规范①②③」一致——典型为横向 \`display:flex\`、左侧约 **48px** 圆底 **首字** 头像占位（非 emoji 大图环）、右侧首行 **加粗显示名** + 灰字 **@handle** + 时间、**正文**、底部 **评论/转发/喜欢/浏览** 互动行；背景浅色 **#E7E8EA**，主字 **#0f1419**。
    世界书设定与推特版式冲突时，**一律以推特规范为准**；可从世界书取「发什么内容」，**不可**取「长什么样」。`;
    
    /** 从角色卡正文解析用于推特顶栏的「原文显示名」（实现见 twitter-store.js） */
    function twitterExtractRoleCardDisplayName(roleText) {
        return Twitter.store.extractRoleCardDisplayName(roleText);
    }

    function twitterUserNpcIdentityHardRule(userAt) {
        var at = String(userAt || 'lego').replace(/^@/, '');
        return (
            '---\n【User / NPC 身份红线｜最高优先级】\n' +
            '1) **{{user}}** 仅指手机机主本人，推特账号为 **@' + at + '**。**严禁**模型替 User 在 HTML 中写 `.tweet-reply` / 评论区留言——用户只在 App 内亲自输入。\n' +
            '2) 角色卡「关系网 / 助理 / 闺蜜 / 家人 / 同事 / 粉丝 / 路人 NPC」**均不是 {{user}}**；不得把这些 NPC 当作 User 发帖，不得让 Char 在正文中暗示「某 NPC 就是 User 本人」。\n' +
            '3) 正文 @' + at + ' 仅为**点名提及**，帖子作者栏必须是发帖 NPC/Char 自己的 @handle，不得把被 @ 者当作作者。\n' +
            '4) 好友（Char）发推时若写到与 User 的关系，须区分「User 本人 @' + at + '」与「关系网 NPC（各自独立 @）」；禁止混为一谈。\n' +
            '5) 时间轴刷新**只输出主帖 HTML**，**禁止**在时间轴 HTML 内嵌任何评论区/回复/楼中楼（详情页才展示评论）。\n' +
            '6) 好友主帖 @handle 须优先使用上文「好友」段落给出的 @，或 `Lego_`+好友 id；勿自拟 `@代号_数字` 以免客户端头像无法匹配。'
        );
    }
    
    /** 好友在推特时间轴/详情中应展示的显示名（实现见 twitter-store.js） */
    function twitterResolveFriendAuthorDisplayName(f) {
        return Twitter.store.resolveFriendAuthorDisplayName(f);
    }
    
    /**
     * 按场景注入推特类系统指令，避免「①②③④ 全量塞进同一次请求」导致重复与冲突。
     * scope: 'forYou' | 'following' | 'detail' | 'friendReply' | 'all'
     */
    function twitterCommandAllowedForScope(name, scope) {
        var n = String(name || '').trim();
        if (n === '推特指令') {
            return scope !== 'friendReply';
        }
        if (!scope || scope === 'all') {
            return n === '推特指令' || /^推特规范[①②③④]/.test(n) || (/推特/.test(n) && /规范/.test(n));
        }
        if (scope === 'forYou') {
            return /^推特规范③/.test(n);
        }
        if (scope === 'following') {
            return /^推特规范①/.test(n);
        }
        if (scope === 'detail') {
            return /^推特规范②/.test(n);
        }
        if (scope === 'friendReply') {
            return false;
        }
        return n === '推特指令' || /^推特规范[①②③④]/.test(n) || (/推特/.test(n) && /规范/.test(n));
    }

    function appendTwitterSystemRuleCommandsForTwitter(parts, scope) {
        if (typeof CommandManager === 'undefined' || !CommandManager.getActiveCommands) return;
        const active = CommandManager.getActiveCommands();
        const seen = new Set();
        const sc = scope || 'all';
        active.forEach(cmd => {
            const n = (cmd.name || '').trim();
            if (!cmd || !cmd.content) return;
            if (n === '核心指令') return;
            if (/微信/.test(n)) return;
            if (!twitterCommandAllowedForScope(n, sc)) return;
            if (seen.has(n)) return;
            seen.add(n);
            parts.push(`---\n【系统推特规则 · ${n}】\n${cmd.content}`);
        });
    }
    
    /** 娱乐时间轴：仅附加「推特指令」与「推特规范④」，避免注入①②③ 使请求体过大、加剧上游超时 */
    function appendTwitterEntertainmentRulesOnly(parts) {
        if (typeof CommandManager === 'undefined' || !CommandManager.getActiveCommands) return;
        const active = CommandManager.getActiveCommands();
        const seen = new Set();
        active.forEach(cmd => {
            const n = (cmd.name || '').trim();
            if (!cmd || !cmd.content) return;
            if (/微信/.test(n)) return;
            const ok = n === '推特指令' || n === '推特规范④ · 娱乐板块';
            if (!ok) return;
            if (seen.has(n)) return;
            seen.add(n);
            parts.push(`---\n【系统推特规则 · ${n}】\n${cmd.content}`);
        });
    }
    
    /**
     * 与 appendTwitterSystemRuleCommandsForTwitter 判定一致：此类指令仅应出现在推特/X API 请求中，
     * 不得注入微信聊天，否则模型会在私聊里输出推文时间轴 HTML。
     */
    function isTwitterOnlySystemCommandName(name) {
        const n = String(name || '').trim();
        if (!n) return false;
        if (/微信/.test(n)) return false;
        return n === '推特指令' || /^推特规范[①②③④]/.test(n) || (/推特/.test(n) && /规范/.test(n));
    }

    function _buildTwitterChatHistoryLines(friendId, maxRounds, fmt) {
        const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
        const rounds = [];
        let i = 0;
        while (i < chatHistory.length) {
            const round = { user: [], friend: [] };
            while (i < chatHistory.length && chatHistory[i].type === 'user') {
                round.user.push(chatHistory[i].content);
                i++;
            }
            while (i < chatHistory.length && chatHistory[i].type === 'friend') {
                round.friend.push(chatHistory[i].content);
                i++;
            }
            if (round.user.length > 0 && round.friend.length > 0) rounds.push(round);
            while (i < chatHistory.length && chatHistory[i].type !== 'user' && chatHistory[i].type !== 'friend') i++;
        }
        var cap =
            typeof maxRounds === 'number' && maxRounds > 0
                ? Math.min(maxRounds, TWITTER_API_CHAT_HISTORY_MAX_ROUNDS)
                : TWITTER_API_CHAT_HISTORY_MAX_ROUNDS;
        const recent = rounds.slice(-cap);
        const lines = [];
        recent.forEach(r => {
            r.user.forEach(c => lines.push(`用户: ${fmt(c)}`));
            r.friend.forEach(c => lines.push(`好友: ${fmt(c)}`));
        });
        if (lines.length === 0) return '（暂无聊天记录，仅依据角色卡与关系发帖即可）';
        return lines.join('\n');
    }

    /**
     * 暗网论坛中「机主/Char」在提示词与生成中的显示名：优先用户为当前好友在档案中保存的**暗网代号**（按好友 id），
     * 未填则仅使用**角色卡**中解析的姓名/称呼，不含好友列表昵称、备注；无好友时回退为机主 myProfile 昵称或「该机主」。
     */
    function resolveDarkWebCharDisplayNameForApi(friend) {
        var store = global.Twitter && global.Twitter.store;
        if (friend && store && typeof store.loadProfileByMode === 'function') {
            var fid = friend.id != null ? String(friend.id) : '';
            var profile = store.loadProfileByMode('darkweb') || {};
            var m = profile.charDarkwebAliasByFriendId;
            if (fid && m && typeof m === 'object' && !Array.isArray(m) && m[fid] != null) {
                var custom = String(m[fid]).trim();
                if (custom) return custom;
            }
            if (typeof store.resolveFriendAuthorRoleCardNameForDarkWeb === 'function') {
                var cardN = String(store.resolveFriendAuthorRoleCardNameForDarkWeb(friend) || '').trim();
                if (cardN) return cardN;
            }
        }
        if (friend) {
            return '该机主';
        }
        var myProfile = safeReadJsonFromStorage('myProfile', null);
        return (myProfile && myProfile.nickname) ? String(myProfile.nickname).trim() : '该机主';
    }

    function resolveDarkWebOwnerNickname() {
        var phone = global.PhoneFeature && global.PhoneFeature.state;
        var friend = phone && phone.friend;
        return resolveDarkWebCharDisplayNameForApi(friend);
    }

    /** 暗网论坛：私聊仅作关系气氛参考，轮数宜少，禁止模型照搬原句 */
    var DARKWEB_API_CHAT_REFERENCE_MAX_ROUNDS = 3;

    function resolveDarkWebInvadedFriend() {
        var phone = global.PhoneFeature && global.PhoneFeature.state;
        return phone && phone.friend ? phone.friend : null;
    }

    function darkWebSectionNameToKind(sectionName) {
        var s = String(sectionName || '').trim();
        if (s === '风向') return 'following';
        if (s === '深海') return 'forYou';
        if (s === '清扫') return 'entertainment';
        return 'hub';
    }

    function darkwebShouldOmitWorldBookEntry(entry) {
        if (twitterShouldOmitWorldBookEntry(entry)) return true;
        var name = (entry.name || '').trim();
        var c = String(entry.content || '');
        if (/私密|隐私|仅你可见|隐藏设定|内心独白|关系秘密|床戏|R18|NSFW|成人向|亲密细节|不要告诉|只有.*知道|密友日记/i.test(name)) return true;
        if (/私密动态|仅你可见|密友名单|内心独白|隐私设定|亲密细节|床戏|不要告诉|只有[^\n]{0,12}知道|我们的秘密|别让别人知道/i.test(c.slice(0, 4000))) return true;
        return false;
    }

    function buildDarkWebWorldBooksBlockFromFriends(friendList) {
        var friends = Array.isArray(friendList) ? friendList.filter(Boolean) : [];
        if (!friends.length) return '';
        var wbData = typeof getWorldBookData === 'function' ? getWorldBookData() : { entries: [] };
        var entries = wbData.entries || [];
        var ids = new Set();
        friends.forEach(function (f) {
            var wbIds = Array.isArray(f.worldBookIds) ? f.worldBookIds : (f.worldBookId ? [f.worldBookId] : []);
            wbIds.forEach(function (id) { ids.add(String(id)); });
        });
        var chunks = [];
        ids.forEach(function (id) {
            var wbEntry = entries.find(function (e) { return String(e.id) === String(id); });
            if (!wbEntry || !wbEntry.content) return;
            if (darkwebShouldOmitWorldBookEntry(wbEntry)) return;
            var mode = wbEntry.activationMode || 'global';
            chunks.push('---\n世界书' + (wbEntry.name ? '《' + wbEntry.name + '》' : '') + '（激活方式:' + mode + '）:\n' + wbEntry.content);
        });
        if (!chunks.length) return '';
        return '---\n【世界书·暗网论坛任务｜仅供世界观与职业背景参考】\n已自动跳过：中英对照/功能性模板、微信 HTML 模板、以及标题或正文含「私密/隐私/仅你可见/亲密细节」等条目。\n**禁止**把下列任何原文搬进帖子正文。\n' + chunks.join('\n');
    }

    var DARKWEB_REFERENCE_MATERIAL_RULE = `---
【暗网论坛·参考材料边界｜最高优先级】
下文「世界书」「角色卡」「聊天记录」（若有）**仅**作世界观氛围、职业底色、用语习惯的**辅助参考**，不是帖子素材库。

【绝对禁止】
1. **禁止**把世界书原文、私密设定、档案段落直接写进任何帖子（含机主本人发的帖）。
2. **禁止**把 Char 与 User 的微信聊天记录原句、对话情节直接改写或扩写为论坛帖子。
3. **禁止**用设定文档/百科口吻写帖（逐条复述设定、像在粘贴世界观资料）。
4. **禁止**把仅存在于世界书或私聊中的隐藏关系、私密事件，当作论坛「公开情报」原样曝光。

【应当做】
1. 每条帖子须是**论坛用户自然发言**：口语、黑话、半截话、立场、留白、匿名感。
2. 机主本人发帖时，只借角色卡中的**公开职业/行事风格**把握语气，写**全新原创**短帖，不得写成日记、档案复述或设定扩写。
3. 可从参考材料**提炼**圈内黑话、任务类型、组织气质，但正文必须是**新写的论坛内容**。`;

    function getDarkWebZoneBoundaryRule(feedKind, sectionName) {
        var zone = feedKind || darkWebSectionNameToKind(sectionName);
        if (zone === 'following') {
            return '【板块边界·风向】**风向是唯一允许**出现八卦、绯闻、吃瓜、排行榜传闻、匿名闲谈爆料的区域。帖子须像圈内闲话，**禁止**像泄露设定集或世界书摘抄。';
        }
        if (zone === 'forYou') {
            return '【板块边界·深海】本板块只写**情报**向内容：受限档案、灰色交易、编号文件、脱敏摘要、权限门槛、线索残片。情报须从世界观世界书与机主角色卡**工作经历/行动背景****衍生**出新内容，**禁止**照搬世界书原文。**严禁**八卦、绯闻、吃瓜、排行榜、街头传闻类帖子。';
        }
        if (zone === 'entertainment') {
            return '【板块边界·清扫】本板块只写**黑话委托/悬赏/招募**：佣兵、杀手、特工、回收、押运、护送政治要员、军火物资、清理杀人现场、转移被通缉人员等灰色工单。**绝对禁止**任何八卦、绯闻、吃瓜、排行榜、闲聊爆料类内容。';
        }
        return '【首页热帖·气质混合】可混合八卦传闻、情报残片、委托黑话等气质，但每条仍须**原创论坛口吻**；**禁止**照搬世界书或聊天记录；正文中不要写出「风向/深海/清扫」分区名。';
    }

    function appendDarkWebWorldBookAndReferenceRules(parts, friend, options) {
        if (!friend) return;
        options = options || {};
        var wbBlock = buildDarkWebWorldBooksBlockFromFriends([friend]);
        if (wbBlock) parts.push(wbBlock);

        var emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        var allEmojis = [];
        for (var c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        var fmt = function (line) {
            return typeof formatMessageForApi === 'function' ? formatMessageForApi(line, allEmojis) : line;
        };
        var hist = _buildTwitterChatHistoryLines(friend.id, DARKWEB_API_CHAT_REFERENCE_MAX_ROUNDS, fmt);
        parts.push('---\n【机主与用户的最近私聊·仅供关系气氛参考（**禁止**引用原句或改编为帖子）】\n' + hist);

        parts.push(DARKWEB_REFERENCE_MATERIAL_RULE);
        var zoneRule = getDarkWebZoneBoundaryRule(options.feedKind, options.sectionName);
        if (zoneRule) parts.push('---\n' + zoneRule);
    }

    function appendDarkWebInvadedFriendReferenceContext(parts, options) {
        options = options || {};
        var friend = options.friend || resolveDarkWebInvadedFriend();
        if (!friend) return;
        appendDarkWebWorldBookAndReferenceRules(parts, friend, options);
        var ownerNick = resolveDarkWebCharDisplayNameForApi(friend);
        parts.push('---\n【机主/Char·角色卡·仅供气质与职业背景参考（不可原文搬运）】\n暗网论坛显示名: ' + ownerNick + '\n角色卡（重点可参考：公开身份、工作经历、行事风格、圈内代号；**不要**把卡面逐段改写成帖子）:\n' + (friend.roleSetting || friend.role || '无'));
    }

    function buildDarkWebSendContent(feedKind) {
        const kind = feedKind || 'forYou';
        const ownerNick = resolveDarkWebOwnerNickname();
        const parts = [];
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));
        appendDarkWebInvadedFriendReferenceContext(parts, { feedKind: kind });
        parts.push(`---
【暗网论坛·总规则】

你现在生成的是一个虚构的地下论坛板块内容。
论坛属于 COD / 使命召唤系列衍生的同人性质小手机内容，所有内容都必须是虚构演绎，只服务于角色氛围与世界观沉浸，不对应现实世界，不提供现实可执行违法指导。

【世界观要求】
1. 整体气质必须符合地下论坛、灰色情报圈、佣兵圈、匿名任务委托圈的氛围。
2. 所有帖子都应像论坛用户自然发布，而不是系统公告、任务说明书或旁白设定文。
3. 允许使用匿名代号、黑话、圈内隐语、任务简称、人物外号、档案编号。
4. 不要把内容写成现实教程，不要提供现实中可直接执行的犯罪方案、操作步骤、规避方式或具体实施细节。
5. 重点是“氛围真实”，不是“操作真实”。

【沉浸要求】
1. 页面与内容中不要出现 Char、User、{{char}}、{{user}} 等字样。
2. 如果涉及机主本人发帖，必须使用角色卡上的昵称（当前语境下机主角色卡昵称为「${ownerNick}」）。
3. 如果机主本人发帖，正文必须是第一人称。
4. 绝对不能出现“User发帖”。
5. 绝对不能出现以 User 视角写的第一人称正文。
6. 如果帖子不是机主本人发布，就不要强行让机主本人出场。
7. 机主本人发的帖须像论坛随口发言，**禁止**大段复述世界书、角色档案或私聊内容。

【输出要求】
1. 输出内容必须像论坛帖子流，不要写解释，不要写设定说明。
2. 每条帖子都应有明确发帖人口吻，避免全部帖子像同一个人写的。
3. 用简体中文输出。
4. 允许不同立场、不同身份、不同语气的发帖人存在。
5. 内容必须服务于当前板块定位，不要串板块气质。
6. 世界书与聊天记录只能作参考辅料，**不得**直接扩写成帖子正文。
`);
        if (kind === 'following') {
            parts.push(`---
【暗网论坛板块：风向】

你现在要生成“风向”板块的帖子内容。

【板块定位】
风向板块是地下论坛中的灌水、八卦、传闻、排行榜、匿名闲聊区域。
这里的帖子大多围绕知名佣兵、老牌行动人员、危险人物、失踪者、热门任务参与者的八卦趣闻展开。
也可以出现能力排行、黑话调侃、真假难辨的传闻贴、围观讨论贴、旧事翻出贴。

【内容方向】
可优先生成以下类型的帖子：
1. 某位知名佣兵的传闻、趣闻、旧事、绯闻、翻车经历。
2. 佣兵能力排行榜、危险程度排行榜、生还率排行榜、接单成功率排行榜。
3. 某次行动后留下的坊间讨论、猜测、吃瓜串。
4. 对某个神秘人物真实身份的匿名猜测。
5. 围绕圈内名人展开的调侃、对赌、押注、匿名评价。
6. “听说”“据说”“有人见过”“旧档翻出来了”这类真假不明的爆料贴。

【风格要求】
1. 语气可以松散、嘴碎、揶揄、阴阳怪气、半真半假。
2. 帖子重点是“谈资感”和“八卦感”，不是严肃任务发布。
3. 允许有夸张传闻，但仍要贴合世界观，不要胡乱跳脱。
4. 发帖人可以是匿名号、围观路人、老油条、情报贩子、看热闹的圈内人。
5. 不要把风向板块写成情报档案区，也不要写成正式任务区。

【禁止事项】
1. 不要把帖子写成现实行动指南。
2. 不要写成系统公告或管理员说明。
3. 不要整页都是同一种语气。
4. 不要出现 Char、User、{{char}}、{{user}}。
5. 若机主本人发帖，只能使用角色卡昵称「${ownerNick}」，且正文必须第一人称；**禁止**搬运世界书/私聊原文。
6. **风向是唯一允许八卦类内容的板块**；本板块内八卦也须写成圈内闲话，不得像设定摘抄。

【输出目标】
生成一组符合“地下论坛风向板块”气质的帖子：
- 有八卦感
- 有传闻感
- 有圈内闲谈感
- 有排行榜和匿名讨论的热帖氛围
`);
        } else if (kind === 'forYou') {
            parts.push(`---
【暗网论坛板块：深海】

你现在要生成“深海”板块的帖子内容。

【板块定位】
深海板块是地下论坛中的特殊情报区域。
这里的内容通常涉及受限档案、危险情报、灰色情报交易、权限访问、编号文件、脱敏摘要、高级ID成员可见内容。
部分帖子只给出情报残片、摘要、报价、风险评级、查看门槛，不会一次性公开全部信息。

【内容方向】
可优先生成以下类型的帖子：
1. 特殊情报摘要、受限档案编号、已脱敏报告、来源不明的机密残页。
2. “仅高级ID可见”的情报预览贴。
3. 高价交易情报、情报交换条件、权限不足提示贴。
4. 某个危险区域、失踪任务、异常人物、封锁节点的线索汇总。
5. 真假未明的灰色情报与试探性竞拍贴。
6. 对某份情报真伪、价值、来源的匿名评估与试探。
7. 结合世界观世界书与机主角色卡**工作经历/行动背景**，**衍生**出新的情报残片（须原创表述，禁止照搬设定原文）。

【风格要求】
1. 强化权限感、门槛感、冷感、距离感、交易感。
2. 帖子正文可以只展示部分内容，不要把所有情报一次写透。
3. 多用“已脱敏”“权限不足”“剩余内容折叠”“查看权限受限”“高价开放次级阅览”这类表达。
4. 发帖人可以是情报贩子、档案持有人、匿名中介、灰市卖家、权限成员。
5. 气质应偏克制、冷静、压抑，而不是灌水热闹。

【禁止事项】
1. 不要把深海板块写成八卦闲聊区；**严禁**绯闻、吃瓜、排行榜、街头传闻。
2. 不要把深海板块写成直白的现实情报教学。
3. 不要写出现实可执行的违法细节。
4. 不要出现 Char、User、{{char}}、{{user}}。
5. 若机主本人发帖，只能使用角色卡昵称「${ownerNick}」，且正文必须第一人称；**禁止**搬运世界书/私聊原文。
6. **禁止**把世界书条目直接改写成情报帖；只能**衍生**新的残片化情报。

【输出目标】
生成一组符合“地下论坛深海板块”气质的帖子：
- 有权限门槛
- 有情报交易感
- 有档案编号感
- 有残片化、灰色、危险的阅读氛围
`);
        } else {
            parts.push(`---
【暗网论坛板块：清扫】

你现在要生成“清扫”板块的帖子内容。

【板块定位】
清扫板块是地下论坛中的悬赏、招揽、危险委托、人员招募区域。
这里的帖子大多是发布危险任务、招募佣兵、招揽杀手、寻找回收人员、安排护送、清场、追踪、封口等灰色委托。
表达方式通常带有黑话、代号、圈内隐语，不会写成正常招聘启事。

【内容方向】
可优先生成以下类型的帖子：
1. 危险任务招募贴。
2. 佣兵、杀手、侦察、回收、押运、护送类委托贴。
3. 悬赏目标、封口委托、清场委托、追踪回收任务。
4. 限时任务、分段付款、风险极高的短期招揽。
5. 中间人代发的任务单、条件筛选帖、接单资格贴。
6. 失败后果、风险评级、接头要求、订金规则之类的灰色任务说明。
7. 护送政治要员、军火/物资转运、清理杀人现场、转移被通缉人员、封口与回收等**职业向**委托（用黑话表述，禁止写成八卦）。

【风格要求】
1. 多使用黑话、代号、圈内术语、任务简称、隐语表达。
2. 不要写成普通白话招聘广告。
3. 强调高风险、高报酬、低信任、短时限、地下委托氛围。
4. 发帖人可以是中间人、匿名雇主、老牌承包商、回收代理、悬赏中介。
5. 帖子要有“圈内人才看得懂”的感觉，但仍需让读者能读出危险与报酬感。

【禁止事项】
1. 不要提供现实中可直接执行的违法操作步骤。
2. 不要把清扫板块写成情报档案区或八卦闲聊区；**绝对禁止**八卦、绯闻、吃瓜、排行榜、传闻贴。
3. 不要写成系统教程或现实犯罪教学。
4. 不要出现 Char、User、{{char}}、{{user}}。
5. 若机主本人发帖，只能使用角色卡昵称「${ownerNick}」，且正文必须第一人称；**禁止**搬运世界书/私聊原文。

【输出目标】
生成一组符合“地下论坛清扫板块”气质的帖子：
- 有任务委托感
- 有悬赏招募感
- 有黑话与圈内隐语氛围
- 有危险、地下、临时交易的压迫感
`);
        }
        parts.push(`---
【硬规则补充】
1. 前端已经固定渲染论坛规则卡、侧边栏、设置界面；模型只负责生成帖子内容，不生成这些界面结构。
2. 若帖子中出现机主本人，机主署名只能使用角色卡昵称「${ownerNick}」，不允许使用抽象玩家称呼，不允许使用默认占位身份。

【版面与 HTML 输出（系统约束 · 论坛帖子列表）】
1. 只输出可直接渲染的 HTML，禁止 markdown 代码围栏、禁止 JSON、禁止在帖流外写任何编者说明。
2. 外层必须有且仅有一个容器：\`<div class="friend-darkweb-forum-list">\` … \`</div>\`，其内为若干条主帖；禁止把整个列表再包进单个 \`.tweet\`。
3. 每一条主帖必须是独立的 \`<article class="tweet friend-darkweb-thread">\`（**亦可**为 \`<div class="tweet friend-darkweb-thread">\`），**class 中必须同时出现 \`tweet\` 与 \`friend-darkweb-thread\`**，结构和其余 class 名称须与下例一致（可适当换行缩进）：
\`<article class="tweet friend-darkweb-thread">
<header class="tweet-header friend-darkweb-thread-head">
<span class="tweet-name display-name">显示名</span>
<span class="tweet-handle handle">@handle</span>
<span class="tweet-time time">时间或相对时间</span>
</header>
<h3 class="friend-darkweb-thread-title">帖子主题（约 8～24 字，单独一行，像论坛标题）</h3>
<div class="tweet-text tweet-content friend-darkweb-thread-summary">内容简介：1～3 个 \`<p>\` 或短段落，总字数约 80～220 字，只用于列表预览，不要与标题重复整句</div>
<footer class="tweet-interactions friend-darkweb-thread-meta"><span>回复 · 数字</span><span>最后回复 · 时间或昵称</span></footer>
</article>\`
4. 本任务主帖数量须为 6～10 条；每条发帖人身份与语气须有区分；禁止整页同腔调；禁止把多条帖拼成一段连续正文。
5. 单帖主容器内禁止再嵌套第二个带 \`class="tweet"\` 的元素；禁止楼中跟帖，列表只展示主帖行。
6. 排序：容器内从上到下须为「最新 → 较旧」（第一条最新），如同论坛默认按最后活跃/发帖时间倒序。
7. 不要输出论坛规则卡、侧边栏、设置页、顶部工具栏。
8. 任何位置都不要出现“Char”“User”“{{char}}”“{{user}}”。
9. 若主帖作者为机主「${ownerNick}」，正文须是**原创论坛口语**，**禁止**复述世界书、角色档案或私聊情节。
`);
        return redactDataImageUrlsForApiPrompt(parts.join('\n'));
    }

    function buildDarkWebHubSendContent() {
        const ownerNick = resolveDarkWebOwnerNickname();
        const parts = [];
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));
        appendDarkWebInvadedFriendReferenceContext(parts, { feedKind: 'hub' });
        parts.push(`---
【暗网论坛·总规则】

你现在生成的是一个虚构的地下论坛板块内容。
论坛属于 COD / 使命召唤系列衍生的同人性质小手机内容，所有内容都必须是虚构演绎，只服务于角色氛围与世界观沉浸，不对应现实世界，不提供现实可执行违法指导。

【世界观要求】
1. 整体气质必须符合地下论坛、灰色情报圈、佣兵圈、匿名任务委托圈的氛围。
2. 所有帖子都应像论坛用户自然发布，而不是系统公告、任务说明书或旁白设定文。
3. 允许使用匿名代号、黑话、圈内隐语、任务简称、人物外号、档案编号。
4. 不要把内容写成现实教程，不要提供现实中可直接执行的犯罪方案、操作步骤、规避方式或具体实施细节。
5. 重点是“氛围真实”，不是“操作真实”。

【沉浸要求】
1. 页面与内容中不要出现 Char、User、{{char}}、{{user}} 等字样。
2. 如果涉及机主本人发帖，必须使用角色卡上的昵称（当前语境下机主角色卡昵称为「${ownerNick}」）。
3. 如果机主本人发帖，正文必须是第一人称。
4. 绝对不能出现“User发帖”。
5. 绝对不能出现以 User 视角写的第一人称正文。
6. 如果帖子不是机主本人发布，就不要强行让机主本人出场。
7. 机主本人发的帖须像论坛随口发言，**禁止**大段复述世界书、角色档案或私聊内容。

【暗网论坛·首页热帖】
你现在生成的是论坛「首页」上展示的少量热门帖子预览（用户尚未进入风向/深海/清扫分区）。

【任务说明】
1. 只生成 2～4 条主帖（数量在此区间内随机取定），每条为独立发帖人，语气与身份须有区分。
2. 帖子气质可混合体现：风向式八卦传闻、深海式情报门槛与残片感、清扫式悬赏黑话与委托感——至少覆盖其中两种气质，但正文中不要写出板块名、分区标签或「风向/深海/清扫」字样。
3. 整体须像论坛首页热榜摘要，不要写系统说明或编者旁白。
4. 用简体中文输出。
5. 世界书与聊天记录只能作参考辅料，**不得**直接扩写成帖子正文。

【硬规则补充】
1. 前端已经固定渲染论坛规则卡、侧边栏、设置界面；模型只负责生成帖子内容，不生成这些界面结构。
2. 若帖子中出现机主本人，机主署名只能使用角色卡昵称「${ownerNick}」，不允许使用抽象玩家称呼，不允许使用默认占位身份。

【版面与 HTML 输出（系统约束 · 论坛帖子列表）】
1. 只输出可直接渲染的 HTML，禁止 markdown 代码围栏、禁止 JSON。
2. 外层必须有且仅有一个 \`<div class="friend-darkweb-forum-list">\`，内为 2～4 条主帖；禁止整页包在一个 \`.tweet\` 里。
3. 每条主帖结构必须与板块列表相同：\`<article class="tweet friend-darkweb-thread">\`，内含 \`header.tweet-header.friend-darkweb-thread-head\`（\`.tweet-name\` \`.tweet-handle\` \`.tweet-time\`）、\`h3.friend-darkweb-thread-title\`（主题）、\`div.tweet-text.friend-darkweb-thread-summary\`（列表摘要）、\`footer.tweet-interactions.friend-darkweb-thread-meta\`（回复数与最后回复等）。**主帖外标签可改用 \`div\` 但 class 须同时含 \`tweet\` 与 \`friend-darkweb-thread\` 两词，缺一不可。**
4. 单帖内禁止嵌套第二个 \`class="tweet"\`；禁止楼中楼；从上到下为最新到较旧。
5. 不要输出规则卡、侧栏、设置页。
6. 任何位置都不要出现“Char”“User”“{{char}}”“{{user}}”。
7. 若主帖作者为机主「${ownerNick}」，正文须是**原创论坛口语**，**禁止**复述世界书、角色档案或私聊情节。
`);
        return redactDataImageUrlsForApiPrompt(parts.join('\n'));
    }

    /**
     * 暗网论坛详情：共享的上下文与规则。主楼可单独、评论区可单独、也可 full-page 一次出齐。
     */
    function buildDarkWebDetailSharedPreamble(self, payload) {
        if (!payload) return null;
        var nickname = resolveDarkWebOwnerNickname();
        var sectionName = payload.darkWebSectionName ? String(payload.darkWebSectionName).trim() : '';
        var parts = [];
        self.getCoreCommands().forEach(function (cmd) { parts.push(cmd.content); });
        parts.push(`---
【暗网论坛·详情页 · 规则对齐】
与列表页一致：虚构地下论坛演绎；禁止 Char、User、{{char}}、{{user}}；机主仅能用角色卡昵称「${nickname}」且第一人称；禁止现实可执行违法细节。
【硬规则】前端已固定论坛规则卡、侧边栏、设置界面。若出现机主本人，署名只能为角色卡昵称「${nickname}」，禁止抽象玩家称呼与默认占位身份。
扩写主楼/评论时**禁止**复读世界书设定、**禁止**引用聊天记录原句；须保持论坛帖文体，世界书与私聊仅可作灵感参考。
`);
        if (payload.friend) {
            appendDarkWebWorldBookAndReferenceRules(parts, payload.friend, {
                feedKind: darkWebSectionNameToKind(sectionName),
                sectionName: sectionName
            });
        }
        if (payload.friend) {
            var f = payload.friend;
            var authorName = String(resolveDarkWebCharDisplayNameForApi(f) || '发帖人').trim() || '发帖人';
            var handle = defaultTwitterFriendHandle(f);
            parts.push(`---
【当前发帖角色】@${handle}
论坛显示名: ${authorName}
角色卡（仅供把握发帖人口吻；**禁止**把卡面原文搬进主楼/评论）:
${f.roleSetting || f.role || '无'}
`);
        } else {
            parts.push('---\n【当前发帖角色】未匹配到本地角色卡，请按地下论坛路人口吻生成，禁止生成外链头像。');
        }
        parts.push(`---
【机主身份】
角色卡昵称（机主）: ${nickname}
限制: 若机主本人在详情页中被提及，只能使用该昵称；若写到机主本人正文，必须使用第一人称；任何位置都禁止出现“Char”“User”“{{char}}”“{{user}}”。
`);
        parts.push(`---
【场景】
1. 这里只生成单帖相关 HTML，不生成整页时间轴、规则卡、侧栏、设置页。
2. 若主帖是机主本人写的，主帖正文必须是第一人称。
3. ${sectionName ? '用户从「' + sectionName + '」板块进入本帖，语气须与该板块气质一致（风向偏八卦传闻；深海偏权限情报且**禁止八卦**；清扫偏任务黑话且**绝对禁止八卦**）。' : '用户从论坛首页热帖进入，语气可略混合，但仍须保持地下论坛底色。'}
4. 若机主本人被提及，只能写作“${nickname}”。
5. 主楼扩写须**原创**，不得把世界书/角色档案/私聊内容改写成正文。
`);
        return { parts: parts, nickname: nickname, sectionName: sectionName };
    }

    /** 只生成主楼（长正文、标题等），不生成任何评论区。 */
    function buildDarkWebDetailMainSendContent(payload, options) {
        if (!payload) return null;
        var ctx = buildDarkWebDetailSharedPreamble(this, payload);
        if (!ctx) return null;
        var parts = ctx.parts;
        var nickname = ctx.nickname;
        var clickedIdx = options && options.clickedIndex != null ? options.clickedIndex : '';
        parts.push(`---
【本次任务 · 主楼 only】
仅输出**一条主楼**的 HTML：完整展开原帖，把列表摘要扩写为完整主文（可多条 \`<p>\`），**禁止**出现任何回帖、回复区、评论区、楼中楼、评论列表。禁止输出「全部回复」等评论区标题。
**禁止**把世界书原文、角色档案段落或私聊原句扩写进主楼；须写成论坛用户自然发帖口吻。

【主题快照】
主题标题: ${String(payload.threadTitle || '').trim() || '（请结合下列摘要自拟主楼标题，可与列表略作润色）'}
显示名: ${payload.displayName || '未知'}
@handle: ${payload.handle || ''}
时间: ${payload.time || ''}
用户点击的列表项序号（参考）: ${String(clickedIdx)}
列表摘要（须扩写为完整主楼）:
${payload.textHtml || ''}

【主楼 HTML 结构约束】
1. 最外层**必须**是 \`<div class="twitter-x-detail-root friend-darkweb-detail-main">\`。
2. 内层主帖**必须**是 \`<article class="tweet friend-darkweb-thread friend-darkweb-detail-op">\`（可含 \`header.tweet-header\`、\`h3.friend-darkweb-thread-title\`、\`div.tweet-text\` 等）。
3. 正文为简体中文，自动换行靠 CSS；不要在正文中使用 \`white-space: pre\`。
4. 禁止 \`<img\` 使用 http(s) 外链；头像仅用首字色块类名，与现有一致即可。
5. 任何位置不要出现 “Char”“User”“{{char}}”“{{user}}”。
`);
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);
        return redactDataImageUrlsForApiPrompt(parts.join('\n')) + '\n\n---\n【头像】禁止 HTML 中出现 http(s) 外链图片；头像仅用首字占位。';
    }

    /**
     * 只生成评论区（8～12 条顶层，可楼中楼、口水战）HTML 片段，依赖主楼内容。
     * options.mainBodyHtml 或 mainBodyPlain：主楼已渲染后的文本上下文。
     */
    function buildDarkWebDetailCommentsSendContent(payload, options) {
        if (!payload) return null;
        var mainBodyHtml = (options && options.mainBodyHtml) ? String(options.mainBodyHtml) : '';
        var mainBodyPlain = (options && options.mainBodyPlain) ? String(options.mainBodyPlain) : '';
        if (!mainBodyHtml && !mainBodyPlain) return null;
        var ctx = buildDarkWebDetailSharedPreamble(this, payload);
        if (!ctx) return null;
        var parts = ctx.parts;
        var nickname = ctx.nickname;
        var clickedIdx = options && options.clickedIndex != null ? options.clickedIndex : '';
        var floorMin = 8;
        var floorMax = 12;
        var nFloors = floorMin + Math.floor(Math.random() * (floorMax - floorMin + 1));
        parts.push(`---
【本次任务 · 评论区 only】
**禁止**再写主楼、主帖标题、主贴正文。只根据下方【主楼全文及快照】生成**回帖/回复区**。

【数量与结构】
1. 生成 **${nFloors}** 条**顶层**评论「楼」。**楼中楼（嵌套回帖）**：不强制每条顶层都带；**若某条顶层下出现楼中楼，则该顶层下子楼（所有 data-depth>0 的 \`article.friend-darkweb-cfloor\`）合计必须为 1～3 条**（可单链 1→2→3 或同层多挂，**总数勿超 3**）。要有人抬杠、阴阳怪气、互怼等「口水战」张力，但勿涉现实可操作违法细节。
2. 参与者可为：显示昵称的路人、**匿名**（标注为 \`span.friend-darkweb-anon\` 或文内「匿名用户」+ 灰色代号）、情报贩子、佣兵、围观者、与主楼观点对立者等。
3. 每条层必须带：**昵称或匿名**、**时间戳**（相对或简短时间均可，用 \`span.friend-darkweb-c-time\` 或 \`time\`）、**正文**。
4. 每条层须有互动数（可用纯文本 span）：**点赞、点踩**（数字随机但合理，类名用 \`friend-darkweb-c-up\`、\`friend-darkweb-c-down\` 以便前端样式；勿用可点击脚本）。
5. 各楼之间语气、立场须明显不同；允许引用、@、反驳上一层。

【每条正文字数（必须遵守）】
1. **顶层评论与楼中楼回帖**中，\`div.friend-darkweb-c-body\` 内可见正文（去标签后的纯文字）**长度**均为 **不少于 30 字、不多于 250 字**（按可见汉字/字符计，标点可算在内；HTML 标签不算字数）。
2. 允许**简短**发话，但**不得短于 30 字**；也**不要灌水凑极长**超过 250 字。**楼中楼每条**同样 **30～250 字**。

【主题与主楼（生成评论时必须围绕这些内容）】
主题标题: ${String(payload.threadTitle || '').trim()}
原列表发帖显示名: ${payload.displayName || '未知'}
@handle: ${payload.handle || ''}
列表原摘要 HTML（参考）:
${payload.textHtml || ''}
用户点击的列表项序号: ${String(clickedIdx)}

【主楼已渲染·纯文本缩略（优先据此理解论战焦点）】
${mainBodyPlain ? mainBodyPlain.slice(0, 4800) : '（无）'}

【主楼已渲染·HTML（保留标签便于对照引用，勿照抄为评论）】
${mainBodyHtml.slice(0, 8000)}

【评论区 HTML 输出约束】
1. 仅输出**一段**可插入 \`#friend-darkweb-comments-list\` 容器的 **内部** HTML，**不要**再包一层 \`twitter-x-detail-root\`。
2. 外层**必须**以 \`<div class="friend-darkweb-comments-list-inner">\` 开头并以对应 \`</div>\` 结束。
3. 每一条顶层评论**必须**用 \`<article class="friend-darkweb-cfloor" data-depth="0">\`；楼中楼用 \`data-depth="1"\`～\`"3"\` 嵌套在上一层内的 \`<div class="friend-darkweb-cfloor-children">\` 中，且**单条顶层下子楼总条数 1～3**（与上文【数量与结构】一致）。
4. 单楼内部建议结构：\`header.friend-darkweb-cfloor-head\`（\`span.friend-darkweb-c-name\`、可选 \`span.friend-darkweb-anon\`、\`span.friend-darkweb-c-time\`） + \`div.friend-darkweb-c-body\` + \`div.friend-darkweb-c-votes\`（点赞/点踩数字）。
5. 允许混用与推特兼容的 \`tweet-reply\` 类在单条上**附加**，但**必须**保留上述 \`friend-darkweb-cfloor\` 与 \`data-depth\` 以便缩进，禁止整段只输出无结构的纯文本块。
6. 简体中文。禁止 “Char”“User”“{{char}}”“{{user}}”。若机主被提及，只能写作 “${nickname}”。
7. 禁止 \`<img\` 外链。禁止规则卡/侧栏/主楼重复输出。
`);
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);
        return redactDataImageUrlsForApiPrompt(parts.join('\n')) + '\n\n---\n【头像】禁止 HTML 中出现 http(s) 外链图片。';
    }

    /**
     * 暗网论坛详情：主楼 + 评论区 **一次 API** 输出。前端用固定 class 拆成两段插入。
     * 最外层：.friend-darkweb-detail-api-wrap > .friend-darkweb-detail-api-main + .friend-darkweb-detail-api-comments
     */
    function buildDarkWebDetailFullPageSendContent(payload, options) {
        if (!payload) return null;
        var ctx = buildDarkWebDetailSharedPreamble(this, payload);
        if (!ctx) return null;
        var parts = ctx.parts;
        var nickname = ctx.nickname;
        var clickedIdx = options && options.clickedIndex != null ? options.clickedIndex : '';
        var floorMin = 8;
        var floorMax = 12;
        var nFloors = floorMin + Math.floor(Math.random() * (floorMax - floorMin + 1));
        parts.push('---');
        parts.push('【本次任务 · 主楼 + 评论区 一次完成】');
        parts.push('你必须在**同一次回复**中同时生成**主楼**与**回帖区**，只调用这一段输出即可。');
        parts.push('**严禁** 使用 markdown 代码围栏（禁止三个反引号、禁止 ` ```html ` 等形式）、禁止「以下 HTML」「如下」等前言；**输出必须以 `<` 开头**（可省略 XML 声明与 DOCTYPE）。');
        parts.push('**严禁** 在正文中出现三个连续反引号 ` ` ` 或 fence 字符。');
        parts.push('');
        parts.push('【整体 HTML 根结构 — 必须严格遵守】');
        parts.push('1. 最外层有且仅有一个根节点：`<div class="friend-darkweb-detail-api-wrap">`');
        parts.push('2. 其下**第一个**子节点必须是：`<div class="friend-darkweb-detail-api-main">`，内放主楼（见下【主楼】）。');
        parts.push('3. 其下**第二个**子节点必须是：`<div class="friend-darkweb-detail-api-comments">`，其内再包一层 `<div class="friend-darkweb-comments-list-inner">`（内放所有楼层评论，见下【评论区】）。');
        parts.push('4. 除上述根结构外，不要额外套一层 id="friend-darkweb-wrap" 或整页时间轴。');
        parts.push('');
        parts.push('【主题快照】');
        parts.push('主题标题: ' + (String(payload.threadTitle || '').trim() || '（可结合下列摘要自拟主楼标题，可与列表略作润色）'));
        parts.push('显示名: ' + (payload.displayName || '未知'));
        parts.push('@handle: ' + (payload.handle || ''));
        parts.push('时间: ' + (payload.time || ''));
        parts.push('用户点击的列表项序号（参考）: ' + String(clickedIdx));
        parts.push('列表摘要（主楼须扩写为完整长文，评论区须围绕其论战）:');
        parts.push(String(payload.textHtml || ''));
        parts.push('');
        parts.push('【主楼】放在 .friend-darkweb-detail-api-main 内');
        parts.push('1. 该层内**最外**的帖子容器必须是：`<div class="twitter-x-detail-root friend-darkweb-detail-main">`。');
        parts.push('2. 主帖**必须**是 `<article class="tweet friend-darkweb-thread friend-darkweb-detail-op">`（可含 header.tweet-header、h3.friend-darkweb-thread-title、div.tweet-text 等）。把列表摘要扩写为完整主文（可多条 <p>），**本 div 内禁止**再出现回帖/评论区/楼中楼/「全部回复」标题。**禁止**把世界书/角色档案/私聊原文扩写进主楼。');
        parts.push('3. 正文为简体中文。不要在正文中使用 white-space: pre。');
        parts.push('4. 禁止 <img 使用 http(s) 外链；头像仅用首字色块类名。');
        parts.push('');
        parts.push('【评论区】放在 .friend-darkweb-comments-list-inner 内（不要重复写主楼）');
        parts.push('1. 生成 **' + nFloors + '** 条**顶层**评论「楼」。**楼中楼**：不强制每条顶层都带；若某顶层下出现楼中楼，则该顶层下**子楼合计 1～3 条**（所有 data-depth>0 的 article 数），要有抬杠、阴阳、互怼等张力，勿涉现实可操作违法细节。');
        parts.push('2. 参与者可为路人、匿名（span.friend-darkweb-anon 等）、情报贩子、佣兵、围观者、与主楼对立者等。');
        parts.push('3. 每条顶层评论必须用 `<article class="friend-darkweb-cfloor" data-depth="0">`；楼中楼用 data-depth="1"～"3" 嵌于上一层内 `<div class="friend-darkweb-cfloor-children">`（**单条顶层下子楼 1～3 条**）。');
        parts.push('4. 每条带：昵称或匿名、时间（span.friend-darkweb-c-time 或 time）、正文；并带点赞/点踩数字（类名 friend-darkweb-c-up、friend-darkweb-c-down）。');
        parts.push('5. 单楼建议：header.friend-darkweb-cfloor-head + div.friend-darkweb-c-body + div.friend-darkweb-c-votes。');
        parts.push('6. **正文字数**：顶层与**每条楼中楼**的 `div.friend-darkweb-c-body` 内可见文字均 **30～250 字**（不得短于 30 字、不得超过 250 字）。');
        parts.push('7. 禁止 <img 外链。禁止再输出整段主楼或「全部回复」大标题在评论列表外重复。若需小标题，仅用容器内极短说明即可。');
        parts.push('8. 简体中文。若机主被提及，只能写作「' + nickname + '」。');
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);
        return redactDataImageUrlsForApiPrompt(parts.join('\n')) + '\n\n---\n【头像】禁止 HTML 中出现 http(s) 外链图片；禁止任何代码围栏。';
    }

    /** 详情进页：与「主楼+评论一次出」同义（旧名保留）。 */
    function buildDarkWebDetailPageSendContent(payload, options) {
        return buildDarkWebDetailFullPageSendContent.call(this, payload, options);
    }

    function buildTwitterSendContent(feedKind) {
        const kind = feedKind || 'forYou';
        let friends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
        if (kind === 'following') {
            friends = getFriendsForTwitterFollowingFeed();
        } else if (kind === 'forYou') {
            friends = twitterSampleFriendsForForYouFeed(friends);
        }
        if (kind === 'following' && friends.length === 0) return null;

        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);

        const parts = [];

        // ① 系统核心指令
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));

        // ② 世界书（好友关联；仅世界观和角色塑造相关，过滤中英对照/功能性/私密动态类条目）
        const wbBlock = buildTwitterWorldBooksBlockFromFriends(friends);
        if (wbBlock) parts.push(wbBlock);
        parts.push(TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE);

        // ─── 以下为娱乐版专用结构 ───
        const isEntertainment = (kind === 'entertainment');

        if (isEntertainment) {
            // ③ 好友角色卡信息 + 用户角色卡信息
            friends.forEach(f => {
                const displayName = (f.remark || f.nickname || '好友').trim() || '好友';
                const twAuthorName = (twitterResolveFriendAuthorDisplayName(f) || displayName).trim();
                const handle = defaultTwitterFriendHandle(f);
                parts.push(`---
【好友 ${displayName}】@${handle}
推特顶栏显示名（须原样写入 HTML 加粗显示名，与角色卡语言一致，禁止译成中文）: ${twAuthorName}
角色卡:
${f.roleSetting || f.role || '无'}
`);
            });

            // 用户角色卡信息
            const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role))
                ? String(myProfile.roleSetting || myProfile.role).trim() : '';
            parts.push(`---
【用户角色卡 / User】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

            // ④ 好友及用户的聊天消息记录（每位好友仅最新若干轮，见 TWITTER_API_CHAT_HISTORY_MAX_ROUNDS）
            friends.forEach(f => {
                const displayName = (f.remark || f.nickname || '好友').trim() || '好友';
                const handle = defaultTwitterFriendHandle(f);
                const hist = _buildTwitterChatHistoryLines(f.id, TWITTER_API_CHAT_HISTORY_MAX_ROUNDS, fmt);
                parts.push(`---
【${displayName}】@${handle} 与用户的最近聊天记录（表情已脱敏为名称）:
${hist || '（暂无聊天记录）'}
`);
            });

            // ⑤ 娱乐版输出内容要求（时间轴仅主帖，避免一次生成过量 HTML 导致上游 524 超时）
            const feedHints = {
                entertainment: `【当前 X 时间轴 · 娱乐】
本板块核心：聚焦 {{user}} 与 {{char}}（当前好友）之间的关系动态。
【发帖人】禁止 {{user}} 或 {{char}} 本人作主帖发帖人；须为好友关系网 NPC、路人或第三方。禁止用微信群名充当账号。
【内容主题】在 6～8 条主帖中尽量覆盖多样话题：关系被曝光、暗示、礼物线索、被撞见、截图转发、深夜上线猜测、投票帖（文字选项）、八卦讨论、爆料叙事、热评氛围等（不必每条都写满，可合并体现）。
【形式】可混用：主帖 + 匿名树洞口吻、投票（选项用文字列出）、老帖翻新引用、中等长度叙事（单帖正文建议 80～220 字，避免单帖过长）。
【时间轴结构 · 必守】每条 <div class="tweet"> 主帖块：左 48px 首字圆头像占位 + 右侧显示名/@handle/时间 + 正文 + 底部互动行（💬 评论数、转发、点赞、浏览可写**虚构数字**营造热度）。**时间轴仅展示主帖，不含评论**；点击主帖进入详情页后方有评论区。
【显示名】顶栏加粗显示名优先卡面原文；正文中文。
【头像】禁止 http(s) 外链图；首字占位，客户端按 @handle 注入。
【数量】**共 6～8 条主帖**（优先 8 条以内以控制耗时）。`
            };
            parts.push(`---\n${feedHints.entertainment}`);

            parts.push(`---
【娱乐时间轴 · 本次生成硬约束】
以上若与本地「推特规范④」或其它说明冲突，以本条为准：① 时间轴仅输出主帖 HTML（无评论）；② 共 6～8 条主帖；③ 互动行只用数字，不写评论正文。`);

            appendTwitterEntertainmentRulesOnly(parts);

            parts.push(twitterUserNpcIdentityHardRule(getEffectiveTwitterUserHandle(loadTwitterProfile() || {})));

            // 语言硬规则
            parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);

            const redacted = redactDataImageUrlsForApiPrompt(parts.join('\n'));
            return redacted + '\n\n---\n【头像 · 必守】禁止 HTML 中 http(s) 外链图；头像仅首字色块占位，客户端按 @handle 注入。\n【输出形态 · 必守】只输出 HTML 推文（含 class="tweet"），禁止 CSS 样式表、禁止 .class{} 规则块、禁止 <style> 标签。';
        }

        // ─── 以下为关注版 / 推荐版（原结构） ───

        // ③ 用户角色卡（全局）
        const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role)) ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push(`---
【用户角色卡 / User】（所有推文涉及用户时须与此一致）
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

        const chatRoundsForThisFeed =
            kind === 'forYou' ? TWITTER_FOR_YOU_CHAT_ROUNDS : TWITTER_API_CHAT_HISTORY_MAX_ROUNDS;

        if (kind === 'forYou') {
            if (friends.length > 0) {
                parts.push(`---
【推荐流 · 好友抽样】本次仅注入 **${friends.length}** 位本地好友（自全列表随机 1～3 人）的角色卡与私聊；**未出现在下文「好友」段落的本地好友一律视为未提供**，不得将其写成发帖人或引用其私聊。`);
            } else {
                parts.push(`---
【推荐流 · 好友抽样】当前无可用好友上下文；时间轴须以**纯虚构路人 NPC** 填满主帖数量要求；「卡面关系网」类约束见下方任务说明中的无卡兜底条款。`);
            }
        }

        // ④ 各好友角色卡 + 与该好友最近完整聊天（推荐流仅上文抽样好友；私聊轮数见 chatRoundsForThisFeed）
        friends.forEach(f => {
            const displayName = (f.remark || f.nickname || '好友').trim() || '好友';
            const twAuthorName = (twitterResolveFriendAuthorDisplayName(f) || displayName).trim();
            const handle = defaultTwitterFriendHandle(f);
            const persona = f.persona || myProfile;
            const hist = _buildTwitterChatHistoryLines(f.id, chatRoundsForThisFeed, fmt);
            parts.push(`---
【好友 ${displayName}】@${handle}（HTML 中发帖人 @ 必须与此一致）
推特顶栏显示名（须原样写入 HTML 加粗显示名，与角色卡语言一致，禁止译成中文）: ${twAuthorName}
角色卡:
${f.roleSetting || f.role || '无'}

该好友私聊中所用的用户人设（若与上方全局 User 不一致，理解二人关系时以本段为准）:
昵称: ${persona?.nickname || myProfile?.nickname || '未设置'}
身份: ${persona?.identity || myProfile?.identity || '未设置'}

双方最近完整聊天（用户↔该好友；**仅含最新 ${chatRoundsForThisFeed} 轮**完整来回；表情已脱敏为名称）:
${hist}

【头像】该好友推文头像**仅**使用本地好友资料中**角色卡上传的 avatar 图片**（客户端按 @handle 注入）；**禁止**在 HTML 中写 http(s) 外链图、网图或虚构 URL；模型侧仅用首字色块占位即可，**不得**用随机图片。
`);
        });

        // ⑤ App 内「我的」推特资料（@mention 等）
        const twProfile = loadTwitterProfile() || {};
        const userTwHandle = getEffectiveTwitterUserHandle(twProfile);
        let twAvatar = (twProfile.avatarDataUrl && String(twProfile.avatarDataUrl).trim()) || '';
        let twBanner = (twProfile.bannerDataUrl && String(twProfile.bannerDataUrl).trim()) || '';
        try {
            if (!twAvatar) twAvatar = localStorage.getItem('userAvatar') || '';
            if (!twBanner) twBanner = localStorage.getItem('backgroundImage') || '';
        } catch (e) {}
        parts.push(`---
【当前用户 · 推特个人资料】（@mention、需要时参考）
显示名称: ${twProfile.displayName || myProfile?.nickname || '用户'}
@handle: @${userTwHandle}
个人简介: ${twProfile.bio || '暂无简介'}
【@mention 硬规则】正文、回复、引用中若提及当前用户，必须使用 @${userTwHandle}；禁止使用字面量 @user。好友账号须与下文各 @ 一致。
${twAvatar ? `（用户推特头像 data URL 可能在下文被系统省略，不要在 HTML 里臆造外链图）` : ''}
${twBanner ? `用户推特背景图（仅供参考）:\n${twBanner}` : ''}
`);

        // ⑥ 本次时间轴任务说明
        const feedHints = {
            following: `【当前 X 时间轴 · 关注】\n上文「好友」仅含用户在推特个人主页「正在关注」中**勾选**的好友；请为这些好友各生成 1 条主帖（最多 4 帖）。**时间轴仅展示主帖，禁止内嵌任何 .tweet-reply 评论区**（用户点进详情页才看评论）。\n【版式·禁止二级导航】**禁止**输出「为你推荐」「正在关注」或任何子 Tab、分段按钮、重复顶栏；本页已有 App 顶部的「关注/推荐/娱乐」，你只需**直接输出多条主帖 HTML**。\n【严禁混用世界书 UI】即使上文世界书含「看你动态」「私密动态」「密友」等 HTML 示例，**本条输出仍必须是推特时间轴主帖 HTML**（与「推特规范①」一致），不得输出故事卡、单页居中私密动态、emoji 火焰环头像等非推特结构。\n【显示名】每位好友帖文顶栏加粗显示名须与上文「推特顶栏显示名」原文一致（英/德/中等），正文仍为中文。\n【@handle】主帖作者栏 @ 须与上文「好友」段给出的 @ 一致（如 Lego_数字ID），**禁止**自拟 Ghost_141 等代号式 @。\n【头像】左侧 48px 圆底**首字占位**；真实头像由客户端从**角色卡 avatar** 注入；**禁止** \`<img src="http…">\` 及任何外链图。\n【身份】不得用微信群名充当发帖人；路人 @ 不得与好友 @ 重复。\n【{{user}}】禁止 {{user}} 作为评论人或主帖发帖人；正文可 @mention User；关系网 NPC **不是** User。`,
            forYou:
                `【当前 X 时间轴 · 推荐】\n` +
                `【主帖数量】须输出 **≥12** 条互不相同的主帖（每条 \`<div class="tweet">\`）；**时间轴仅主帖，禁止内嵌 .tweet-reply 评论区**。\n` +
                `【上文边界】仅**本次抽样好友**（至多 3 人）的角色卡可用于解读「关系网 / 社交圈 / 人际关系 / 合作方 / 亲友们」等字段；未抽样好友**不得**当作发帖人。\n` +
                `【身份配比｜必守】\n` +
                `① **卡面关系侧（约 30% 主帖）**：仅从**上述抽样好友**角色卡已写明的字段中，抽取助理、化妆师、发型师、经纪人、艺人、演员、歌手、家人、朋友、同事、上司、下属、闺蜜、对手、品牌方、记者、粉丝等**具名关系人**；此类账号发的主帖合计约占全部主帖的 **三成**（例：12 条里约 3～4 条），且其中须出现 **至少 3 个不同发帖账号**（不同人物）。勿为「关系网」每人强占一帖导致占比失控。**这些 NPC 均不是 {{user}}**。\n` +
                `② **纯路人 NPC（约 70% 主帖）**：须由与卡面**无绑定**的虚构陌生人发帖；自行设计显示名与 @handle，不得与真实好友 @、亦不得与①中已采用人物重复。\n` +
                `③ **无卡/字段空**：若无法从卡面抽出足够关系人，则① 类由你**原创**与语境相符的圈内 NPC 凑满「约三成 + 至少三个不同 @」，② 类仍为纯路人；总数仍须 ≥12 条。\n` +
                `【版式】禁止二级 Tab/重复顶栏；具体 HTML 骨架以「推特规范③ · 推荐板块」为准。\n` +
                `【显示名】① 类人名须与卡面原文一致；路人可拉丁字母风格。正文与时间为中文叙述。\n` +
                `【好友本人】允许以被 @/被提及出现；不宜用好友本人作主帖主力刷屏。\n` +
                `【身份】禁止用微信群名充当账号；@ 不得冲突。\n` +
                `【{{user}}】禁止 {{user}} 作为评论人或主帖发帖人；NPC 可提及或猜测用户与好友关系，但**不得把 NPC 当成 User 本人**。`
        };
        parts.push(`---\n${feedHints[kind] || feedHints.forYou}`);

        parts.push(twitterUserNpcIdentityHardRule(userTwHandle));

        // ⑦ 系统推特规则（按 Tab 只注入对应规范，避免 ①～④ 重复堆叠）
        appendTwitterSystemRuleCommandsForTwitter(parts, kind === 'forYou' || kind === 'following' ? kind : 'all');

        // ⑧ 语言硬规则（仅推特任务）
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);

        const redacted = redactDataImageUrlsForApiPrompt(parts.join('\n'));
        if (kind === 'following') {
            return redacted + '\n\n---\n【头像 · 必守】好友头像 data URL 已在发往模型前省略。**禁止**在 HTML 中写任何虚构 http(s) 图片链接；左侧仅用首字+色块占位，客户端按 @handle 注入本地头像。\n【输出形态 · 必守】只输出 HTML 推文（含 class="tweet"），禁止 CSS 样式表、禁止 .class{} 规则块、禁止 <style> 标签。';
        }
        return redacted + '\n\n---\n【头像 · 必守】**禁止**在 HTML 中使用 http(s) 外链 \`<img>\`（易超时失败）；头像列仅用首字圆底，系统按 @handle 注入本地角色卡图（推荐流中匹配到好友 @ 时同样生效）。\n【输出形态 · 必守】只输出 HTML 推文（含 class="tweet"），禁止 CSS 样式表、禁止 .class{} 规则块、禁止 <style> 标签。';
    }
    /**
     * 单条推文详情页
     * 顺序：①核心指令 ②世界书 ③好友角色卡+用户角色卡 ④聊天记录 ⑤详情页输出内容要求
     */
    function buildTwitterDetailPageSendContent(payload) {
        if (!payload) return null;

        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);

        const parts = [];

        // ① 系统核心指令
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));

        // ② 世界书（仅世界观和角色塑造相关，过滤中英对照/功能性/私密动态类）
        if (payload.friend) {
            const wbBlock = buildTwitterWorldBooksBlockFromFriends([payload.friend]);
            if (wbBlock) parts.push(wbBlock);
        }
        parts.push(TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE);

        // ③ 好友角色卡信息 + 用户角色卡信息
        if (payload.friend) {
            const f = payload.friend;
            const displayName = ((f.remark || f.nickname || '好友').trim() || '好友');
            const twAuthorName = (twitterResolveFriendAuthorDisplayName(f) || displayName).trim();
            const handle = defaultTwitterFriendHandle(f);
            parts.push(`---
【好友 ${displayName}】@${handle}
推特顶栏显示名（须与 HTML 一致、角色卡原文语言）: ${twAuthorName}
角色卡:
${f.roleSetting || f.role || '无'}
`);
        } else {
            parts.push(`---
【发帖人】未能匹配本地好友，无角色卡。请据主帖文本生成合理的路人 NPC 与评论；禁止 http(s) 外链头像图。`);
        }

        const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role)) ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push(`---
【用户角色卡 / User】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

        // ④ 好友及用户的聊天消息记录（轮数上限见 TWITTER_API_CHAT_HISTORY_MAX_ROUNDS）
        if (payload.friend) {
            const f = payload.friend;
            const displayName = ((f.remark || f.nickname || '好友').trim() || '好友');
            const handle = defaultTwitterFriendHandle(f);
            const hist = _buildTwitterChatHistoryLines(f.id, TWITTER_API_CHAT_HISTORY_MAX_ROUNDS, fmt);
            parts.push(`---
【${displayName}】@${handle} 与用户的最近聊天记录（表情已脱敏为名称）:
${hist || '（暂无聊天记录）'}
`);
        }

        // ⑤ 详情页输出内容要求
        const twP0 = loadTwitterProfile() || {};
        const userAt0 = getEffectiveTwitterUserHandle(twP0);
        parts.push(`---
【本次任务 · X 单帖详情页】
用户从时间轴点开**一条**主帖。请只输出**这一帖**的详情页 HTML：主帖完整展示 + 下方回复列表（**≥6 条评论**）。不要输出整条时间轴、不要输出其他帖。
版式对标 X 帖内页；浅色：底 #E7E8EA，主字 #0f1419，次要 #536471，强调 #1d9bf0，分割 #cdd0d4。
仅输出一段可直接 document.innerHTML 的 HTML，禁止 markdown 围栏、禁止 JSON、禁止前言后语。
建议外层使用 class "twitter-x-detail-root"，主帖 article.tweet，回复区用 .tweet-reply 或 .twitter-x-reply（padding-left:60px）。

【HTML 骨架 · 客户端解析依赖｜必守】
1) 在 twitter-x-detail-root 内，先有且仅有一条「主帖」：任意带 class="tweet" 的元素（可用 <article class="tweet">）。
2) 主帖之后、同层级的**下一个兄弟节点**起，必须是评论区（可再包一层 div.section，class 名随意），内含 ≥6 条评论行；每条评论行**必须**带 class="tweet-reply" 或 class="twitter-x-reply"（或同时含两 class），并带 padding-left:60px（或与时间轴评论行一致的 flex+缩进）。
3) **禁止**把 NPC 评论只写在主帖容器内部却不写上述 class——否则客户端无法识别；也禁止输出「第二条主帖」冒充评论（不要用第二个 class="tweet" 当评论）。
4) 若用容器包裹全部评论，容器与主帖须为**兄弟关系**（sibling），不要嵌套在主帖 .tweet 内部又不用 .tweet-reply，以免被遗漏。

【评论区 · 严禁代用户发言｜最高优先级】
App 内当前用户的推特账号为 @${userAt0}。**禁止**在预生成的 HTML 中出现任何一条评论或回复，其作者为「当前用户本人」——即**禁止**在评论者/回复者栏使用 @${userAt0}、禁止字面量 @user、禁止用「用户」「我（用户视角）」作为评论发帖人。**禁止**替 {{user}} 写评论或回复。**用户只会在 App 内亲自输入留言**，模型不得预演用户说了什么。
预生成评论区仅可出现：① 主帖发帖人（好友 {{char}}）；② 角色卡社交圈 NPC；③ 与主帖相关之路人。**须生成 ≥6 条评论**，禁止空评论区。评论者禁止为 {{user}}。

【点开推文 · 快照】
显示名: ${payload.displayName || '未知'}
@handle: ${payload.handle || ''}
时间: ${payload.time || ''}
主帖正文（须保持事实一致，可套入规范中的 article 结构）:
${payload.textHtml || ''}

主帖 DOM 截断参考（仅供对齐字段，勿输出说明）:
${payload.structureHint || ''}

【@mention】主帖正文或 NPC 评论中若提及当前用户，须写 @${userAt0}，禁止写 @user。（此规则不授权你把用户写成评论发帖人。）
`);

        appendTwitterSystemRuleCommandsForTwitter(parts, 'detail');
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);

        return redactDataImageUrlsForApiPrompt(parts.join('\n')) + '\n\n---\n【头像 · 必守】详情页同样禁止 HTML 中写 http(s) 外链图片；头像用首字占位，客户端按 @handle 注入。';
    }
    /**
     * 用户在推文详情页留言后：仅生成「好友（发帖人）」对用户留言的一条回复 HTML。
     * 顺序：核心指令 → 世界书(过滤) → 用户卡+好友卡 → 最新若干轮微信（见 TWITTER_API_CHAT_HISTORY_MAX_ROUNDS）→ 推文摘录+用户留言。
     */
    function buildTwitterFriendReplyToUserCommentSendContent(friend, options) {
        if (!friend || friend.isGroup) return null;
        const opts = options || {};
        const tweetPlain = String(opts.tweetPlainText || '').trim();
        const userLine = String(opts.userCommentText || '').trim();
        if (!userLine) return null;

        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);

        const parts = [];
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));

        const wbBlock = buildTwitterWorldBooksBlockFromFriends([friend]);
        if (wbBlock) parts.push(wbBlock);
        parts.push(TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE);

        const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role)) ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push(`---
【用户角色卡 / User】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const twAuthorName = (twitterResolveFriendAuthorDisplayName(friend) || displayName).trim();
        const handle = defaultTwitterFriendHandle(friend);
        const handleBare = String(handle).replace(/^@/, '');
        const persona = friend.persona || myProfile;
        const hist = _buildTwitterChatHistoryLines(friend.id, TWITTER_API_CHAT_HISTORY_MAX_ROUNDS, fmt);
        parts.push(`---
【好友 · 发帖人 / {{char}}】friendId: ${String(friend.id)}
推特顶栏显示名（回复行须一致）: ${twAuthorName}
帖文 @ 须为: @${handleBare}

角色卡:
${friend.roleSetting || friend.role || '无'}

该好友私聊中的用户人设:
昵称: ${persona?.nickname || myProfile?.nickname || '未设置'}
身份: ${persona?.identity || myProfile?.identity || '未设置'}

双方最近微信聊天（表情已脱敏；**仅含最新 ${TWITTER_API_CHAT_HISTORY_MAX_ROUNDS} 轮**完整来回）:
${hist}
`);

        const parentHint = String(opts.replyParentHint || '').trim();
        parts.push(`---
【本次任务 · 仅一条：好友回复用户留言】
场景：用户在 App 内查看了该好友发布的推文，并**亲自输入**了一条留言（见下）。你的任务是：**仅以好友（{{char}}）的口吻**，写**一条**回复，回应用户的这条留言。

【严禁】代用户续写、替用户发言、重复用户原话充数；不要生成用户侧对话；不要输出 JSON 或 markdown 围栏。

【推文正文摘录】
${tweetPlain || '（无正文）'}

【用户刚发表的留言】
${userLine}
${parentHint ? `\n【回复上下文】用户是在回应：${parentHint}\n` : ''}

【输出格式】
仅输出**一段** HTML：单个外层 <div class="tweet-reply twitter-x-reply twitter-friend-reply-to-user">…</div>。
内部结构与推特时间轴评论行一致：左侧 36～40px 圆头像占位（仅首字或色块，禁止 http 图），右侧为加粗显示名「${twAuthorName}」、灰色 @${handleBare}、时间「刚刚」、下方一条简体中文回复正文（符合角色口吻）。
不要输出其它说明文字。`);

        const twPr = loadTwitterProfile() || {};
        const userAt = getEffectiveTwitterUserHandle(twPr);
        parts.push(`---
【@mention】若回复中提及用户，使用 @${userAt}，禁止 @user。`);

        appendTwitterSystemRuleCommandsForTwitter(parts, 'friendReply');
        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);

        return redactDataImageUrlsForApiPrompt(parts.join('\n')) + '\n\n---\n【头像 · 必守】禁止 HTML 中外链图片；头像占位由客户端注入。';
    }

    function buildTwitterUserPostCommentsSendContent(post) {
        if (!post) return null;
        const friends = loadFriendsFromStorage().filter(f => f && !f.blacklisted && !f.isGroup);
        if (!friends.length) return null;

        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);
        const twProfile = loadTwitterProfile() || {};
        const userAt = getEffectiveTwitterUserHandle(twProfile);
        const minCommenters = Math.min(3, friends.length);
        const maxCommenters = Math.min(Math.max(minCommenters, 6), friends.length);

        const parts = [];
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));

        const wbBlock = buildTwitterWorldBooksBlockFromFriends(friends);
        if (wbBlock) parts.push(wbBlock);
        parts.push(TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE);

        const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role)) ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push(`---
【用户角色卡 / User】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
推特账号: @${userAt}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

        friends.forEach(f => {
            const displayName = (f.remark || f.nickname || '好友').trim() || '好友';
            const twAuthorName = (twitterResolveFriendAuthorDisplayName(f) || displayName).trim();
            const handle = defaultTwitterFriendHandle(f);
            const persona = f.persona || myProfile;
            const hist = _buildTwitterChatHistoryLines(f.id, TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS, fmt);
            parts.push(`---
【好友 ${displayName}】friendId: ${String(f.id)}
推特顶栏显示名: ${twAuthorName}
推特账号: @${String(handle).replace(/^@/, '')}
角色卡:
${f.roleSetting || f.role || '无'}

该好友私聊中的用户人设:
昵称: ${persona?.nickname || myProfile?.nickname || '未设置'}
身份: ${persona?.identity || myProfile?.identity || '未设置'}

双方最近聊天（仅最新 ${TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS} 轮完整来回；表情已脱敏为名称）:
${hist || '（暂无聊天记录）'}
`);
        });

        parts.push(`---
【用户刚刚发布的推文】
发帖人: @${userAt}
正文:
${String(post.text || '').trim() || '（无正文）'}

【任务】
请从上文这些“好友”里，挑选至少 ${minCommenters} 位、至多 ${maxCommenters} 位好友，以他们各自的身份口吻对这条用户推文留言。
要求：
1. 每位入选好友只留言 1 条，friendId 不得重复。
2. 留言必须严格符合该好友角色卡、与用户关系和最近聊天语境，禁止 OOC。
3. 不要求全部好友都留言，但总人数必须 >= ${minCommenters}。
4. 留言内容须为自然的简体中文，像真实好友在推文下评论，单条建议 6～80 字。
5. 禁止把用户本人写成评论者；禁止虚构未提供的好友；禁止输出 HTML。
6. 世界书只用于世界观和角色演绎参考，禁止照抄其中任何 HTML/CSS/UI 结构。

【输出格式】
仅输出一个 JSON 对象，严格如下：
{
  "comments": [
    {
      "friendId": "字符串，必须来自上文好友",
      "authorName": "该好友显示名",
      "text": "留言正文"
    }
  ]
}
禁止 markdown 围栏、禁止前言后记、禁止输出 comments 以外字段。`);

        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);
        return redactDataImageUrlsForApiPrompt(parts.join('\n'));
    }

    function buildTwitterFriendReplyToUserOwnPostCommentSendContent(friend, options) {
        if (!friend || friend.isGroup) return null;
        const opts = options || {};
        const tweetPlain = String(opts.tweetPlainText || '').trim();
        const friendCommentText = String(opts.friendCommentText || '').trim();
        const userReplyText = String(opts.userReplyText || '').trim();
        if (!userReplyText) return null;

        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const c in emojiData) {
            allEmojis = allEmojis.concat(emojiData[c] || []);
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);

        const parts = [];
        this.getCoreCommands().forEach(cmd => parts.push(cmd.content));

        const wbBlock = buildTwitterWorldBooksBlockFromFriends([friend]);
        if (wbBlock) parts.push(wbBlock);
        parts.push(TWITTER_WORLDBOOK_OUTPUT_SCOPE_RULE);

        const userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role)) ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push(`---
【用户角色卡 / User】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充设定:\n${userRoleExtra}` : ''}
`);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const twAuthorName = (twitterResolveFriendAuthorDisplayName(friend) || displayName).trim();
        const handle = defaultTwitterFriendHandle(friend);
        const persona = friend.persona || myProfile;
        const hist = _buildTwitterChatHistoryLines(friend.id, TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS, fmt);
        parts.push(`---
【好友 / {{char}}】friendId: ${String(friend.id)}
推特顶栏显示名: ${twAuthorName}
推特账号: @${String(handle).replace(/^@/, '')}
角色卡:
${friend.roleSetting || friend.role || '无'}

该好友私聊中的用户人设:
昵称: ${persona?.nickname || myProfile?.nickname || '未设置'}
身份: ${persona?.identity || myProfile?.identity || '未设置'}

双方最近聊天（仅最新 ${TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS} 轮完整来回；表情已脱敏为名称）:
${hist || '（暂无聊天记录）'}
`);

        parts.push(`---
【场景】
用户发了一条推文；该好友先在推文下留了言，随后用户又回复了这条留言。现在请你仅以该好友（{{char}}）的口吻继续接话。

【用户推文正文】
${tweetPlain || '（无正文）'}

【该好友先前留言】
${friendCommentText || '（无）'}

【用户刚刚回复】
${userReplyText}

【任务要求】
1. 仅输出该好友的一条继续回复，纯文本，不要 HTML、不要 JSON。
2. 语气必须严格符合角色卡底色、与用户关系和最近聊天语境，禁止 OOC。
3. 不要替用户续写，不要复述用户原话充数，不要出现舞台说明。
4. 回复建议 5～60 字，口语化、自然，像真实推文评论区互动。`);

        parts.push(TWITTER_CHINESE_OUTPUT_HARD_RULE);
        return redactDataImageUrlsForApiPrompt(parts.join('\n'));
    }

    function bootstrapTwitterSystemCommands() {
        var KEY = 'systemCommands';
        var ID1 = 990101;
        var ID2 = 990102;
        var ID3 = 990103;
        var ID4 = 990104;
        try {
            var cmds = JSON.parse(localStorage.getItem(KEY) || '[]');
            function upsertSystemCommandById(cmdList, cmd) {
                var idx = cmdList.findIndex(function (c) { return c && c.id === cmd.id; });
                if (idx >= 0) cmdList[idx] = cmd;
                else cmdList.push(cmd);
            }
            upsertSystemCommandById(cmds, {
                        id: ID1,
                        name: '推特规范① · 关注板块',
                        content: [
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【推特规范① · 关注板块】',
                            '',
                            '【语言】',
                            '【语言·正文】',
                            '所有输出内容（正文、评论、互动区文案、时间说明等叙述文字）必须为**规范简体中文**。',
                            '【语言·显示名例外】顶栏加粗**显示名**（紧挨 @handle 前的那个）须与角色卡原文一致：英文名写英文、德文名写德文、中文名写中文，禁止翻译。',
                            '时间统一用「刚才」「10分钟前」「2小时前」「昨天」等相对表述。',
                            '禁止在正文中出现无意义的纯表情堆砌。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【任务·时间轴刷新】',
                            '生成「推特/X · 关注」页面的推文时间轴 HTML。',
                            '',
                            '每位已添加的好友（由下方角色卡提供）各发布 1 条主帖（总数不超过 4 帖）；',
                            '主帖下方可附 2～4 条简短回复（NPC 或角色卡社交圈成员）。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【资料来源】',
                            twitterSpecChatHistoryUnifiedBanner(),
                            '',
                            '严格遵守以下资料，不得脱离自行创作角色：',
                            '  ① 好友角色卡（nickname / remark / roleSetting）',
                            '  ② 好友与用户的新聊天记录（**数量同上：最新 ' + TWITTER_API_CHAT_HISTORY_MAX_ROUNDS + ' 轮完整来回**）',
                            '  ③ {{char}} = 好友（角色卡主体）；{{user}} = 用户（聊天记录中另一方）',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【HTML 结构规范】（必须严格遵守，否则页面无法正确渲染）',
                            '',
                            '页面底色统一为 #E7E8EA（手机浅灰背景）。',
                            '配色：主文字 #0f1419，次要灰 #536471，强调蓝 #1d9bf0，分割线 #eff3f4。',
                            '禁止深色主题。',
                            '',
                            '禁止输出「为你推荐」「正在关注」等二级 Tab 或重复顶栏（本应用顶部已有关注/推荐/娱乐）。',
                            '每条主帖外层使用 class="tweet"：',
                            '<div class="tweet">',
                            '  <div style="display:flex;gap:12px;align-items:flex-start;">',
                            '    <!-- 头像：必须用角色卡提供的头像 URL 的 <img>，禁止用 emoji/表情图代替 -->',
                            '    <div style="width:48px;height:48px;border-radius:50%;background:#1d9bf0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;font-weight:700;flex-shrink:0;">字</div>',
                            '    <div style="flex:1;min-width:0;">',
                            '      <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">',
                            '        <span style="font-weight:700;font-size:15px;color:#0f1419;">显示名</span>',
                            '        <span style="font-size:15px;color:#536471;">@handle</span>',
                            '        <span style="font-size:15px;color:#536471;">· 相对时间</span>',
                            '      </div>',
                            '      <div style="margin-top:4px;font-size:15px;line-height:1.5;color:#0f1419;">推文正文</div>',
                            '      <div style="margin-top:10px;display:flex;gap:20px;color:#536471;font-size:13px;">',
                            '        <span>💬 评论数</span>',
                            '        <span>🔄 转发数</span>',
                            '        <span>❤️ 点赞数</span>',
                            '        <span>👁 浏览数</span>',
                            '      </div>',
                            '    </div>',
                            '  </div>',
                            '  <!-- 回复（非必须，最多4条） -->',
                            '  <div style="margin-top:12px;padding-left:60px;">',
                            '    <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid #eff3f4;">',
                            '      <div style="width:36px;height:36px;border-radius:50%;background:#7856ff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0;">字</div>',
                            '      <div style="flex:1;min-width:0;">',
                            '        <div style="display:flex;align-items:center;gap:4px;">',
                            '          <span style="font-weight:700;font-size:14px;color:#0f1419;">评论者名</span>',
                            '          <span style="font-size:13px;color:#536471;">@handle · 1h</span>',
                            '        </div>',
                            '        <div style="margin-top:2px;font-size:14px;line-height:1.45;color:#0f1419;">评论内容</div>',
                            '      </div>',
                            '    </div>',
                            '  </div>',
                            '</div>',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【评论者身份规则】',
                            '  · 从角色卡中的「社交圈关系」抽取 NPC：助理、化妆师、经纪人、家人、同事、闺蜜、粉丝、对家粉等。',
                            '  · 角色卡中未写明关系人时，可自行虚拟中文姓名，但语气要像真实用户。',
                            '  · 评论语气必须符合评论者身份：助理敬语、粉丝激动、同事调侃、路人随意。',
                            '  · 禁止纯「哈哈 / 对对 / 好的」等无观点凑数句。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【好友本人回覆规则】',
                            '  · 好友（@handle 即角色卡主体）可在他人评论下回覆，回覆内容必须：',
                            '    ① 符合角色卡性格设定',
                            '    ② 与被回覆的评论内容强相关',
                            '    ③ 自然口语化，不要机械式回覆',
                            '    ④ 不主动提及「{{user}}」，除非聊天记录中有明确暗示',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【{{user}} 用户处理规则】',
                            '  · 允许 NPC 在评论中猜测、提及、调侃用户与好友的关系（不恶意、不露骨）。',
                            '  · {{user}} 本人不作为实际评论人出现（禁止让用户扮演自己发言）。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【禁止事项】',
                            '  · 不得出现任何人的真实姓名或敏感信息。',
                            '  · 不得生成令人不适的低俗内容。',
                            '  · 单条回复正文不超过 80 字。',
                            '  · 不得让 {{user}} 作为时间轴主帖发帖人（那是娱乐板块的事）。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【输出】',
                            '  · 仅输出可直接 document.innerHTML 的原始 HTML。',
                            '  · 禁止 markdown 围栏（```）、禁止 JSON、禁止前言后语。',
                            '  · 每位好友各 1 条主帖（最多 4 帖），回复总数不超过好友数×4 条。',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                        ].join('\n'),
                        createdAt: ID1,
                        active: true
                    });
            upsertSystemCommandById(cmds, {
                        id: ID2,
                        name: '推特规范② · 单帖评论详情',
                        content: [
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【推特规范② · 单帖评论详情页】',
                            '',
                            '【语言】',
                            '所有输出内容必须为中文。',
                            '时间统一用「刚才」「10分钟前」「1小时前」「昨天」等相对表述。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【任务】',
                            '用户点击「关注」时间轴中的某条主帖，生成该帖的评论详情页 HTML。',
                            '输出包含：完整主帖内容 + 评论区（不少于 8 条评论）。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【资料来源】',
                            twitterSpecChatHistoryUnifiedBanner(),
                            '',
                            '  ① 主帖内容（见下方推文快照，不得改动主帖语义）',
                            '  ② 主帖发帖人的角色卡',
                            '  ③ {{char}} = 主帖发帖人；{{user}} = 用户',
                            '  ④ 好友与用户的最新聊天记录（**数量同上：最新 ' + TWITTER_API_CHAT_HISTORY_MAX_ROUNDS + ' 轮完整来回**）',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【HTML 结构】',
                            '<div style="padding:0 16px 24px;">',
                            '  <!-- 主帖（与快照一致） -->',
                            '  <div class="tweet" style="background:#E7E8EA;padding:12px 0;border-bottom:1px solid #cdd0d4;">',
                            '    <!-- 主帖完整 HTML（同规范①格式） -->',
                            '  </div>',
                            '  <!-- 评论区标题 -->',
                            '  <div style="font-size:16px;font-weight:700;color:#0f1419;padding:16px 0 8px;">评论</div>',
                            '  <!-- 评论列表 -->',
                            '  <div class="tweet-replies" style="border-top:1px solid #eff3f4;">',
                            '    <!-- 每条评论格式，同规范①的回复格式 -->',
                            '    <!-- 楼层感：可加「3楼」「7楼」等轻量标记 -->',
                            '  </div>',
                            '</div>',
                            '',
                            '配色：底色 #E7E8EA，主文字 #0f1419，次要灰 #536471，强调蓝 #1d9bf0，分割线 #eff3f4。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【评论要求（≥8条）】',
                            '  · 前 3 条：优先由角色卡社交圈人物（助理、同事、家人、粉丝等）发布。',
                            '  · 后 5 条：由路人 NPC 发布（语气随意自然）。',
                            '  · 话题须与主帖内容强相关。',
                            '  · 可出现对 {{char}} 与 {{user}} 关系的猜测、八卦、调侃（不恶意、不露骨）。',
                            '  · 好友本人可对其中 1～2 条评论作出选择性回覆（必须符合角色卡性格）。',
                            '  · 单条评论正文 ≤80 字；单条回覆正文 ≤60 字。',
                            '  · 禁止纯表情凑数、长篇议论、脱离主帖话题。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【{{user}} 用户处理规则】',
                            '  · 允许 NPC 猜测或提及用户与好友的关系。',
                            '  · {{user}} 本人不作为实际评论人出现。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【输出】',
                            '  · 仅输出可直接 document.innerHTML 的原始 HTML。',
                            '  · 禁止 markdown 围栏、禁止 JSON、禁止前言后语。',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                        ].join('\n'),
                        createdAt: ID2,
                        active: true
                    });
            upsertSystemCommandById(cmds, {
                        id: ID3,
                        name: '推特规范③ · 推荐板块',
                        content: [
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【推特规范③ · 推荐板块】',
                            '',
                            '【说明】任务目标、好友抽样（1～3 人）、私聊 8 轮、主帖 ≥12、三成/七成身份配比等**以 API 请求里「【当前 X 时间轴 · 推荐】」段落为准**；本指令只补充**版式与输出形态**，避免与上文重复。',
                            '',
                            '【语言】正文/评论/互动标签/时间为简体中文；顶栏加粗显示名与卡面原文语种一致，禁止整段译成中文。',
                            '',
                            '【时间轴结构】',
                            '· 禁止「为你推荐」二级 Tab、重复顶栏。',
                            '· 每条主帖：外层 class="tweet"；内层横向 flex；左 48px 圆底首字头像占位（禁止 http(s) 外链 <img>）；右列首行加粗显示名 + 灰字 @handle + 相对时间；正文；底部互动行（💬🔄❤️👁 可写虚构数）。',
                            '· 每条主帖**必须**至少 1 条下挂评论：.tweet-reply 或 .twitter-x-reply，padding-left:60px，单条评论 ≤80 字；评论者禁止为 {{user}}。',
                            '',
                            '【身份配比（与上文一致时勿改）】',
                            '· 约 **30%** 主帖：卡面关系网类具名人物（见上文枚举）；全时间轴此类发帖人 **≥3 个不同 @**。',
                            '· 约 **70%** 主帖：与卡面无绑定的纯虚构路人 NPC。',
                            '',
                            '【点进某条主帖后的详情】',
                            '· 须能扩展为评论详情页（由规范②承接）；时间轴阶段每条主帖仍须带齐评论行以利客户端解析。',
                            '',
                            '【{{user}}】禁止作为主帖发帖人及评论发帖人；可作被 @ 对象。',
                            '',
                            '【禁止】真实名人隐私、低俗骚扰、与卡面矛盾的跨号逻辑。',
                            '',
                            '【输出】仅输出可 document.innerHTML 的原始 HTML；禁止 markdown、JSON、前言后语。',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                        ].join('\n'),
                        createdAt: ID3,
                        active: true
                    });
            upsertSystemCommandById(cmds, {
                        id: ID4,
                        name: '推特规范④ · 娱乐板块',
                        content: [
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【推特规范④ · 娱乐板块】',
                            '',
                            '【页面主题】',
                            '本板块聚焦 {{user}}（用户）与 {{char}}（当前好友）之间的关系动态。',
                            twitterSpecChatHistoryUnifiedBanner(),
                            '内容来源还包括：好友角色卡、角色卡关系网（私聊记录数量见上条，**最新 ' + TWITTER_API_CHAT_HISTORY_MAX_ROUNDS + ' 轮**）。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【发帖人身份规则】',
                            '  · 禁止 {{user}} 本人作为主帖发帖人。',
                            '  · 禁止 {{char}}（当前好友）作为主帖发帖人。',
                            '  · 主帖发帖人必须是：好友关系网中的 NPC（助理、闺蜜、同事、家人、粉丝等）、',
                            '    路人围观者、或与 {{char}} 相关的第三方。',
                            '  · 群聊名不得充当发帖账号。',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【内容主题（至少选 8 种）】',
                            '  1. 用户与好友的关系被曝光，引发网友围观讨论',
                            '  2. 好友在社交媒体上疑似暗示与用户的关系',
                            '  3. 好友晒出私密礼物的开箱 / 暗戳戳的礼物线索',
                            '  4. 第三方视角记录好友与用户在一起时被撞见的场景',
                            '  5. 好友与用户互动过程本身被拍下、截图，引发讨论',
                            '  6. 好友深夜 / 凌晨上线被粉丝发现，猜测在和谁聊天',
                            '  7. 关于{{user}}与{{char}}关系的投票帖（选项要有争议性）',
                            '  8. 讨论二人私生活的露骨八卦帖（可由 NPC 直白发言）',
                            '  9. 好友关系网中的粉丝 / 闺蜜发长帖"爆料"二人故事',
                            '  10. 热门评论区围绕{{user}}与{{char}}的热议截图',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【语言】',
                            '  · 正文：规范简体中文',
                            '  · 显示名例外：顶栏加粗显示名须与角色卡原文一致（英文名写英文，德文名写德文），禁止翻译',
                            '  · 时间：「刚才」「10分钟前」「2小时前」「昨天」等相对表述',
                            '  · 禁止纯表情堆砌',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【推文形式（每次刷新 ≥10 条主帖，形式自由组合）】',
                            '  A. 主帖 + 回复流：标准推文 + 下挂 3～8 条 NPC 回复',
                            '  B. 匿名树洞帖：正文为一段第一人称叙述，结尾附"评论区已开启"',
                            '  C. 投票帖：正文抛出一个争议问题，附 2～4 个投票选项（用文字写选项不用真实投票功能）',
                            '  D. 老帖翻新：引用一条"三个月前""半年前"的旧帖，配上新的评论文字',
                            '  E. 热门评论区截图：正文为"截图中大家在说"的内容概述，评论区全是热评',
                            '  F. 长帖：200～400 字完整叙事，可分段，带分隔线',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【回复要求（每条主帖 ≥12 楼回复）】',
                            '  · 回复分布建议：',
                            '    - 1～3 楼：知情者（助理/闺蜜等，语气较确定）',
                            '    - 4～6 楼：粉丝 / 磕 CP 党（激动、八卦、嗑糖）',
                            '    - 7～9 楼：普通网友（随便吃瓜，态度随意）',
                            '    - 10～12 楼：杠精 / 路人（质疑、反对、跑题）',
                            '  · 须出现 1～2 条打字错误或口语化表达，模拟真实用户',
                            '  · 可出现 {{user}} 被直接 @提及，或被隐晦地用绰号指代',
                            '  · 可出现对用户外形的正面/调侃性讨论（不恶意）',
                            '  · 禁止让 {{user}} 作为实际评论人出现',
                            '  · 禁止出现当前用户账号（@handle）作为评论发帖人',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【HTML 结构规范】',
                            '',
                            '页面底色：#E7E8EA',
                            '配色：主文字 #0f1419，次要灰 #536471，强调蓝 #1d9bf0，分割线 #eff3f4',
                            '禁止深色主题。',
                            '',
                            '每条主帖外层 <div class="tweet">：',
                            '<div class="tweet" style="display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid #eff3f4;">',
                            '  <div style="width:48px;height:48px;border-radius:50%;background:#1d9bf0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;font-weight:700;flex-shrink:0;">字</div>',
                            '  <div style="flex:1;min-width:0;">',
                            '    <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">',
                            '      <span style="font-weight:700;font-size:15px;color:#0f1419;">显示名</span>',
                            '      <span style="font-size:15px;color:#536471;">@handle</span>',
                            '      <span style="font-size:15px;color:#536471;">· 相对时间</span>',
                            '    </div>',
                            '    <div style="margin-top:4px;font-size:15px;line-height:1.5;color:#0f1419;">推文正文（正文里可加「投票」「匿名」「老帖翻新」等标签文字，标签用 #1d9bf0 颜色）</div>',
                            '    <!-- 投票帖选项（若有） -->',
                            '    <!-- 引用旧帖（若有） -->',
                            '    <div style="margin-top:10px;display:flex;gap:20px;color:#536471;font-size:13px;">',
                            '      <span>💬 评论数</span>',
                            '      <span>🔄 转发数</span>',
                            '      <span>❤️ 点赞数</span>',
                            '      <span>👁 浏览数</span>',
                            '    </div>',
                            '  </div>',
                            '</div>',
                            '',
                            '主帖下挂回复：',
                            '<div style="margin-top:12px;padding-left:60px;">',
                            '  <div class="tweet-reply" style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid #eff3f4;">',
                            '    <div style="width:36px;height:36px;border-radius:50%;background:#7856ff;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:700;flex-shrink:0;">字</div>',
                            '    <div style="flex:1;min-width:0;">',
                            '      <div style="display:flex;align-items:center;gap:4px;">',
                            '        <span style="font-weight:700;font-size:14px;color:#0f1419;">评论者名</span>',
                            '        <span style="font-size:13px;color:#536471;">@handle · 1h</span>',
                            '        <!-- 可加「1楼」「3楼」等楼层感文字，用 #8a8a8a 颜色 -->',
                            '      </div>',
                            '      <div style="margin-top:2px;font-size:14px;line-height:1.45;color:#0f1419;">评论内容</div>',
                            '    </div>',
                            '  </div>',
                            '</div>',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【{{user}} 处理规则】',
                            '  · 允许 NPC 在回复中提及、猜测、调侃用户与好友的关系',
                            '  · 允许用昵称、绰号隐晦指代用户',
                            '  · 禁止让 {{user}} 作为评论人、回复人出现',
                            '  · 禁止用用户推特账号作为发帖人',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【禁止事项】',
                            '  · 不得出现任何人的真实姓名或敏感信息',
                            '  · 禁止在 HTML 中使用 http(s) 外链 <img>',
                            '  · 头像仅用首字色块占位，客户端按 @handle 注入',
                            '  · 单条回复正文不超过 100 字',
                            '',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                            '【输出】',
                            '  · 每次刷新：输出 ≥10 条主帖（形式自由组合），总回复 ≥120 楼',
                            '  · 仅输出可直接 document.innerHTML 的原始 HTML',
                            '  · 禁止 markdown 围栏、禁止 JSON、禁止前言后语',
                            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                        ].join('\n'),
                        createdAt: ID4,
                        active: true
                    });
            cmds = cmds.filter(function (c) {
                if (!c || typeof c.name !== 'string') return true;
                if (/推特规范[①②③④]/.test(c.name)) {
                    var canon = { 990101: true, 990102: true, 990103: true, 990104: true };
                    return !!canon[c.id];
                }
                return true;
            });
            localStorage.setItem(KEY, JSON.stringify(cmds));
            if (typeof CommandManager !== 'undefined' && CommandManager.syncCommandsToFile) {
                CommandManager.syncCommandsToFile(cmds).then(function () {});
            }
            console.log('[Twitter bootstrap] 推特规范①～④ 已同步；已移除重复的旧版推特规范条目');
        } catch (e) {
            console.error('[Twitter bootstrap] 初始化失败:', e);
        }
    }

    global.isTwitterOnlySystemCommandName = isTwitterOnlySystemCommandName;
    global._buildTwitterChatHistoryLines = _buildTwitterChatHistoryLines;
    global.twitterExtractRoleCardDisplayName = twitterExtractRoleCardDisplayName;
    global.twitterResolveFriendAuthorDisplayName = twitterResolveFriendAuthorDisplayName;
    global.resolveDarkWebCharDisplayNameForApi = resolveDarkWebCharDisplayNameForApi;
    if (global.Twitter && global.Twitter.store) {
        global.Twitter.buildTwitterChatHistoryLines = _buildTwitterChatHistoryLines;
        global.Twitter.API_CHAT_HISTORY_MAX_ROUNDS = TWITTER_API_CHAT_HISTORY_MAX_ROUNDS;
        global.Twitter.USER_POST_CHAT_HISTORY_MAX_ROUNDS = TWITTER_USER_POST_CHAT_HISTORY_MAX_ROUNDS;
    }

    function applyTwitterPromptPatches() {
        if (typeof CommandManager === 'undefined') return;
        CommandManager.buildDarkWebSendContent = buildDarkWebSendContent;
        CommandManager.buildDarkWebHubSendContent = buildDarkWebHubSendContent;
        CommandManager.buildDarkWebDetailPageSendContent = buildDarkWebDetailPageSendContent;
        CommandManager.buildDarkWebDetailFullPageSendContent = buildDarkWebDetailFullPageSendContent;
        CommandManager.buildDarkWebDetailMainSendContent = buildDarkWebDetailMainSendContent;
        CommandManager.buildDarkWebDetailCommentsSendContent = buildDarkWebDetailCommentsSendContent;
        CommandManager.buildTwitterSendContent = buildTwitterSendContent;
        CommandManager.buildTwitterDetailPageSendContent = buildTwitterDetailPageSendContent;
        CommandManager.buildTwitterFriendReplyToUserCommentSendContent = buildTwitterFriendReplyToUserCommentSendContent;
        CommandManager.buildTwitterUserPostCommentsSendContent = buildTwitterUserPostCommentsSendContent;
        CommandManager.buildTwitterFriendReplyToUserOwnPostCommentSendContent = buildTwitterFriendReplyToUserOwnPostCommentSendContent;
    }
    applyTwitterPromptPatches();

    global.bootstrapTwitterSystemCommands = bootstrapTwitterSystemCommands;
})(typeof window !== 'undefined' ? window : globalThis);
