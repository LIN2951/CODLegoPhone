// ========== 手机功能：好友列表 / API 锁屏密码 / 质问消息 / iOS 桌面 ==========
(function () {
    const PHONE_LOCK_PIN_CACHE = new Map();
    /** 提升该数字可使旧缓存失效，避免沿用与当前提示词规则不一致的 PIN */
    const PHONE_LOCK_CACHE_SCHEMA = 4;
    const PHONE_LOCK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const PHONE_SIG_CACHE = new Map();
    const state = {
        friendId: null,
        friend: null,
        expectedPin: '',
        attemptsLeft: 3,
        input: '',
        forcePrompted: false,
        lockController: null,
        timeTimer: null,
        pinRefreshTimer: null,
        appKind: '',
    };

    /** 与朋友圈模块共用聊天记录摘要；优先走 Moments 命名空间 */
    function getMomentsChatHistoryLines(friendId, maxRounds, fmt) {
        if (typeof Moments !== 'undefined' && typeof Moments.buildMomentsChatHistoryLines === 'function') {
            return Moments.buildMomentsChatHistoryLines(friendId, maxRounds, fmt);
        }
        if (typeof _buildMomentsChatHistoryLines === 'function') {
            return _buildMomentsChatHistoryLines(friendId, maxRounds, fmt);
        }
        return '';
    }

    function buildPhoneFeatureWorldBooksBlock(friend) {
        if (!friend) return '';
        const wbData = typeof getWorldBookData === 'function' ? getWorldBookData() : { entries: [] };
        const entries = wbData.entries || [];
        const wbIds = Array.isArray(friend.worldBookIds) ? friend.worldBookIds : (friend.worldBookId ? [friend.worldBookId] : []);
        const ids = new Set(wbIds.map(String));
        const chunks = [];
        entries.forEach((entry) => {
            if (!entry || !entry.content) return;
            if (!ids.has(String(entry.id))) return;
            const name = (entry.name || '').trim();
            if (/中英对照|功能性|翻译|双语|对照表|词汇表|语言学习|日韩对照/i.test(name)) return;
            if (/私密动态|朋友圈|微信.*(模板|样式|HTML)|消息气泡|聊天界面|Story|Ins风|美化/i.test(name)) return;
            const c = String(entry.content || '');
            const tagN = (c.match(/<[^>]+>/g) || []).length;
            if (tagN >= 8) return;
            if (/<!DOCTYPE|<html[\s>]/i.test(c)) return;
            chunks.push(`---\n世界书《${name}》:\n${c}`);
        });
        return chunks.length
            ? '【世界书·好友关联｜纯文字世界观与角色演绎补充（已排除明显翻译/HTML模板类条目）】\n' + chunks.join('\n')
            : '';
    }

    function buildPhoneLockPasswordPrompt(friend) {
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        const emojiData = typeof parseJsonFromPossiblyEncodedStorage === 'function'
            ? parseJsonFromPossiblyEncodedStorage(typeof EMOJI_DATA_LS_KEY !== 'undefined' ? EMOJI_DATA_LS_KEY : 'emojiData', {})
            : {};
        let allEmojis = [];
        if (emojiData && typeof emojiData === 'object') {
            Object.keys(emojiData).forEach((k) => {
                allEmojis = allEmojis.concat(emojiData[k] || []);
            });
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);
        const hist = getMomentsChatHistoryLines(friend.id, 10, fmt);

        const parts = [];
        const core = CommandManager.getCoreCommands();
        core.forEach((cmd) => parts.push(cmd.content));

        const wb = buildPhoneFeatureWorldBooksBlock(friend);
        if (wb) parts.push(wb);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const userRoleExtra =
            myProfile && (myProfile.roleSetting || myProfile.role) ? String(myProfile.roleSetting || myProfile.role).trim() : '';

        parts.push(`---
【唯一主体｜禁止串台】正在为本地好友「${displayName}」生成锁屏密码。你只能依据**下方这一份**「${displayName}」的角色卡、以及与**该好友**的聊天记录来推断；**严禁**把其它好友、其它角色卡、或与本好友无关的设定混用。世界书若出现与他人强相关而与「${displayName}」无直接关联的内容，必须忽略。
`);
        parts.push(`---
【好友 ${displayName}】手机锁屏·设定上下文（仅此一份角色卡）
本地ID: ${friend.id}
角色卡:
${friend.roleSetting || friend.role || '无'}

用户人设卡（仅作聊天语境参考；密码锚点仍以好友角色卡与双方聊天记录为优先）:
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充:\n${userRoleExtra}` : ''}
`);

        parts.push(`---
【${displayName}】与用户的最近聊天记录（至多 10 轮完整来回，表情已脱敏）
${hist || '（暂无足够来回记录，请主要依据上文该好友角色卡推断；不可杜撰未出现的纪念日）'}
`);

        parts.push(`---
【任务｜${displayName} 的手机锁屏密码｜仅输出 JSON】
请只输出一个 JSON 对象（不要 markdown、不要多余文字），格式如下：
{
  "pin": "4位数字字符串",
  "hint": "12~40字中文提示（只描述推导规则；不要出现任何具体数字/日期/精确数值）",
  "explain": "可选：一句更直白的推导说明（允许出现数字；仅用于系统校验，不会直接展示给用户）"
}

【硬性要求】
1) pin 必须严格为 4 位数字（0000-9999）。
2) hint 必须能让人理解“怎么取/怎么拼”，但**禁止**直接给出精确数字；例如：
   - 生日：只提示“他的生日的月和日，四位数直接拼接。”
   - 组合：只提示“他的年龄加上体重按顺序排列。”
   - 组合：只提示“他的身高后两位和他当前服役时间顺序排列。”
   - 纪念日：只提示“我们初遇的那天。”
3) 只能依据该好友角色卡 + 与该好友聊天记录中明文出现的数字线索；不要发明未出现的纪念日或数字。
4) 避免歧义：若由两个来源拼接，必须写清“取前/后两位”和拼接顺序。
`);
        return parts.join('\n');
    }

    function buildPhoneIntruderWechatPrompt(friend) {
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        const emojiData = typeof parseJsonFromPossiblyEncodedStorage === 'function'
            ? parseJsonFromPossiblyEncodedStorage(typeof EMOJI_DATA_LS_KEY !== 'undefined' ? EMOJI_DATA_LS_KEY : 'emojiData', {})
            : {};
        let allEmojis = [];
        if (emojiData && typeof emojiData === 'object') {
            Object.keys(emojiData).forEach((k) => {
                allEmojis = allEmojis.concat(emojiData[k] || []);
            });
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);
        const hist = getMomentsChatHistoryLines(friend.id, 10, fmt);

        const parts = [];
        CommandManager.getCoreCommands().forEach((cmd) => parts.push(cmd.content));
        const wb = buildPhoneFeatureWorldBooksBlock(friend);
        if (wb) parts.push(wb);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const userRoleExtra =
            myProfile && (myProfile.roleSetting || myProfile.role) ? String(myProfile.roleSetting || myProfile.role).trim() : '';

        parts.push(`---
【好友 ${displayName}】
角色卡:
${friend.roleSetting || friend.role || '无'}

用户人设:
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充:\n${userRoleExtra}` : ''}

【最近聊天记录（至多 10 轮）】
${hist || '（暂无）'}
`);

        parts.push(`---
【任务】
对方（用户）**连续多次输错你的手机锁屏密码**，仿佛正在尝试解锁你的手机。
请你**严格以该好友的身份与性格底色**，在微信私聊里发一条质问、警觉、试探或撒娇抱怨的消息（任选符合人设的语气），表达「你怎么在动我手机 / 你在干嘛」一类含义。

输出要求：
1. **仅输出一条消息正文**（像真发微信），口语自然；建议 15～80 字。
2. 脾气暴的可直球质问，温柔的可委屈试探，冷淡的可短句施压——**严禁千人一面**。
3. 禁止 JSON、markdown、角色扮演说明、括注心情；禁止替用户说话。
`);
        parts.push(
            (typeof Moments !== 'undefined' && Moments.prompts && Moments.prompts.WECHAT_MOMENTS_COMMENT_OUTPUT_RULE)
                ? Moments.prompts.WECHAT_MOMENTS_COMMENT_OUTPUT_RULE
                : (typeof WECHAT_MOMENTS_COMMENT_OUTPUT_RULE !== 'undefined' ? WECHAT_MOMENTS_COMMENT_OUTPUT_RULE : '')
        );
        return parts.filter(Boolean).join('\n');
    }

    function buildPhoneDesktopSignaturePrompt(friend) {
        const parts = [];
        CommandManager.getCoreCommands().forEach((cmd) => parts.push(cmd.content));
        const wb = buildPhoneFeatureWorldBooksBlock(friend);
        if (wb) parts.push(wb);
        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        parts.push(`---
【好友 ${displayName}】
角色卡:
${friend.roleSetting || friend.role || '无'}
`);
        parts.push(`---
【任务】
为「${displayName}」的手机桌面主卡片生成 **签名**。请优先从以下范围寻找或化用最贴合 TA 的句子：名著摘录、名人名言、电影经典台词、符合角色卡性格底色或人生经历的歌词。若没有足够贴合的已知句子，可生成同等质感的原创短句。

【选择标准】
- **严格贴合**角色卡中的身份、性格、经历、气质与人生创伤/执念/愿望，让读者感到「这就是 TA 会用的那句话」。
- **优先贴合度**高于知名度；不要为了引用名句而牺牲角色感。
- 字数 **10～100 字**，必须是完整句子，不要截断半句；标点计入字数。
- 若角色来自特定国家/文化，可使用相应语言书写，但仍要自然像手机签名。
- **仅输出签名正文**，单行即可；不要引号包裹全句、不要「签名：」等前缀、不要 markdown、不要出处说明。
`);
        return parts.join('\n');
    }

    /** 桌面模块 API 共用的上文：核心指令、世界书、角色卡、人设、聊天记录 */
    function buildPhoneDesktopModulesSharedContext(friend, standalone) {
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        const emojiData = typeof parseJsonFromPossiblyEncodedStorage === 'function'
            ? parseJsonFromPossiblyEncodedStorage(typeof EMOJI_DATA_LS_KEY !== 'undefined' ? EMOJI_DATA_LS_KEY : 'emojiData', {})
            : {};
        let allEmojis = [];
        if (emojiData && typeof emojiData === 'object') {
            Object.keys(emojiData).forEach((k) => {
                allEmojis = allEmojis.concat(emojiData[k] || []);
            });
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);
        const hist10 = getMomentsChatHistoryLines(friend.id, 10, fmt);
        const hist2 = getMomentsChatHistoryLines(friend.id, 2, fmt);

        const parts = [];
        CommandManager.getCoreCommands().forEach((cmd) => parts.push(cmd.content));
        const wb = buildPhoneFeatureWorldBooksBlock(friend);
        if (wb) parts.push(wb);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const userRoleExtra =
            myProfile && (myProfile.roleSetting || myProfile.role) ? String(myProfile.roleSetting || myProfile.role).trim() : '';

        parts.push(`---
【上下文｜好友「${displayName}」手机模块】${
            standalone
                ? '（**单独刷新**：本页只触发 **一次** API，请在本条响应内输出完整、可解析 JSON。）'
                : '（同一轮刷新内共 2 次模型调用，本段两次相同）'
        }
严格可用信息：
1) 系统核心指令（已在上方）
2) 世界书（已筛选）
3) 好友角色卡 + 用户人设卡（如下）
4) 好友与用户的聊天记录最新 10 轮（及最新 2 轮用于私聊界面）
`);

        parts.push(`---
【好友 ${displayName}】角色卡
${friend.roleSetting || friend.role || '无'}

【用户人设卡】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充:\n${userRoleExtra}` : ''}
`);

        parts.push(`---
【你与 ${displayName} 的最近聊天记录（最新 10 轮）】
${hist10 || '（暂无）'}

【你与 ${displayName} 的聊天界面截取（最新 2 轮）】
${hist2 || '（暂无）'}
`);

        return { displayName, text: parts.filter(Boolean).join('\n') };
    }

    function loadIntruderVideoRuleText() {
        const videoRuleCmd =
            typeof CommandManager?.getAllCommands === 'function'
                ? (CommandManager.getAllCommands() || []).find((c) => c && c.active && String(c.name || '').trim() === '入侵好友手机①视频生成规则')
                : null;
        return videoRuleCmd && videoRuleCmd.content ? String(videoRuleCmd.content) : '';
    }

    /** 用户人设卡昵称（好友手机里「你」的展示名，禁止用「用户」「User」替代） */
    function getPhoneFeatureUserProfileNickname() {
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        return String(myProfile?.nickname || '').trim() || '我';
    }

    /** 仅微信：顶层只有 wechat */
    function buildPhoneDesktopModuleWechatPrompt(friend) {
        const { displayName, text: ctx } = buildPhoneDesktopModulesSharedContext(friend, true);
        const userNick = getPhoneFeatureUserProfileNickname();
        return [
            ctx,
            `---
【系统任务｜好友手机 · 微信 · 单独刷新】
用户**只**刷新了「微信」板块；**仅本次一次模型调用**。请**只**生成 wechat，JSON **顶层只能有 wechat 一个键**，禁止 shopping、video、call 及任何其它顶层字段。

【微信规则】
1) people（好友列表）6–12 人：姓名与关系须呼应好友角色卡中的人际关系（同事/队友/亲友等）。
2) 与用户（人设昵称「${userNick}」）及 ${displayName} 的**私聊**会话：只能依据上文中「你与 ${displayName} 的聊天界面截取（最新 2 轮）」的**真实内容**生成气泡；无记录时可极简占位，**禁止**编造超出这 2 轮范围外的对话。
3) 与其它联系人的会话：每个联系人 6–12 条互动消息（优先 messages）；对话正文须为 **英文 + (括号中文翻译)**。
4) isUser: true 的列表项：name **必须**为「${userNick}」；**禁止**写「用户」「User」等占位词。
5) userThreadMessages（及 bubbles 的 name）：用户侧必须用「${userNick}」，禁止 User/用户。

【输出｜仅 JSON】
{
  "wechat": {
    "html": "",
    "people": [ { "id": "u0", "name": "（必须与上文昵称一致）", "isUser": true } ],
    "threads": [ { "with": "p1", "html": "", "messages": [ { "side": "left", "name": "…", "text": "Hello. (你好。)" } ] } ],
    "userThreadHtml": "",
    "userThreadMessages": [ { "side": "right", "name": "（必须与上文昵称一致）", "text": "OK. (好的。)" } ]
  }
}
`
        ].join('\n');
    }

    /** 仅购物：顶层只有 shopping */
    function buildPhoneDesktopModuleShoppingPrompt(friend) {
        const { displayName, text: ctx } = buildPhoneDesktopModulesSharedContext(friend, true);
        return [
            ctx,
            `---
【系统任务｜好友手机 · 购物 · 单独刷新】
用户**只**刷新了「购物」板块；**仅本次一次模型调用**。请**只**生成 shopping，JSON **顶层只能有 shopping 一个键**，禁止 wechat、video、call 及其它顶层字段。

【购物规则】
- 3–6 个商品：商品名、价格、稳定 id；每个商品有「详情原因」reason（≤200 字）说明 ${displayName} 为何购买。
- 选品贴合 ${displayName} 的身份/职业或与用户的关系。
- HTML 可用占位结构，不要写 <style>；不要外链脚本。

【输出｜仅 JSON】
{
  "shopping": { "html": "", "items": [ { "id": "s1", "name": "商品名", "price": "¥199", "reason": "原因" } ] }
}
`
        ].join('\n');
    }

    /** 仅视频：顶层只有 video */
    function buildPhoneDesktopModuleVideoPrompt(friend) {
        const { displayName, text: ctx } = buildPhoneDesktopModulesSharedContext(friend, true);
        const videoRule = loadIntruderVideoRuleText();
        const chunks = [ctx];
        if (videoRule) {
            chunks.push(`---
【入侵好友手机①视频生成规则】
${videoRule}
`);
        }
        chunks.push(`---
【系统任务｜好友手机 · 视频 · 单独刷新】
用户**只**刷新了「视频」板块；**仅本次一次模型调用**。请**只**生成 video，JSON **顶层只能有 video 一个键**，禁止 wechat、shopping、call 及其它顶层字段。

【与「入侵好友手机①视频生成规则」一致·摘要】（${displayName}）
- 契约全文、虚构层、语气与字数以上文注入的【入侵好友手机①视频生成规则】为准；本段只固定客户端 JSON 形状，避免与系统指令冲突。
- video.items 须 4–6 条；每条 **id**、**tags**（数组 1–6 项）、**title**（≤100 字符）、**detail**（≤500 字符）；id 唯一（如 v1..v6）。**video.html** 可留空；界面仅根据 items 渲染。
- **JSON 字符串**（title/tags/detail 等）内双引号须写成 \\"；换行用 \\n，勿在字符串值内插入未转义的真实换行。

【输出｜仅 JSON】
{
  "video": { "html": "", "items": [ { "id": "v1", "tags": ["霸总", "体型差", "dirty talk"], "title": "标题", "detail": "第一人称内心独白：Char（指好友）看视频时联想到与User（用户）的亲密幻想与期待，描写情绪、氛围、互动与对User反应的想象\\n可分多行" } ] }
}
`);
        return chunks.join('\n');
    }

    /** 仅通话：顶层只有 call */
    function buildPhoneDesktopModuleCallPrompt(friend) {
        const { displayName, text: ctx } = buildPhoneDesktopModulesSharedContext(friend, true);
        return [
            ctx,
            `---
【系统任务｜好友手机 · 通话 · 单独刷新】
用户**只**刷新了「通话」板块；**仅本次一次模型调用**。请**只**生成 call，JSON **顶层只能有 call 一个键**，禁止 wechat、shopping、video 及其它顶层字段。

【通话规则】（${displayName}）
- 若干条通话记录：who、time、稳定 id；script 为详情页「剧本体」正文。

【输出｜仅 JSON】
{
  "call": { "html": "", "items": [ { "id": "c1", "who": "来电人", "time": "昨天 21:05", "script": "A：...\\\\nB：..." } ] }
}
`
        ].join('\n');
    }

    const PHONE_FRIEND_MODULE_SECTIONS = ['wechat', 'shopping', 'video', 'call'];

    /** 各板块独立 localStorage（与资产同样「一对一 API → 一对一缓存」） */
    function phoneFriendModuleStorageKey(friendId, sectionKey) {
        return `phone_friend_mod_${String(sectionKey)}_${String(friendId)}`;
    }

    /** 旧版合并写入的唯一键，仅用于迁移读出 */
    function phoneFriendModulesLegacyStorageKey(friendId) {
        return `phone_friend_modules_${String(friendId)}`;
    }

    function writeFriendModuleSection(friendId, sectionKey, sectionData) {
        if (!friendId || !sectionKey || !sectionData || typeof sectionData !== 'object') return;
        try {
            localStorage.setItem(
                phoneFriendModuleStorageKey(friendId, sectionKey),
                JSON.stringify({ ts: Date.now(), data: sectionData })
            );
        } catch (e) {}
    }

    /** 读取单个板块；若仅有旧版合并缓存则拆出一条并写入新键 */
    function readFriendModuleSection(friendId, sectionKey) {
        if (!friendId || !PHONE_FRIEND_MODULE_SECTIONS.includes(sectionKey)) return null;
        try {
            const raw = localStorage.getItem(phoneFriendModuleStorageKey(friendId, sectionKey));
            if (raw) {
                const parsed = JSON.parse(raw);
                const d = parsed && parsed.data != null ? parsed.data : null;
                if (d && typeof d === 'object') return d;
            }
        } catch (e) {}
        try {
            const legacyRaw = localStorage.getItem(phoneFriendModulesLegacyStorageKey(friendId));
            if (!legacyRaw) return null;
            const legacy = JSON.parse(legacyRaw);
            const blob = legacy && legacy.data && typeof legacy.data === 'object' ? legacy.data : null;
            const section = blob && blob[sectionKey];
            if (!section || typeof section !== 'object') return null;
            writeFriendModuleSection(friendId, sectionKey, section);
            return section;
        } catch (e) {
            return null;
        }
    }

    /** 供仍需「整包」的逻辑使用：由四个独立缓存拼成 { wechat?, shopping?, … } */
    function readFriendModules(friendId) {
        const out = {};
        for (let i = 0; i < PHONE_FRIEND_MODULE_SECTIONS.length; i++) {
            const k = PHONE_FRIEND_MODULE_SECTIONS[i];
            const v = readFriendModuleSection(friendId, k);
            if (v) out[k] = v;
        }
        return Object.keys(out).length ? out : null;
    }

    const PHONE_FRIEND_APP_KIND_TO_SECTION = {
        wechat: 'wechat',
        shopping: 'shopping',
        video: 'video',
        call: 'call'
    };

    function readFriendModuleWrapped(friendId, kind) {
        const sectionKey = PHONE_FRIEND_APP_KIND_TO_SECTION[kind];
        if (!sectionKey) return null;
        const section = readFriendModuleSection(friendId, sectionKey);
        if (!section) return null;
        return { [sectionKey]: section };
    }

    /** 将模型偶发写的「用户」「User」强制替换为人设卡昵称（仅修正 isUser/用户侧气泡） */
    function normalizePhoneWechatModuleUserLabels(wechat, userNick) {
        const nick = String(userNick || '').trim() || '我';
        if (!wechat || typeof wechat !== 'object') return wechat;
        const out = { ...wechat };
        if (Array.isArray(out.people)) {
            out.people = out.people.map((p) => {
                if (!p || typeof p !== 'object') return p;
                if (p.isUser) return { ...p, name: nick };
                return p;
            });
        }
        const patchMsg = (m) => {
            if (!m || typeof m !== 'object') return m;
            const side = String(m.side || m.from || '').toLowerCase();
            const isMe = side === 'right' || side === 'me' || side === 'user' || side === 'my';
            if (!isMe) return m;
            return { ...m, name: nick };
        };
        if (Array.isArray(out.userThreadMessages)) {
            out.userThreadMessages = out.userThreadMessages.map(patchMsg);
        }
        if (Array.isArray(out.threads)) {
            out.threads = out.threads.map((t) => {
                if (!t || typeof t !== 'object') return t;
                if (!Array.isArray(t.messages)) return t;
                return { ...t, messages: t.messages.map(patchMsg) };
            });
        }
        return out;
    }

    function phoneFriendSignatureStorageKey(friendId) {
        return `phone_friend_signature_${String(friendId)}`;
    }

    function getPhoneLockPinCacheTs(friendId) {
        const cached = readPhoneLockPinCacheFromStorage(friendId);
        return cached && Number.isFinite(cached.ts) && cached.ts > 0 ? cached.ts : 0;
    }

    function readPhoneFriendSignatureMeta(friendId) {
        try {
            const raw = localStorage.getItem(phoneFriendSignatureStorageKey(friendId));
            const parsed = raw ? JSON.parse(raw) : null;
            const sig = parsed && parsed.sig != null ? String(parsed.sig).trim() : '';
            if (!sig) return { sig: '', lockPinTs: 0, ts: 0 };
            const lockPinTs = Number(parsed.lockPinTs || 0);
            const ts = Number(parsed.ts || 0);
            return {
                sig: truncatePhoneSignature(sig, 100),
                lockPinTs: Number.isFinite(lockPinTs) ? lockPinTs : 0,
                ts: Number.isFinite(ts) ? ts : 0
            };
        } catch (e) {
            return { sig: '', lockPinTs: 0, ts: 0 };
        }
    }

    function readPhoneFriendSignature(friendId) {
        return readPhoneFriendSignatureMeta(friendId).sig || '';
    }

    function isPhoneFriendSignatureStaleForPin(friendId) {
        const pinTs = getPhoneLockPinCacheTs(friendId);
        if (!pinTs) return false;
        const meta = readPhoneFriendSignatureMeta(friendId);
        return !meta.sig || meta.lockPinTs !== pinTs;
    }

    function writePhoneFriendSignature(friendId, sig, opts) {
        try {
            const s = truncatePhoneSignature(String(sig || '').trim(), 100);
            if (!s) return;
            const lockPinTs =
                opts && Number.isFinite(opts.lockPinTs)
                    ? Number(opts.lockPinTs)
                    : getPhoneLockPinCacheTs(friendId);
            localStorage.setItem(
                phoneFriendSignatureStorageKey(friendId),
                JSON.stringify({ ts: Date.now(), lockPinTs, sig: s })
            );
        } catch (e) {}
    }

    function phoneFriendAssetsStorageKey(friendId) {
        return `phone_friend_assets_${String(friendId)}`;
    }

    function readFriendAssets(friendId) {
        try {
            const raw = localStorage.getItem(phoneFriendAssetsStorageKey(friendId));
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && parsed.data ? parsed.data : null;
        } catch (e) {
            return null;
        }
    }

    function writeFriendAssets(friendId, data) {
        try {
            localStorage.setItem(phoneFriendAssetsStorageKey(friendId), JSON.stringify({ ts: Date.now(), data }));
        } catch (e) {}
    }

    function phoneLockPinStorageKey(friendId) {
        return `phone_lock_pin_${PHONE_LOCK_CACHE_SCHEMA}_${String(friendId)}`;
    }

    function phoneLockFirstUnlockStorageKey(friendId) {
        return `phone_lock_first_unlock_${String(friendId)}`;
    }

    function readPhoneLockFirstUnlockTs(friendId) {
        try {
            const raw = localStorage.getItem(phoneLockFirstUnlockStorageKey(friendId));
            const n = raw == null ? NaN : Number(raw);
            return Number.isFinite(n) && n > 0 ? n : null;
        } catch (e) {
            return null;
        }
    }

    function writePhoneLockFirstUnlockTs(friendId, ts) {
        try {
            localStorage.setItem(phoneLockFirstUnlockStorageKey(friendId), String(Number(ts) || Date.now()));
        } catch (e) {}
    }

    function clearPhoneLockFirstUnlockTs(friendId) {
        try {
            localStorage.removeItem(phoneLockFirstUnlockStorageKey(friendId));
        } catch (e) {}
    }

    function readPhoneLockPinCacheFromStorage(friendId) {
        try {
            const raw = localStorage.getItem(phoneLockPinStorageKey(friendId));
            const parsed = raw ? JSON.parse(raw) : null;
            if (!parsed || typeof parsed !== 'object') return null;
            if (parsed._sch !== PHONE_LOCK_CACHE_SCHEMA) return null;
            const pin = String(parsed.pin || '').trim();
            if (!/^\d{4}$/.test(pin)) return null;
            const hint = String(parsed.hint || '').trim();
            const ts = Number(parsed.ts || 0);
            return { pin, hint, ts: Number.isFinite(ts) ? ts : 0 };
        } catch (e) {
            return null;
        }
    }

    function writePhoneLockPinCacheToStorage(friendId, data) {
        try {
            const pin = String(data?.pin || '').trim();
            if (!/^\d{4}$/.test(pin)) return;
            const hint = String(data?.hint || '').trim();
            localStorage.setItem(
                phoneLockPinStorageKey(friendId),
                JSON.stringify({ _sch: PHONE_LOCK_CACHE_SCHEMA, pin, hint, ts: Date.now() })
            );
        } catch (e) {}
    }

    const PHONE_MODULE_JSON_FIX_SUFFIX =
        '\n\n【输出修正｜必须遵守】若你上一段输出曾被系统判为无法解析：请**只输出一个 JSON 对象**，禁止 markdown/代码围栏/解释文字。\n' +
        '- 字符串值内的双引号必须写成 \\"；禁止在字符串值里使用未转义的裸双引号。\n' +
        '- 换行写 \\n，不要在 JSON 字符串值内插入真实换行。\n' +
        '- 键名必须用双引号；不要尾逗号。';

    /** 写入缓存前的可读告警：解析成功但可能导致界面「看起来没有内容」 */
    function describePhoneDesktopPayloadWarn(sectionKey, sectionVal) {
        if (!sectionVal || typeof sectionVal !== 'object' || Array.isArray(sectionVal)) return '';
        if (sectionKey === 'video') {
            if (!Array.isArray(sectionVal.items)) {
                return '模型返回的 video 缺少 items 数组，列表将为空。';
            }
            if (sectionVal.items.length === 0) {
                return '模型返回的 items 为空数组，没有可展示的视频卡片。';
            }
            const usable = sectionVal.items.filter((it) => {
                if (!it || typeof it !== 'object') return false;
                return String(it.id || '').trim() || String(it.title || '').trim();
            });
            if (!usable.length) {
                return 'items 内有条目但缺少可用的 id/title，界面无法生成卡片。';
            }
            return '';
        }
        if (sectionKey === 'shopping') {
            const items = Array.isArray(sectionVal.items) ? sectionVal.items : null;
            if (!items) return 'shopping 缺少 items 数组。';
            if (!items.length) return 'shopping.items 为空。';
            return '';
        }
        if (sectionKey === 'call') {
            const items = Array.isArray(sectionVal.items) ? sectionVal.items : null;
            if (!items) return 'call 缺少 items 数组。';
            if (!items.length) return 'call.items 为空。';
            return '';
        }
        if (sectionKey === 'wechat') {
            const people = Array.isArray(sectionVal.people) ? sectionVal.people : null;
            if (!people || !people.length) return 'wechat.people 为空，联系人列表可能没有内容。';
            return '';
        }
        return '';
    }

    /**
     * 只刷新某一板块（一次 API），其它板块沿用本地缓存。
     * @returns {{ ok: true, data: object, warn: string } | { ok: false, data: null, detail: string, brief: string }}
     */
    async function refreshPhoneDesktopModuleByKey(friend, sectionKey, buildPrompt) {
        const badParams = {
            ok: false,
            data: null,
            detail: '内部错误：缺少好友或板块标识。',
            brief: '刷新失败：参数缺失'
        };
        if (!friend || !sectionKey) return badParams;

        const extract = (raw) =>
            typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(raw || '') : null;
        const callOnce = (promptText) =>
            FeatureCommandMapper.callApiModel(promptText, null, {
                skipOverlay: true,
                suppressErrorDialog: true,
                apiRetry: true
            });

        let raw = await callOnce(buildPrompt(friend));
        let data = extract(raw);
        if ((!data || typeof data !== 'object') && raw != null && String(raw).trim()) {
            raw = await callOnce(buildPrompt(friend) + PHONE_MODULE_JSON_FIX_SUFFIX);
            data = extract(raw);
        }

        if (raw == null || !String(raw).trim()) {
            return {
                ok: false,
                data: null,
                detail:
                    '未收到可用的模型正文（常见：未完成 API 设置、网络中断、上游错误或请求被拦截）。\n' +
                    '本页面刷新使用了「静默 API」模式，失败时不会在屏幕上弹出默认 API 错误框；请打开浏览器开发者工具控制台查看「API调用失败」日志。',
                brief: '刷新失败：API未返回内容'
            };
        }

        if (!data || typeof data !== 'object') {
            const preview = String(raw).replace(/\s+/g, ' ').trim().slice(0, 200);
            return {
                ok: false,
                data: null,
                detail:
                    '后台能看到模型输出，但浏览器无法从中解析出合法 JSON 对象（常见于 Markdown 围栏、前后说明文字、未转义双引号，或截断导致花括号不配）。\n\n' +
                    '输出摘要（前 200 字）：' +
                    preview +
                    (String(raw).length > 200 ? '…' : ''),
                brief: '刷新失败：JSON无法解析'
            };
        }

        let sectionVal = data[sectionKey];
        if (!sectionVal || typeof sectionVal !== 'object') {
            const keys = Object.keys(data)
                .slice(0, 14)
                .join(', ');
            return {
                ok: false,
                data: null,
                detail:
                    'JSON 已解析，但缺少本板块所需的「' +
                    sectionKey +
                    '」对象（单次刷新要求模型**仅**输出该键）。\n\n' +
                    '当前顶层键：' +
                    (keys || '（无）'),
                brief: '刷新失败：缺少板块字段'
            };
        }

        if (Array.isArray(sectionVal)) {
            return {
                ok: false,
                data: null,
                detail: '「' + sectionKey + '」必须是 JSON 对象 { … }，不能是数组 [ … ]。',
                brief: '刷新失败：数据结构类型错误'
            };
        }

        if (sectionKey === 'wechat') {
            sectionVal = normalizePhoneWechatModuleUserLabels(sectionVal, getPhoneFeatureUserProfileNickname());
        }

        const warn = describePhoneDesktopPayloadWarn(sectionKey, sectionVal);
        writeFriendModuleSection(friend.id, sectionKey, sectionVal);
        return { ok: true, data: sectionVal, warn };
    }

    /** 顺序刷新四板块（各一次 API） */
    async function refreshPhoneDesktopModules(friend) {
        if (!friend) return null;
        await refreshPhoneDesktopModuleByKey(friend, 'wechat', buildPhoneDesktopModuleWechatPrompt);
        await refreshPhoneDesktopModuleByKey(friend, 'shopping', buildPhoneDesktopModuleShoppingPrompt);
        await refreshPhoneDesktopModuleByKey(friend, 'video', buildPhoneDesktopModuleVideoPrompt);
        await refreshPhoneDesktopModuleByKey(friend, 'call', buildPhoneDesktopModuleCallPrompt);
        return readFriendModules(friend.id);
    }

    function parsePhoneLockPinAndHintFromApiText(text) {
        if (!text || typeof text !== 'string') return { pin: '', hint: '' };
        let s = text.trim();
        // 优先尝试 JSON（避免模型输出里夹杂其它数字导致误取 PIN）
        try {
            const obj = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(s) : null;
            if (obj && typeof obj === 'object') {
                const pin0 = String(obj.pin || obj.password || '').trim();
                const hint0 = String(obj.hint || obj.tips || obj.prompt || '').trim();
                const explain0 = String(obj.explain || obj.reason || obj.derivation || '').trim();
                const pin = (pin0.match(/\d{4}/) || [])[0] || '';
                const hint = truncatePhoneSignature(hint0 || '', 96);
                const explain = truncatePhoneSignature(explain0 || '', 160);
                if (pin && (hint || explain)) {
                    // hint 不应承载精确数字；explain 仅用于系统侧校验/排错，不直接展示
                    return { pin, hint: hint || '', explain };
                }
            }
        } catch (e) {}
        const fence = /```[^\n]*\n([\s\S]*?)```/i.exec(s);
        if (fence) s = fence[1].trim();
        const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const first = lines[0] || s;
        let pin = '';
        const m = first.match(/(\d{4})/);
        if (m) pin = m[1];
        else {
            const digits = first.replace(/\D/g, '');
            if (digits.length >= 4) pin = digits.slice(0, 4);
        }
        let hint = '';
        if (lines.length >= 2) {
            hint = lines
                .slice(1)
                .join(' ')
                .replace(/^(密码提示|提示|hint)[:：]\s*/i, '')
                .trim();
        }
        hint = truncatePhoneSignature(hint, 96);
        return { pin, hint, explain: '' };
    }

    function isVagueOrBrokenPhoneLockHint(h) {
        if (!h || typeof h !== 'string') return true;
        if (/可以试试与「/.test(h)) return true;
        if (/「[^」]*$/.test(h)) return true;
        if (/「/.test(h) && (!/」/.test(h) || (h.match(/「/g) || []).length !== (h.match(/」/g) || []).length)) return true;
        if (/（[^）]*$/.test(h)) return true;
        if (/（[A-Za-z0-9Ａ-Ｚａ-ｚ][^）]*$/.test(h)) return true;
        if (/(曾|前).{0,10}(；|，).{0,10}(现为|曾任)/.test(h)) return true;
        // 高风险模糊提示：容易出现 5 位以上“直接拼接”歧义
        if (/(年龄|岁).*(番号|队伍|特遣队|编队|代号).*(直接拼接|直接组合|拼接)/.test(h)) return true;
        if (/(番号|队伍|特遣队|编队|代号).*(年龄|岁).*(直接拼接|直接组合|拼接)/.test(h)) return true;
        return false;
    }

    function redactExactDigitsFromHint(h) {
        // 目标：提示“规则”，而不是暴露“精确数值”
        return String(h || '')
            .replace(/[0-9０-９]+/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    function normalizePhoneLockHint(hintRaw, friend) {
        let h = truncatePhoneSignature(String(hintRaw || '').trim(), 80);
        h = redactExactDigitsFromHint(h);
        if (!h) return fallbackPhoneLockHint(friend);
        if (h.length < 10) return fallbackPhoneLockHint(friend);
        if (isVagueOrBrokenPhoneLockHint(h)) return fallbackPhoneLockHint(friend);
        const endsOk = /[。！？…」』"'］）]$/.test(h);
        if (!endsOk) {
            if (h.length < 14) return fallbackPhoneLockHint(friend);
            h += '。';
        }
        return h;
    }

    function fallbackPhoneLockHint(friend) {
        void friend;
        return '只需提示推导规则：如生日月日顺序拼接、年龄加体重顺序排列、身高后两位加服役时间顺序排列，或某个纪念日；不要写出具体数字。';
    }

    function formatPhoneLockWrongPasswordMessage(attemptsLeft) {
        if (attemptsLeft >= 2) return '密码错误，您还有两次机会。';
        if (attemptsLeft === 1) return '密码错误，您还有一次机会。';
        return '密码错误次数过多';
    }

    function truncatePhoneSignature(str, maxLen) {
        const t = String(str || '')
            .replace(/\r?\n/g, ' ')
            .replace(/^[「"']|[」"']$/g, '')
            .trim();
        const arr = Array.from(t);
        if (arr.length <= maxLen) return t;
        return arr.slice(0, maxLen).join('');
    }

    function parseOneLineFriendWechatFromApi(text) {
        if (!text || typeof text !== 'string') return '';
        let s = text.trim();
        const fence = /```[^\n]*\n([\s\S]*?)```/i.exec(s);
        if (fence) s = fence[1].trim();
        const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l) || '';
        return line.replace(/^[\"「']|[\"」']$/g, '').trim();
    }

    function parsePhoneDesktopSignatureFromApi(text) {
        if (!text || typeof text !== 'string') return '';
        let s = text.trim();
        const fence = /```[^\n]*\n([\s\S]*?)```/i.exec(s);
        if (fence) s = fence[1].trim();
        const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const body = lines.filter((l) => !/^#{1,6}\s/.test(l) && !/^【[^】]+】$/.test(l));
        let out = body.join(' ').trim();
        out = out
            .replace(/^(个性签名|签名|signature)[:：]\s*/i, '')
            .replace(/^[\*"「『]+|[\*"」』]+$/g, '')
            .trim();
        // 模型偶发把角色卡头部吐出来，需兜底清洗
        if (/^basic_info\s*:/i.test(out)) return '';
        return out;
    }

    function isBrokenPhoneDesktopSignatureLine(sig) {
        const s = String(sig || '').trim();
        if (!s) return true;
        if (/^basic_info\s*:/i.test(s)) return true;
        if (/^\w[\w_]*\s*:\s*$/.test(s)) return true;
        if (/^(name|nicknames|age|gender|position|life_status|appearance|personality)\s*[:：]/i.test(s)) return true;
        return false;
    }

    function fallbackSignatureFromFriend(friend) {
        const card = String(friend.roleSetting || friend.role || '').trim();
        if (!card) return 'Stay real.';
        const lines = card.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const pickByKey = (key) => {
            const re = new RegExp(`^${key}\\s*[:：]\\s*(.+)$`, 'i');
            const hit = lines.map((l) => re.exec(l)).find((m) => m && m[1]);
            return hit ? String(hit[1]).trim() : '';
        };
        const preferred =
            pickByKey('core_personality') ||
            pickByKey('overall_impression') ||
            pickByKey('occupation') ||
            pickByKey('voice_traits') ||
            pickByKey('scent');
        if (preferred) return truncatePhoneSignature(preferred, 120) || 'Hey.';
        const one =
            lines.find((l) => !/^basic_info\s*:/i.test(l) && !/^\w[\w_]*\s*:\s*$/.test(l) && !/^\w[\w_]*\s*:\s*/.test(l)) ||
            lines.find((l) => !/^basic_info\s*:/i.test(l) && !/^\w[\w_]*\s*:\s*/.test(l)) ||
            lines[0] ||
            card;
        return truncatePhoneSignature(one.replace(/^#+\s*/, ''), 120) || 'Hey.';
    }

    function stopPhoneLockTimer() {
        if (state.timeTimer) {
            clearInterval(state.timeTimer);
            state.timeTimer = null;
        }
        if (state.pinRefreshTimer) {
            clearInterval(state.pinRefreshTimer);
            state.pinRefreshTimer = null;
        }
    }

    function updatePhoneLockPinRefreshCountdown() {
        const el = document.getElementById('phone-lock-pin-refresh-countdown');
        if (!el || !state.friend) return;
        const fid = String(state.friend.id);
        const first = readPhoneLockFirstUnlockTs(fid);
        if (!first) {
            el.textContent = '首次成功解锁后开始密码刷新倒计时';
            el.classList.add('phone-lock-countdown-wait');
            return;
        }
        el.classList.remove('phone-lock-countdown-wait');
        const end = first + PHONE_LOCK_WEEK_MS;
        const now = Date.now();
        const left = Math.max(0, end - now);
        if (left <= 0) {
            el.textContent = '当前周期已结束，下次进入将刷新密码';
            return;
        }
        const d = Math.floor(left / (24 * 60 * 60 * 1000));
        const h = Math.floor((left % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const m = Math.floor((left % (60 * 60 * 1000)) / (60 * 1000));
        const s = Math.floor((left % (60 * 1000)) / 1000);
        el.textContent = `密码刷新倒计时：${d}天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    function updatePhoneLockClock() {
        const tEl = document.getElementById('phone-lock-time-lg');
        const dEl = document.getElementById('phone-lock-date');
        if (!tEl || !dEl) return;
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        tEl.textContent = `${hh}:${mm}`;
        const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
        dEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${wk}`;
    }

    function ensurePhoneLockKeypad() {
        const host = document.getElementById('phone-lock-keypad');
        if (!host) return;
        host.innerHTML = '';
        const rows = [
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
            ['back', '0', 'del']
        ];
        rows.forEach((row) => {
            row.forEach((key) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'phone-lock-key';
                if (key === 'back') {
                    btn.className += ' phone-lock-key-back';
                    btn.textContent = '返回';
                    btn.setAttribute('aria-label', '返回好友列表');
                    btn.addEventListener('click', () => onPhoneLockKeypadBack());
                } else if (key === 'del') {
                    btn.className += ' phone-lock-key-delete';
                    btn.textContent = '删除';
                    btn.setAttribute('aria-label', '删除');
                    btn.addEventListener('click', () => onPhoneLockKeyDelete());
                } else {
                    btn.textContent = key;
                    btn.addEventListener('click', () => onPhoneLockDigit(key));
                }
                host.appendChild(btn);
            });
        });
    }

    function onPhoneLockKeypadBack() {
        phoneResetToMenu();
        try {
            window.renderPhoneFriendsGrid && window.renderPhoneFriendsGrid();
        } catch (e) {}
    }

    function updatePhonePageHeaderChrome() {
        const btn = document.querySelector('#phone-page .phone-page-refresh-btn');
        const plus = document.getElementById('phone-desktop-plus-btn');
        const right = document.querySelector('#phone-page .phone-page-right-actions');
        if (!btn) return;
        const menuOn = document.getElementById('phone-view-menu')?.classList.contains('phone-view-active');
        const lockOn = document.getElementById('phone-view-lock')?.classList.contains('phone-view-active');
        const deskOn = document.getElementById('phone-view-desktop')?.classList.contains('phone-view-active');
        const appOn = document.getElementById('phone-view-app')?.classList.contains('phone-view-active');
        void menuOn;
        void lockOn;

        const titleText = (document.getElementById('phone-page-title')?.textContent || '').trim();
        const kind = String(state.appKind || '');
        const appRefreshByKind =
            kind === 'wechat' || kind === 'shopping' || kind === 'video' || kind === 'call' || kind === 'assets' || kind === 'darkweb';
        const appRefreshByTitle = ['微信', '购物', '视频', '通话', '资产', '暗网'].includes(titleText);
        const showRefresh = !!appOn && (appRefreshByKind || appRefreshByTitle);
        const showPlus = !!deskOn;
        const showRight = showRefresh || showPlus;

        if (showRefresh) {
            btn.classList.remove('phone-page-refresh-hidden');
            btn.removeAttribute('aria-hidden');
        } else {
            btn.classList.add('phone-page-refresh-hidden');
            btn.setAttribute('aria-hidden', 'true');
            btn.classList.remove('refreshing');
            btn.disabled = false;
        }

        if (plus) {
            if (showPlus) {
                plus.classList.remove('phone-page-refresh-hidden');
                plus.removeAttribute('aria-hidden');
            } else {
                plus.classList.add('phone-page-refresh-hidden');
                plus.setAttribute('aria-hidden', 'true');
            }
        }

        if (right) {
            right.setAttribute('aria-hidden', showRight ? 'false' : 'true');
        }

        const phonePage = document.getElementById('phone-page');
        if (phonePage) {
            const darkwebFullBleed = !!appOn && kind === 'darkweb';
            phonePage.classList.toggle('phone-page-darkweb-fullbleed', darkwebFullBleed);
        }
    }

    function setPhoneViews(menu, lock, desktop) {
        const m = document.getElementById('phone-view-menu');
        const l = document.getElementById('phone-view-lock');
        const d = document.getElementById('phone-view-desktop');
        const a = document.getElementById('phone-view-app');
        const title = document.getElementById('phone-page-title');
        if (m) {
            m.classList.toggle('phone-view-active', !!menu);
            m.setAttribute('aria-hidden', !menu);
        }
        if (l) {
            l.classList.toggle('phone-view-active', !!lock);
            l.setAttribute('aria-hidden', menu || desktop ? 'true' : 'false');
        }
        if (d) {
            d.classList.toggle('phone-view-active', !!desktop);
            d.setAttribute('aria-hidden', !desktop);
        }
        if (a) {
            a.classList.toggle('phone-view-active', !menu && !lock && !desktop);
            a.setAttribute('aria-hidden', menu || lock || desktop ? 'true' : 'false');
        }
        if (title) title.textContent = '手机';
        updatePhonePageHeaderChrome();
    }

    function friendAppTitleByKind(kind) {
        if (kind === 'wechat') return '微信';
        if (kind === 'shopping') return '购物';
        if (kind === 'video') return '视频';
        if (kind === 'call') return '通话';
        if (kind === 'assets') return '资产';
        if (kind === 'darkweb') return '暗网';
        return '应用';
    }

    function setFriendAppBodyHtml(html) {
        const host = document.getElementById('phone-friend-app-body');
        if (!host) return;
        host.innerHTML = html;
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * 好友应用详情正文：修正模型/解析产生的字面量 \\n、BOM、零宽字符与替换符（），避免详情页出现乱符或把 \\n 当普通字显示。
     * 依赖 .friend-app-detail 的 white-space: pre-wrap 展示真实换行。
     */
    function normalizeFriendAppDetailText(s) {
        let t = String(s ?? '');
        t = t.replace(/^\uFEFF/, '');
        t = t.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
        t = t.replace(/\uFFFD/g, '');
        t = t
            .replace(/\\r\\n/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\n')
            .replace(/\\t/g, '\t');
        return t.trim();
    }

    function escapeHtmlDetail(s) {
        return escapeHtml(normalizeFriendAppDetailText(s));
    }

    function withNormalizedFriendWechat(mod, myNickname) {
        const nick = (myNickname || '').trim() || getPhoneFeatureUserProfileNickname();
        if (!mod || !mod.wechat) return mod;
        return { ...mod, wechat: normalizePhoneWechatModuleUserLabels({ ...mod.wechat }, nick) };
    }

    function renderFriendWechatList(mod, myNickname) {
        const modN = withNormalizedFriendWechat(mod, myNickname);
        const people = Array.isArray(modN?.wechat?.people) ? modN.wechat.people : [];
        const rows = people
            .map((p) => {
                const id = String(p.id || '');
                const isUser = !!p.isUser;
                const nm = isUser ? ((myNickname || '').trim() || '我') : (String(p.name || 'Unknown') || 'Unknown');
                const sub = isUser ? '私聊' : '联系人';
                return `<div class="wechat-chat-item" role="button" tabindex="0" data-fapp="wechat-thread" data-with="${escapeHtml(id)}">
  <div class="wechat-chat-content">
    <div class="wechat-chat-header">
      <div class="wechat-chat-name">${escapeHtml(nm)}</div>
      <div class="wechat-chat-time"> </div>
    </div>
    <div class="wechat-chat-message">${escapeHtml(sub)}</div>
  </div>
</div>`;
            })
            .join('');
        return `<div class="phone-wechat-scope"><div class="wechat-chat-list" style="display:flex;flex-direction:column;">${rows || '<div class="friend-app-row-sub">暂无联系人（请点击本页顶部右侧「刷新」生成）</div>'}</div></div>`;
    }

    function normalizeBilingualLine(s) {
        const t = String(s || '').trim();
        if (!t) return '';
        // 允许已经是 "EN (中文)" 的格式直接通过
        if (/\([^)]+\)\s*$/.test(t)) return t;
        return t;
    }

    function renderWechatBubblesFromMessages(messages, myNickname, otherDisplayName) {
        const myName = (myNickname || '我').trim() || '我';
        const otherName = (otherDisplayName || '好友').trim() || '好友';
        const rows = (Array.isArray(messages) ? messages : [])
            .slice(0, 24)
            .map((m) => {
                const side = String(m.side || m.from || '').toLowerCase();
                const isMe = side === 'right' || side === 'me' || side === 'user' || side === 'my';
                const text = normalizeBilingualLine(m.text || m.content || '');
                const name = String(m.name || m.speaker || '').trim();
                const resolvedOther = name || otherName;
                const showName = `<div class="chat-message-name">${escapeHtml(isMe ? myName : resolvedOther)}</div>`;
                return isMe
                    ? `<div class="chat-message my-message">
  <div class="chat-message-content">
    ${showName}
    <div class="chat-message-bubble">${escapeHtml(text)}</div>
  </div>
</div>`
                    : `<div class="chat-message other-message">
  <div class="chat-message-content">
    ${showName}
    <div class="chat-message-bubble">${escapeHtml(text)}</div>
  </div>
</div>`;
            })
            .join('');
        return `<div class="phone-wechat-scope"><div class="chat-content" style="display:flex;flex-direction:column;gap:10px;min-height:0;">${rows || '<div class="friend-app-row-sub">暂无聊天内容（请点击本页顶部右侧「刷新」生成）</div>'}</div></div>`;
    }

    function renderFriendWechatThread(mod, withId, myNickname) {
        const modN = withNormalizedFriendWechat(mod, myNickname);
        const who = String(withId || '');
        const people = Array.isArray(modN?.wechat?.people) ? modN.wechat.people : [];
        const p = people.find((x) => String(x.id) === who);
        const meDisplay = (myNickname || '').trim() || getPhoneFeatureUserProfileNickname();
        const title = p ? (p.isUser ? meDisplay : String(p.name || '聊天')) : '聊天';
        let html = '';
        // 优先结构化 messages → 用真实微信气泡渲染
        if (p && p.isUser && Array.isArray(modN?.wechat?.userThreadMessages)) {
            html = renderWechatBubblesFromMessages(modN.wechat.userThreadMessages, meDisplay, (state.friend?.remark || state.friend?.nickname || '好友'));
        }
        if (!html && Array.isArray(modN?.wechat?.threads)) {
            const t = modN.wechat.threads.find((x) => String(x.with) === who);
            if (t && Array.isArray(t.messages)) {
                html = renderWechatBubblesFromMessages(t.messages, meDisplay, String(p?.name || '好友'));
            } else if (t && typeof t.html === 'string') {
                html = t.html;
            }
        }
        if (!html && p && p.isUser && typeof modN?.wechat?.userThreadHtml === 'string') html = modN.wechat.userThreadHtml;
        if (!html) {
            html = `<div class="friend-app-row-sub">暂无聊天内容（请点击本页顶部右侧「刷新」）</div>`;
        }
        return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="wechat-back">‹ 返回</button>
  <div class="friend-app-row-title">${escapeHtml(title)}</div>
</div>
<div>${html}</div>`;
    }

    function renderFriendShoppingList(mod) {
        const items = Array.isArray(mod?.shopping?.items) ? mod.shopping.items : [];
        const rows = items
            .map((it) => {
                const id = String(it.id || '');
                const nm = String(it.name || '商品');
                const price = String(it.price || '');
                return `<button type="button" class="friend-app-rowbtn" data-fapp="shopping-detail" data-id="${escapeHtml(id)}">
  <span class="friend-app-row-main">
    <span class="friend-app-row-title">${escapeHtml(nm)}</span>
    <span class="friend-app-row-sub">${escapeHtml(price)}</span>
  </span>
  <span aria-hidden="true">›</span>
</button>`;
            })
            .join('');
        return `<div class="friend-app-section-title">购物清单</div>
<div class="friend-app-list">${rows || '<div class="friend-app-row-sub">暂无商品（请点击本页顶部右侧「刷新」生成）</div>'}</div>`;
    }

    function renderFriendShoppingDetail(mod, id) {
        const items = Array.isArray(mod?.shopping?.items) ? mod.shopping.items : [];
        const it = items.find((x) => String(x.id) === String(id));
        if (!it) {
            return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="shopping-back">‹ 返回</button>
</div><div class="friend-app-row-sub">商品不存在</div>`;
        }
        const nm = String(it.name || '商品');
        const price = String(it.price || '');
        const reason = String(it.reason || '');
        return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="shopping-back">‹ 返回</button>
  <div class="friend-app-row-title">${escapeHtml(nm)}</div>
</div>
<div class="friend-app-row-sub">${escapeHtml(price)}</div>
<div class="friend-app-detail">${escapeHtmlDetail(reason || '（暂无原因）')}</div>`;
    }

    function renderFriendVideoGrid(mod) {
        const items = Array.isArray(mod?.video?.items) ? mod.video.items : [];
        const cards = items
            .map((v) => {
                const id = String(v.id || '');
                const title = String(v.title || '视频');
                const tags = Array.isArray(v.tags) ? v.tags : [];
                const tagHtml = tags.slice(0, 6).map((t) => `<span class="friend-app-tag">${escapeHtml(t)}</span>`).join('');
                return `<button type="button" class="friend-app-cardbtn" data-fapp="video-detail" data-id="${escapeHtml(id)}">
  <div class="friend-app-thumb" aria-hidden="true"></div>
  <div class="friend-app-tags"><span class="friend-app-tag">🔞 18+</span>${tagHtml}</div>
  <div class="friend-app-row-title">${escapeHtml(title)}</div>
</button>`;
            })
            .join('');
        const emptyVideoHint =
            '<div class="friend-app-video-empty">' +
            '<div class="friend-app-row-sub friend-app-hint-multiline">暂无视频条目。可先点右上角「刷新」向模型请求生成。</div>' +
            '<div class="friend-app-row-sub friend-app-hint-multiline friend-app-hint-detail">若刷新后仍为空：多半是模型 JSON 里 <code>video.items</code> 为空、键名不对，或正文被截断导致无法解析（后台日志里能看到输出，客户端也可能拿不到合法结构）。请对照指令「仅顶层 video 键」与「入侵好友手机①视频生成规则」检查输出。</div>' +
            '</div>';
        return `<div class="friend-app-section-title">视频浏览</div>
<div class="friend-app-grid">${cards || emptyVideoHint}</div>`;
    }

    function renderFriendVideoDetail(mod, id) {
        const items = Array.isArray(mod?.video?.items) ? mod.video.items : [];
        const v = items.find((x) => String(x.id) === String(id));
        if (!v) {
            return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="video-back">‹ 返回</button>
</div><div class="friend-app-row-sub">视频不存在</div>`;
        }
        const title = String(v.title || '视频');
        const detail = String(v.detail || '');
        return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="video-back">‹ 返回</button>
  <div class="friend-app-row-title">${escapeHtml(title)}</div>
</div>
<div class="friend-app-detail">${escapeHtmlDetail(detail || '（暂无）')}</div>`;
    }

    function renderFriendCallList(mod) {
        const items = Array.isArray(mod?.call?.items) ? mod.call.items : [];
        const rows = items
            .map((c) => {
                const id = String(c.id || '');
                const who = String(c.who || '未知');
                const time = String(c.time || '');
                return `<button type="button" class="friend-app-rowbtn" data-fapp="call-detail" data-id="${escapeHtml(id)}">
  <span class="friend-app-row-main">
    <span class="friend-app-row-title">${escapeHtml(who)}</span>
    <span class="friend-app-row-sub">${escapeHtml(time)}</span>
  </span>
  <span aria-hidden="true">›</span>
</button>`;
            })
            .join('');
        return `<div class="friend-app-section-title">通话记录</div>
<div class="friend-app-list">${rows || '<div class="friend-app-row-sub">暂无通话记录（请点击本页顶部右侧「刷新」生成）</div>'}</div>`;
    }

    function renderFriendCallDetail(mod, id) {
        const items = Array.isArray(mod?.call?.items) ? mod.call.items : [];
        const c = items.find((x) => String(x.id) === String(id));
        if (!c) {
            return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="call-back">‹ 返回</button>
</div><div class="friend-app-row-sub">记录不存在</div>`;
        }
        const who = String(c.who || '通话');
        const script = String(c.script || '');
        return `<div class="friend-app-backline">
  <button type="button" class="friend-app-mini-back" data-fapp="call-back">‹ 返回</button>
  <div class="friend-app-row-title">${escapeHtml(who)}</div>
</div>
<div class="friend-app-detail">${escapeHtmlDetail(script || '（暂无内容）')}</div>`;
    }

    function fmtCurrency(n) {
        const x = Number(n);
        if (!Number.isFinite(x)) return '0.00';
        return x.toFixed(2);
    }

    function renderFriendAssetsView(data) {
        const bank = data && typeof data === 'object' ? data.bank : null;
        const investments = Array.isArray(data?.investments) ? data.investments : [];
        const ledger = Array.isArray(data?.ledger) ? data.ledger : [];

        const bankName = String(bank?.bankName || 'Bank').trim() || 'Bank';
        const last4 = String(bank?.cardLast4 || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
        const currency = String(bank?.currency || 'CNY').trim() || 'CNY';
        const balance = fmtCurrency(bank?.balance);

        const invRows = investments
            .slice(0, 6)
            .map((it) => {
                const nm = String(it?.name || '理财产品').trim() || '理财产品';
                const pnl = Number(it?.pnl);
                const pnlText = Number.isFinite(pnl) ? (pnl >= 0 ? `+${fmtCurrency(pnl)}` : `-${fmtCurrency(Math.abs(pnl))}`) : '0.00';
                const sub = String(it?.type || it?.status || it?.note || '').trim();
                const signClass = Number.isFinite(pnl) && pnl < 0 ? 'friend-assets-loss' : 'friend-assets-profit';
                return `<div class="friend-assets-item">
  <div class="friend-assets-item-main">
    <div class="friend-assets-item-title">${escapeHtml(nm)}</div>
    <div class="friend-assets-item-sub">${escapeHtml(sub || '投资')}</div>
  </div>
  <div class="friend-assets-amt ${signClass}">${escapeHtml(currency)} ${escapeHtml(pnlText)}</div>
</div>`;
            })
            .join('');

        const ledRows = ledger
            .slice(0, 22)
            .map((it) => {
                const time = String(it?.time || '').trim();
                const title = String(it?.title || it?.name || '明细').trim() || '明细';
                const amt = Number(it?.amount);
                const amtText = Number.isFinite(amt) ? (amt >= 0 ? `+${fmtCurrency(amt)}` : `-${fmtCurrency(Math.abs(amt))}`) : '0.00';
                const cp = String(it?.counterparty || '').trim();
                const meta = [time, cp].filter(Boolean).join(' · ');
                const signClass = Number.isFinite(amt) && amt < 0 ? 'friend-assets-loss' : 'friend-assets-profit';
                return `<div class="friend-assets-item">
  <div class="friend-assets-item-main">
    <div class="friend-assets-item-title">${escapeHtml(title)}</div>
    <div class="friend-assets-item-sub">${escapeHtml(meta || ' ')}</div>
  </div>
  <div class="friend-assets-amt ${signClass}">${escapeHtml(currency)} ${escapeHtml(amtText)}</div>
</div>`;
            })
            .join('');

        return `<div class="phone-wechat-scope friend-assets-stack">
  <section class="friend-assets-panel">
    <div class="friend-assets-panel-title">银行卡</div>
    <div class="friend-assets-bankcard" role="group" aria-label="银行卡">
      <div class="friend-assets-bankcard-top">
        <div class="friend-assets-bankname">${escapeHtml(bankName)}</div>
        <div class="friend-assets-chip" aria-hidden="true"></div>
      </div>
      <div class="friend-assets-cardno">••••  ••••  ••••  ${escapeHtml(last4)}</div>
      <div class="friend-assets-balance">
        <span class="friend-assets-currency">${escapeHtml(currency)}</span>
        <span class="friend-assets-balance-num">${escapeHtml(balance)}</span>
      </div>
    </div>
  </section>

  <section class="friend-assets-panel">
    <div class="friend-assets-panel-title">理财投资</div>
    <div class="friend-assets-list">${invRows || '<div class="friend-app-row-sub">暂无理财产品（请点击本页顶部右侧「刷新」）</div>'}</div>
  </section>

  <section class="friend-assets-panel">
    <div class="friend-assets-panel-title">收支明细</div>
    <div class="friend-assets-list">${ledRows || '<div class="friend-app-row-sub">暂无明细（请点击本页顶部右侧「刷新」）</div>'}</div>
  </section>
</div>`;
    }

    const FRIEND_ASSETS_RULE_FALLBACK = `---
【入侵好友手机②资产生成规则】
你将为“好友手机-资产”页面生成结构化数据。目标：界面简洁、真实、可核对，避免夸张财富与流水。

【输出要求｜仅 JSON｜禁止 markdown】
输出一个 JSON 对象，格式如下：
{
  "bank": { "bankName": "银行名", "cardLast4": "4位数字", "currency": "CNY", "balance": 12345.67 },
  "investments": [
    { "name": "产品名", "type": "基金/股票/储蓄/债券/黄金/加密/保险/其他", "pnl": -123.45, "note": "一句简短说明" }
  ],
  "ledger": [
    { "time": "昨天 19:20", "title": "条目标题", "amount": -88.00, "counterparty": "可选对方", "category": "购物/工资/转账/餐饮/交通/住房/娱乐/其他" }
  ]
}

【硬性约束】
1) bankName 必须贴合好友国家/职业/生活圈（例如俄国人优先俄国主流银行名；不要使用明显不匹配的本地梗）。
2) balance 为银行卡“现有存款”，合理范围：不要离谱暴富/负数；保留小数两位。
3) investments 生成 3~6 条：允许亏损；pnl 表示盈亏金额（可正可负）；并确保“正收益的绝对值总和”不超过 bank.balance。
4) ledger 生成 12~22 条：必须混合以下类型：
   - 真实日常支出（餐饮/交通/购物等）
   - 工资/稿费/项目款等收入（amount 为正）
   - 转账（收/付都要有，amount 正=收，负=付）
5) ledger 里若出现“购物”，标题要像真实订单（可引用购物页常见品类/商品名），金额不要夸张；避免重复同一个标题。
6) 所有数字必须自洽、可读；不要写“约/大概/可能”这类含糊词。
`;

    function buildPhoneFriendAssetsPrompt(friend) {
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        const emojiData = typeof parseJsonFromPossiblyEncodedStorage === 'function'
            ? parseJsonFromPossiblyEncodedStorage(typeof EMOJI_DATA_LS_KEY !== 'undefined' ? EMOJI_DATA_LS_KEY : 'emojiData', {})
            : {};
        let allEmojis = [];
        if (emojiData && typeof emojiData === 'object') {
            Object.keys(emojiData).forEach((k) => {
                allEmojis = allEmojis.concat(emojiData[k] || []);
            });
        }
        const fmt = (c) => (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c);
        const hist = getMomentsChatHistoryLines(friend.id, 10, fmt);

        const parts = [];
        CommandManager.getCoreCommands().forEach((cmd) => parts.push(cmd.content));
        const wb = buildPhoneFeatureWorldBooksBlock(friend);
        if (wb) parts.push(wb);

        const displayName = ((friend.remark || friend.nickname || '好友').trim() || '好友');
        const userRoleExtra =
            myProfile && (myProfile.roleSetting || myProfile.role) ? String(myProfile.roleSetting || myProfile.role).trim() : '';

        parts.push(`---
【好友 ${displayName}】角色卡
${friend.roleSetting || friend.role || '无'}

【用户人设卡】
昵称: ${myProfile?.nickname || '未设置'}
身份: ${myProfile?.identity || '未设置'}
${userRoleExtra ? `补充:\n${userRoleExtra}` : ''}
`);

        parts.push(`---
【你与 ${displayName} 的最近聊天记录（至多 10 轮）】
${hist || '（暂无）'}
`);

        const ruleCmd =
            typeof CommandManager?.getAllCommands === 'function'
                ? (CommandManager.getAllCommands() || []).find((c) => c && c.active && String(c.name || '').trim() === '入侵好友手机②资产生成规则')
                : null;
        const rule = ruleCmd && ruleCmd.content ? String(ruleCmd.content) : FRIEND_ASSETS_RULE_FALLBACK;
        parts.push(rule);
        return parts.filter(Boolean).join('\n');
    }

    async function refreshFriendAssets(friend) {
        if (!friend) return null;
        const prompt = buildPhoneFriendAssetsPrompt(friend);
        const raw = await FeatureCommandMapper.callApiModel(prompt, null, {
            skipOverlay: true,
            suppressErrorDialog: true,
            apiRetry: true
        });
        const data = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(raw || '') : null;
        if (!data || typeof data !== 'object') return null;
        writeFriendAssets(String(friend.id), data);
        return data;
    }

    /** 好友应用内点击委托（暗网等模块 innerHTML 替换后仍挂在同一容器上，只需绑定一次） */
    function ensurePhoneFriendAppBodyClickBound(myNickname) {
        const host = document.getElementById('phone-friend-app-body');
        if (!host || host.dataset.bound === '1') return;
        host.dataset.bound = '1';
        host.addEventListener('click', (e) => {
            const el = e.target.closest('[data-fapp]');
            if (!el) return;
            const act = el.getAttribute('data-fapp');
            const id = el.getAttribute('data-id');
            const withId = el.getAttribute('data-with');
            if (act === 'wechat-thread' || act === 'wechat-back') {
                const mod2 = readFriendModuleWrapped(state.friend.id, 'wechat');
                if (!mod2) return;
                if (act === 'wechat-thread') {
                    setFriendAppBodyHtml(renderFriendWechatThread(mod2, withId, myNickname));
                } else {
                    setFriendAppBodyHtml(renderFriendWechatList(mod2, myNickname));
                }
            } else if (act === 'shopping-detail' || act === 'shopping-back') {
                const mod2 = readFriendModuleWrapped(state.friend.id, 'shopping');
                if (!mod2) return;
                if (act === 'shopping-detail') {
                    setFriendAppBodyHtml(renderFriendShoppingDetail(mod2, id));
                } else {
                    setFriendAppBodyHtml(renderFriendShoppingList(mod2));
                }
            } else if (act === 'video-detail' || act === 'video-back') {
                const mod2 = readFriendModuleWrapped(state.friend.id, 'video');
                if (!mod2) return;
                if (act === 'video-detail') {
                    setFriendAppBodyHtml(renderFriendVideoDetail(mod2, id));
                } else {
                    setFriendAppBodyHtml(renderFriendVideoGrid(mod2));
                }
            } else if (act === 'call-detail' || act === 'call-back') {
                const mod2 = readFriendModuleWrapped(state.friend.id, 'call');
                if (!mod2) return;
                if (act === 'call-detail') {
                    setFriendAppBodyHtml(renderFriendCallDetail(mod2, id));
                } else {
                    setFriendAppBodyHtml(renderFriendCallList(mod2));
                }
            } else if (String(act || '').indexOf('darkweb-') === 0) {
                if (globalThis.FriendDarkWeb && typeof globalThis.FriendDarkWeb.handleAction === 'function') {
                    globalThis.FriendDarkWeb.handleAction(act, el);
                }
            }
        });
    }

    function openFriendApp(kind) {
        if (!state.friend) return;
        state.appKind = String(kind || '');
        setPhoneViews(false, false, false);
        const title = document.getElementById('phone-page-title');
        if (title) title.textContent = friendAppTitleByKind(kind);
        updatePhonePageHeaderChrome();
        const myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        const myNickname = String(myProfile?.nickname || '').trim();
        if (kind === 'assets') {
            const cached = readFriendAssets(state.friend.id);
            if (cached) {
                setFriendAppBodyHtml(renderFriendAssetsView(cached));
                return;
            }
            setFriendAppBodyHtml(`<div class="friend-app-row-sub">正在生成资产内容…</div>`);
            showLoading();
            (async () => {
                try {
                    const data = await refreshFriendAssets(state.friend);
                    if (data) setFriendAppBodyHtml(renderFriendAssetsView(data));
                    else setFriendAppBodyHtml(`<div class="friend-app-row-sub">生成失败（请点顶部右侧「刷新」重试）</div>`);
                } finally {
                    hideLoading();
                }
            })();
            return;
        }
        if (kind === 'darkweb') {
            if (globalThis.FriendDarkWeb && typeof globalThis.FriendDarkWeb.openApp === 'function') {
                globalThis.FriendDarkWeb.openApp();
            } else {
                setFriendAppBodyHtml(`<div class="friend-app-row-sub">暗网模块未加载</div>`);
            }
            ensurePhoneFriendAppBodyClickBound(myNickname);
            return;
        }

        const mod = readFriendModuleWrapped(state.friend.id, kind);
        if (!mod) {
            setFriendAppBodyHtml(`<div class="friend-app-row-sub">该板块暂无缓存。请点击本页顶部右侧「刷新」向模型生成内容。</div>`);
            return;
        }
        if (kind === 'wechat') {
            setFriendAppBodyHtml(renderFriendWechatList(mod, myNickname));
        } else if (kind === 'shopping') {
            setFriendAppBodyHtml(renderFriendShoppingList(mod));
        } else if (kind === 'video') {
            setFriendAppBodyHtml(renderFriendVideoGrid(mod));
        } else if (kind === 'call') {
            setFriendAppBodyHtml(renderFriendCallList(mod));
        } else {
            setFriendAppBodyHtml(`<div class="friend-app-row-sub">未知应用</div>`);
        }
        ensurePhoneFriendAppBodyClickBound(myNickname);
    }

    function abortPhoneLockFetch() {
        if (state.lockController) {
            try {
                state.lockController.abort();
            } catch (e) {}
            state.lockController = null;
        }
    }

    /** 锁屏密码提示文案：同时写新/旧 id，并用 .phone-lock-hint 兜底，避免缓存旧脚本或改版 HTML 后节点对不上 */
    function setPhoneLockPwdHintDisplay(text) {
        let hit = false;
        ['phone-lock-pwd-hint', 'phone-lock-name'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = text;
                hit = true;
            }
        });
        if (!hit) {
            const fb = document.querySelector('#phone-view-lock .phone-lock-hint');
            if (fb) fb.textContent = text;
        }
    }

    const PHONE_DESKTOP_REFRESH_TARGETS = [
        { key: 'signature', label: '签名', hint: '刷新顶部主卡片签名' },
        { key: 'wechat', label: '微信', hint: '联系人、会话与私聊截取' },
        { key: 'shopping', label: '购物', hint: '商品列表与详情原因' },
        { key: 'video', label: '视频', hint: '视频条目与详情内容' },
        { key: 'assets', label: '资产', hint: '银行卡、理财与收支明细' },
        { key: 'call', label: '通话', hint: '通话记录与剧本详情' },
        { key: 'darkweb', label: '暗网', hint: '论坛首页/当前暗网内容' }
    ];

    function ensurePhoneDesktopRefreshModal() {
        let modal = document.getElementById('phone-desktop-refresh-modal');
        if (modal) return modal;
        modal = document.createElement('div');
        modal.id = 'phone-desktop-refresh-modal';
        modal.className = 'modal phone-desktop-refresh-modal';
        modal.innerHTML = `
<div class="modal-content phone-desktop-refresh-card" role="dialog" aria-modal="true" aria-labelledby="phone-desktop-refresh-title">
  <div class="phone-desktop-refresh-head">
    <div>
      <h3 id="phone-desktop-refresh-title">刷新功能</h3>
      <p id="phone-desktop-refresh-desc">选择要重新生成的好友手机功能。</p>
    </div>
    <button type="button" class="phone-desktop-refresh-close" aria-label="关闭">×</button>
  </div>
  <div class="phone-desktop-refresh-list" id="phone-desktop-refresh-list"></div>
  <div class="phone-desktop-refresh-foot">
    <button type="button" class="phone-desktop-refresh-secondary" data-action="cancel">取消</button>
    <button type="button" class="phone-desktop-refresh-primary" data-action="confirm">确定</button>
  </div>
</div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal || e.target.closest('.phone-desktop-refresh-close') || e.target.dataset.action === 'cancel') {
                closePhoneDesktopRefreshModal();
                return;
            }
            if (e.target.dataset.action === 'confirm') {
                void confirmPhoneDesktopRefreshSelection();
            }
        });
        return modal;
    }

    function renderPhoneDesktopRefreshOptions() {
        const modal = ensurePhoneDesktopRefreshModal();
        const desc = modal.querySelector('#phone-desktop-refresh-desc');
        if (desc) {
            const friendName = ((state.friend?.remark || state.friend?.nickname || '好友').trim() || '好友');
            desc.textContent = `选择要重新生成的 ${friendName} 手机功能。`;
        }
        const list = modal.querySelector('#phone-desktop-refresh-list');
        if (!list) return;
        list.innerHTML = PHONE_DESKTOP_REFRESH_TARGETS.map((item) => `
<label class="phone-desktop-refresh-option">
  <input type="checkbox" value="${escapeHtml(item.key)}">
  <span class="phone-desktop-refresh-check" aria-hidden="true"></span>
  <span class="phone-desktop-refresh-copy">
    <strong>${escapeHtml(item.label)}</strong>
    <small>${escapeHtml(item.hint)}</small>
  </span>
</label>`).join('');
    }

    function openPhoneDesktopRefreshModal() {
        if (!state.friend) {
            showNotification('请先进入好友手机桌面');
            return;
        }
        renderPhoneDesktopRefreshOptions();
        ensurePhoneDesktopRefreshModal().classList.add('show');
    }

    function closePhoneDesktopRefreshModal() {
        const modal = document.getElementById('phone-desktop-refresh-modal');
        if (modal) modal.classList.remove('show');
    }

    function setPhoneDesktopRefreshButtonBusy(busy) {
        const btn = document.getElementById('phone-desktop-plus-btn');
        if (!btn) return;
        btn.classList.toggle('phone-desktop-plus-busy', !!busy);
        btn.disabled = !!busy;
        if (busy) {
            btn.setAttribute('aria-busy', 'true');
            btn.setAttribute('title', '正在刷新');
            btn.setAttribute('aria-label', '正在刷新');
        } else {
            btn.removeAttribute('aria-busy');
            btn.setAttribute('title', '刷新功能');
            btn.setAttribute('aria-label', '刷新功能');
        }
    }

    function waitPhoneDesktopRefreshPaint() {
        return new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
    }

    function getPhoneDesktopRefreshBuilder(sectionKey) {
        if (sectionKey === 'wechat') return buildPhoneDesktopModuleWechatPrompt;
        if (sectionKey === 'shopping') return buildPhoneDesktopModuleShoppingPrompt;
        if (sectionKey === 'video') return buildPhoneDesktopModuleVideoPrompt;
        if (sectionKey === 'call') return buildPhoneDesktopModuleCallPrompt;
        return null;
    }

    async function refreshPhoneDesktopTarget(friend, key) {
        const target = PHONE_DESKTOP_REFRESH_TARGETS.find((it) => it.key === key);
        const label = target ? target.label : key;
        try {
            if (!friend || !key) return { ok: false, label: key || '', message: '缺少刷新目标' };
            if (key === 'signature') {
                await refreshPhoneDesktopSignature(friend, { forceRefresh: true });
                return { ok: true, label };
            }
            if (key === 'assets') {
                const data = await refreshFriendAssets(friend);
                return data ? { ok: true, label } : { ok: false, label, message: '资产生成失败' };
            }
            if (key === 'darkweb') {
                if (globalThis.FriendDarkWeb && typeof globalThis.FriendDarkWeb.refreshFeed === 'function') {
                    await globalThis.FriendDarkWeb.refreshFeed();
                    return { ok: true, label };
                }
                return { ok: false, label, message: '暗网模块未加载' };
            }
            const builder = getPhoneDesktopRefreshBuilder(key);
            if (builder) {
                const res = await refreshPhoneDesktopModuleByKey(friend, key, builder);
                return res.ok ? { ok: true, label, message: res.warn || '' } : { ok: false, label, message: res.brief || '刷新失败' };
            }
            return { ok: false, label, message: '未知功能' };
        } catch (e) {
            return { ok: false, label, message: '刷新异常' };
        }
    }

    async function confirmPhoneDesktopRefreshSelection() {
        const modal = ensurePhoneDesktopRefreshModal();
        const checks = Array.from(modal.querySelectorAll('#phone-desktop-refresh-list input[type="checkbox"]:checked'));
        const keys = checks.map((el) => el.value).filter(Boolean);
        if (!keys.length) {
            showNotification('请至少选择一个功能');
            return;
        }
        const friend = state.friend;
        closePhoneDesktopRefreshModal();
        if (!friend) return;
        setPhoneDesktopRefreshButtonBusy(true);
        showLoading();
        const results = [];
        try {
            for (const key of keys) {
                results.push(await refreshPhoneDesktopTarget(friend, key));
            }
        } finally {
            hideLoading();
            await waitPhoneDesktopRefreshPaint();
            setPhoneDesktopRefreshButtonBusy(false);
        }
        const ok = results.filter((r) => r.ok).map((r) => r.label);
        const fail = results.filter((r) => !r.ok).map((r) => r.label);
        if (fail.length) {
            showNotification(`已刷新：${ok.join('、') || '无'}；失败：${fail.join('、')}`);
        } else {
            showNotification(`已刷新：${ok.join('、')}`);
        }
    }

    function ensurePhoneDesktopPlusButtonReady() {
        const btn = document.getElementById('phone-desktop-plus-btn');
        if (!btn) return;
        if (btn.dataset && btn.dataset.bound === '1') return;
        if (btn.dataset) btn.dataset.bound = '1';
        btn.addEventListener('click', () => {
            if (btn.classList.contains('phone-desktop-plus-busy') || btn.disabled) return;
            openPhoneDesktopRefreshModal();
        });
    }

    window.phoneResetToMenu = function () {
        abortPhoneLockFetch();
        stopPhoneLockTimer();
        state.friendId = null;
        state.friend = null;
        state.expectedPin = '';
        state.attemptsLeft = 3;
        state.input = '';
        state.forcePrompted = false;
        setPhoneViews(true, false, false);
        const dots = document.querySelectorAll('.phone-lock-dot');
        dots.forEach((d) => d.classList.remove('filled'));
        const atEl = document.getElementById('phone-lock-attempts');
        if (atEl) atEl.textContent = '';
        const cdEl = document.getElementById('phone-lock-pin-refresh-countdown');
        if (cdEl) {
            cdEl.textContent = '';
            cdEl.classList.remove('phone-lock-countdown-wait');
        }
        setPhoneLockPwdHintDisplay('');
        const lockEl = document.getElementById('phone-view-lock');
        if (lockEl) lockEl.classList.remove('shake');
    };

    function onPhoneLockKeyDelete() {
        if (state.input.length < 1) return;
        state.input = state.input.slice(0, -1);
        refreshPhoneLockDots();
    }

    function onPhoneLockDigit(d) {
        if (state.input.length >= 4) return;
        state.input += d;
        refreshPhoneLockDots();
        if (state.input.length === 4) {
            setTimeout(() => checkPhoneLockPin(), 80);
        }
    }

    function refreshPhoneLockDots() {
        const dots = document.querySelectorAll('.phone-lock-dot');
        dots.forEach((el, i) => {
            el.classList.toggle('filled', i < state.input.length);
        });
    }

    function checkPhoneLockPin() {
        if (!state.friend || !state.expectedPin) return;
        if (state.input === state.expectedPin) {
            state.input = '';
            refreshPhoneLockDots();
            stopPhoneLockTimer();
            // 记录“首次成功解锁好友手机”的时间锚点：用于按周更新锁屏密码
            try {
                const fid = String(state.friend.id);
                const existing = readPhoneLockFirstUnlockTs(fid);
                if (!existing) writePhoneLockFirstUnlockTs(fid, Date.now());
            } catch (e) {}
            void showPhoneFriendDesktop(state.friend);
            return;
        }
        state.attemptsLeft -= 1;
        state.input = '';
        refreshPhoneLockDots();
        const lockEl = document.getElementById('phone-view-lock');
        if (lockEl) {
            lockEl.classList.remove('shake');
            void lockEl.offsetWidth;
            lockEl.classList.add('shake');
        }
        const atEl = document.getElementById('phone-lock-attempts');
        if (atEl) {
            atEl.textContent = formatPhoneLockWrongPasswordMessage(state.attemptsLeft);
        }
        if (state.attemptsLeft <= 0) {
            if (state.forcePrompted) return;
            state.forcePrompted = true;
            const friend = state.friend;
            let ok = false;
            try {
                ok = window.confirm('密码连续输错 3 次。\n\n是否强行入侵并打开好友手机桌面？');
            } catch (e) {
                ok = false;
            }
            // “好友发消息”保持不变：无论用户选什么，都照常生成并写入聊天
            // 但不在这里强制重置页面，避免打断弹框/跳转
            void sendPhoneIntruderWechatMessage(friend, { resetToMenu: false });
            if (ok) {
                state.input = '';
                refreshPhoneLockDots();
                stopPhoneLockTimer();
                void showPhoneFriendDesktop(friend);
            } else {
                phoneResetToMenu();
            }
        }
    }

    async function sendPhoneIntruderWechatMessage(friend, opts) {
        if (!friend) return;
        const resetToMenu = !(opts && opts.resetToMenu === false);
        const prompt = buildPhoneIntruderWechatPrompt(friend);
        showLoading();
        let raw = null;
        try {
            raw = await FeatureCommandMapper.callApiModel(prompt, null, {
                skipOverlay: true,
                suppressErrorDialog: true
            });
        } catch (e) {
            raw = null;
        } finally {
            hideLoading();
        }
        const msg = parseOneLineFriendWechatFromApi(raw) || '喂，你是不是在开我手机？干嘛呢。';
        const ts = Date.now();
        saveChatMessage(friend.id, 'friend', msg, null, ts, null, null, { messageMode: 'online' });
        try {
            scheduleLoadChatList();
        } catch (e) {}
        showNotification(`${(friend.remark || friend.nickname || '好友').trim() || '好友'}发来一条消息`);
        if (resetToMenu) phoneResetToMenu();
    }

    async function fetchPhoneLockPin(friend, opts) {
        const idStr = String(friend.id);
        const forceRefresh = !!opts?.forceRefresh;

        // 1) 内存缓存（同一会话内避免重复调用）
        if (PHONE_LOCK_PIN_CACHE.has(idStr)) {
            const cached = PHONE_LOCK_PIN_CACHE.get(idStr);
            if (
                cached &&
                typeof cached === 'object' &&
                cached._sch === PHONE_LOCK_CACHE_SCHEMA &&
                String(cached.pin || '').length === 4
            ) {
                const hint = normalizePhoneLockHint(cached.hint, friend);
                return { pin: cached.pin, hint };
            }
        }

        // 2) 本地持久化缓存：跨刷新/重启复用，避免反复扣额度
        //    规则：以“首次成功解锁时间”为锚点，每满 7 天才允许自动更新一次 PIN
        if (!forceRefresh) {
            const firstUnlockTs = readPhoneLockFirstUnlockTs(idStr);
            const cachedLs = readPhoneLockPinCacheFromStorage(idStr);
            if (cachedLs) {
                const hint = normalizePhoneLockHint(cachedLs.hint, friend);
                // 尚未成功解锁过：也先复用缓存，避免反复触发生成（直到用户真正解锁）
                if (!firstUnlockTs) {
                    PHONE_LOCK_PIN_CACHE.set(idStr, { _sch: PHONE_LOCK_CACHE_SCHEMA, pin: cachedLs.pin, hint });
                    return { pin: cachedLs.pin, hint };
                }
                // 距离首次解锁 < 7 天：一律复用（不调用模型）
                const now = Date.now();
                if (now < firstUnlockTs + PHONE_LOCK_WEEK_MS) {
                    PHONE_LOCK_PIN_CACHE.set(idStr, { _sch: PHONE_LOCK_CACHE_SCHEMA, pin: cachedLs.pin, hint });
                    return { pin: cachedLs.pin, hint };
                }
                // 到期：继续走下方模型生成
            }
        }
        const prompt = buildPhoneLockPasswordPrompt(friend);
        state.lockController = new AbortController();
        const raw = await FeatureCommandMapper.callApiModel(prompt, state.lockController, {
            skipOverlay: true,
            suppressErrorDialog: true,
            apiRetry: true
        });
        state.lockController = null;
        const parsed = parsePhoneLockPinAndHintFromApiText(raw || '');
        if (parsed.pin.length !== 4) return { pin: '', hint: '' };
        const hint = normalizePhoneLockHint(parsed.hint, friend);
        PHONE_LOCK_PIN_CACHE.set(idStr, { _sch: PHONE_LOCK_CACHE_SCHEMA, pin: parsed.pin, hint });
        writePhoneLockPinCacheToStorage(idStr, { pin: parsed.pin, hint });

        // 满 7 天后由 API 换新 PIN：清除「首次解锁」锚点，新周期仍从**下一次首次解锁成功**起计时
        let generatedNewPin = false;
        if (!forceRefresh) {
            const firstUnlockTs2 = readPhoneLockFirstUnlockTs(idStr);
            if (firstUnlockTs2 && Date.now() >= firstUnlockTs2 + PHONE_LOCK_WEEK_MS) {
                clearPhoneLockFirstUnlockTs(idStr);
            }
        }
        generatedNewPin = true;
        if (generatedNewPin) {
            void fetchPhoneDesktopSignature(friend, { forceRefresh: true, silent: true });
        }
        return { pin: parsed.pin, hint };
    }

    async function fetchPhoneDesktopSignature(friend, opts) {
        const idStr = String(friend.id);
        const forceRefresh = !!opts?.forceRefresh;
        const currentLockPinTs = getPhoneLockPinCacheTs(idStr);
        if (!forceRefresh && PHONE_SIG_CACHE.has(idStr)) {
            const cached = PHONE_SIG_CACHE.get(idStr);
            if (cached && typeof cached === 'object') {
                const samePinCycle = !currentLockPinTs || cached.lockPinTs === currentLockPinTs;
                if (cached.sig && samePinCycle) return cached.sig;
            }
        }
        if (!forceRefresh) {
            const meta = readPhoneFriendSignatureMeta(idStr);
            const samePinCycle = !currentLockPinTs || meta.lockPinTs === currentLockPinTs;
            if (meta.sig && samePinCycle && !isBrokenPhoneDesktopSignatureLine(meta.sig)) {
                PHONE_SIG_CACHE.set(idStr, { sig: meta.sig, lockPinTs: meta.lockPinTs || currentLockPinTs });
                return meta.sig;
            }
        }
        const prompt = buildPhoneDesktopSignaturePrompt(friend);
        const raw = await FeatureCommandMapper.callApiModel(prompt, null, {
            skipOverlay: true,
            suppressErrorDialog: true
        });
        const line = truncatePhoneSignature(parsePhoneDesktopSignatureFromApi(raw), 100);
        const sig = !isBrokenPhoneDesktopSignatureLine(line) ? line : fallbackSignatureFromFriend(friend);
        const lockPinTs = getPhoneLockPinCacheTs(idStr);
        PHONE_SIG_CACHE.set(idStr, { sig, lockPinTs });
        writePhoneFriendSignature(idStr, sig, { lockPinTs });
        return sig;
    }

    async function refreshPhoneDesktopSignature(friend, opts) {
        if (!friend) return '';
        try {
            const sig = await fetchPhoneDesktopSignature(friend, opts || {});
            if (state.friend && String(state.friend.id) === String(friend.id)) {
                const sigEl = document.getElementById('phone-desktop-signature');
                if (sigEl && sig) sigEl.textContent = sig;
            }
            return sig;
        } catch (e) {
            if (!(opts && opts.silent) && typeof showNotification === 'function') {
                showNotification('签名刷新失败，请稍后重试');
            }
            return '';
        }
    }

    async function showPhoneFriendDesktop(friend) {
        setPhoneViews(false, false, true);
        state.friend = friend;
        state.friendId = friend?.id ?? null;
        ensurePhoneDesktopPlusButtonReady();

        const av = document.getElementById('phone-desktop-avatar');
        const nm = document.getElementById('phone-desktop-name');
        const sigEl = document.getElementById('phone-desktop-signature');
        const url = friend.avatar || '';
        if (av) {
            av.src = url || '';
            av.alt = (friend.remark || friend.nickname || '').trim() || '好友';
        }
        if (nm) nm.textContent = (friend.remark || friend.nickname || '好友').trim() || '好友';
        // 签名与锁屏密码同周期：无缓存或密码已换新时，进入桌面后静默更新一次。
        if (sigEl) {
            const staleSig = isPhoneFriendSignatureStaleForPin(friend.id);
            const cachedSig = readPhoneFriendSignature(friend.id);
            sigEl.textContent = !isBrokenPhoneDesktopSignatureLine(cachedSig) ? cachedSig : fallbackSignatureFromFriend(friend);
            if (staleSig || !cachedSig) {
                void refreshPhoneDesktopSignature(friend, { forceRefresh: staleSig, silent: true });
            }
        }

        const grid = document.getElementById('phone-desktop-grid');
        if (grid) {
            const fid = friend.id;
            const name = ((friend.remark || friend.nickname || '好友').trim() || '好友');
            grid.innerHTML = `
<button type="button" class="phone-desktop-app" data-action="wechat">
  <span class="phone-desktop-app-icon">微</span>
  <span class="phone-desktop-app-label">微信</span>
</button>
<button type="button" class="phone-desktop-app" data-action="shopping">
  <span class="phone-desktop-app-icon">购</span>
  <span class="phone-desktop-app-label">购物</span>
</button>
<button type="button" class="phone-desktop-app" data-action="video">
  <span class="phone-desktop-app-icon">▶</span>
  <span class="phone-desktop-app-label">视频</span>
</button>
<button type="button" class="phone-desktop-app" data-action="darkweb">
  <span class="phone-desktop-app-icon">暗</span>
  <span class="phone-desktop-app-label">暗网</span>
</button>
<button type="button" class="phone-desktop-app" data-action="wallet">
  <span class="phone-desktop-app-icon">¥</span>
  <span class="phone-desktop-app-label">资产</span>
</button>
<button type="button" class="phone-desktop-app" data-action="call">
  <span class="phone-desktop-app-icon">☎</span>
  <span class="phone-desktop-app-label">通话</span>
</button>`;
            grid.querySelectorAll('.phone-desktop-app').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const act = btn.getAttribute('data-action');
                    if (act === 'wechat') {
                        openFriendApp('wechat');
                    } else if (act === 'shopping') {
                        openFriendApp('shopping');
                    } else if (act === 'video') {
                        openFriendApp('video');
                    } else if (act === 'darkweb') {
                        openFriendApp('darkweb');
                    } else if (act === 'wallet') {
                        openFriendApp('assets');
                    } else if (act === 'call') {
                        openFriendApp('call');
                    }
                });
            });
        }
    }

    window.phonePageHeaderRefresh = async function () {
        const menuOn = document.getElementById('phone-view-menu')?.classList.contains('phone-view-active');
        const lockOn = document.getElementById('phone-view-lock')?.classList.contains('phone-view-active');
        const deskOn = document.getElementById('phone-view-desktop')?.classList.contains('phone-view-active');
        const appOn = document.getElementById('phone-view-app')?.classList.contains('phone-view-active');
        const titleText = (document.getElementById('phone-page-title')?.textContent || '').trim();
        const btn = document.querySelector('#phone-page .phone-page-refresh-btn');
        if (btn && !btn.classList.contains('phone-page-refresh-hidden')) {
            btn.classList.add('refreshing');
            btn.disabled = true;
        }
        if (menuOn) {
            try {
                window.renderPhoneFriendsGrid && window.renderPhoneFriendsGrid();
            } catch (e) {}
            showNotification('已刷新好友列表');
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (!state.friend) return;
        if (lockOn) {
            // 更严格：刷新按钮绝不触发锁屏密码更新（也不清理缓存/不调用模型）
            state.attemptsLeft = 3;
            state.input = '';
            state.forcePrompted = false;
            refreshPhoneLockDots();
            const atEl = document.getElementById('phone-lock-attempts');
            if (atEl) atEl.textContent = '';
            let hint = '';
            try {
                const cached = readPhoneLockPinCacheFromStorage(String(state.friend.id));
                hint = cached ? normalizePhoneLockHint(cached.hint, state.friend) : '';
                if (!state.expectedPin && cached?.pin) state.expectedPin = cached.pin;
            } catch (e) {
                hint = '';
            }
            setPhoneLockPwdHintDisplay(hint || fallbackPhoneLockHint(state.friend));
            updatePhoneLockPinRefreshCountdown();
            showNotification('已重置输入次数');
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        const kind = String(state.appKind || '');
        if (appOn && (kind === 'assets' || titleText === '资产')) {
            showLoading();
            try {
                const data = await refreshFriendAssets(state.friend);
                if (data) {
                    setFriendAppBodyHtml(renderFriendAssetsView(data));
                    showNotification('已刷新资产内容');
                } else {
                    showNotification('刷新失败，请稍后重试');
                }
            } finally {
                hideLoading();
            }
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (appOn && (kind === 'wechat' || titleText === '微信')) {
            showLoading();
            try {
                const res = await refreshPhoneDesktopModuleByKey(state.friend, 'wechat', buildPhoneDesktopModuleWechatPrompt);
                if (!res.ok) {
                    try {
                        if (typeof showErrorDialog === 'function') showErrorDialog('好友手机 · 微信刷新未完成', res.detail || '');
                    } catch (e) {}
                    showNotification(res.brief || '刷新失败，请稍后重试');
                } else {
                    showNotification(res.warn ? '已刷新：' + res.warn : '已刷新微信内容');
                    openFriendApp('wechat');
                }
            } finally {
                hideLoading();
            }
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (appOn && (kind === 'shopping' || titleText === '购物')) {
            showLoading();
            try {
                const res = await refreshPhoneDesktopModuleByKey(state.friend, 'shopping', buildPhoneDesktopModuleShoppingPrompt);
                if (!res.ok) {
                    try {
                        if (typeof showErrorDialog === 'function') showErrorDialog('好友手机 · 购物刷新未完成', res.detail || '');
                    } catch (e) {}
                    showNotification(res.brief || '刷新失败，请稍后重试');
                } else {
                    showNotification(res.warn ? '已刷新：' + res.warn : '已刷新购物内容');
                    openFriendApp('shopping');
                }
            } finally {
                hideLoading();
            }
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (appOn && (kind === 'video' || titleText === '视频')) {
            showLoading();
            try {
                const res = await refreshPhoneDesktopModuleByKey(state.friend, 'video', buildPhoneDesktopModuleVideoPrompt);
                if (!res.ok) {
                    try {
                        if (typeof showErrorDialog === 'function') showErrorDialog('好友手机 · 视频刷新未完成', res.detail || '');
                    } catch (e) {}
                    showNotification(res.brief || '刷新失败，请稍后重试');
                } else {
                    showNotification(res.warn ? '已刷新：' + res.warn : '已刷新视频内容');
                    openFriendApp('video');
                }
            } finally {
                hideLoading();
            }
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (appOn && (kind === 'call' || titleText === '通话')) {
            showLoading();
            try {
                const res = await refreshPhoneDesktopModuleByKey(state.friend, 'call', buildPhoneDesktopModuleCallPrompt);
                if (!res.ok) {
                    try {
                        if (typeof showErrorDialog === 'function') showErrorDialog('好友手机 · 通话刷新未完成', res.detail || '');
                    } catch (e) {}
                    showNotification(res.brief || '刷新失败，请稍后重试');
                } else {
                    showNotification(res.warn ? '已刷新：' + res.warn : '已刷新通话记录');
                    openFriendApp('call');
                }
            } finally {
                hideLoading();
            }
            if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            return;
        }
        if (appOn && (kind === 'darkweb' || titleText === '暗网')) {
            try {
                if (globalThis.FriendDarkWeb && typeof globalThis.FriendDarkWeb.refreshFeed === 'function') {
                    await globalThis.FriendDarkWeb.refreshFeed();
                }
            } finally {
                if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
            }
            return;
        }
        if (btn) { btn.classList.remove('refreshing'); btn.disabled = false; }
    };

    window.phonePageHeaderBack = function () {
        const lockOn = document.getElementById('phone-view-lock')?.classList.contains('phone-view-active');
        const deskOn = document.getElementById('phone-view-desktop')?.classList.contains('phone-view-active');
        const appOn = document.getElementById('phone-view-app')?.classList.contains('phone-view-active');
        if (lockOn || deskOn) {
            phoneResetToMenu();
            try {
                window.renderPhoneFriendsGrid && window.renderPhoneFriendsGrid();
            } catch (e) {}
            return;
        }
        if (appOn) {
            if (state.friend) {
                setPhoneViews(false, false, true);
                const title = document.getElementById('phone-page-title');
                if (title) title.textContent = '手机';
            } else {
                phoneResetToMenu();
            }
            return;
        }
        navigateTo('home');
    };

    window.PhoneFeature = window.PhoneFeature || {};
    window.PhoneFeature.state = state;

    window.renderPhoneFriendsGrid = function () {
        const grid = document.getElementById('phone-friends-grid');
        const empty = document.getElementById('phone-friends-empty');
        if (!grid) return;
        let friends = [];
        try {
            friends = loadFriendsFromStorage().filter((f) => f && !f.isGroup && !f.blacklisted);
        } catch (e) {
            friends = [];
        }
        grid.innerHTML = '';
        if (friends.length === 0) {
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';
        friends.forEach((f) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'phone-friend-tile';
            btn.setAttribute('role', 'listitem');
            const initial = ((f.remark || f.nickname || '?').trim() || '?').charAt(0);
            if (f.avatar) {
                const av = document.createElement('img');
                av.className = 'phone-friend-tile-av';
                av.alt = '';
                av.src = f.avatar;
                btn.appendChild(av);
            } else {
                const ph = document.createElement('div');
                ph.className = 'phone-friend-tile-av placeholder';
                ph.textContent = initial;
                btn.appendChild(ph);
            }
            const lab = document.createElement('div');
            lab.className = 'phone-friend-tile-name';
            lab.textContent = (f.remark || f.nickname || '好友').trim() || '好友';
            btn.appendChild(lab);
            btn.addEventListener('click', () => window.openPhoneFriendLock(f));
            grid.appendChild(btn);
        });
    };

    window.openPhoneFriendLock = async function (friend) {
        if (!friend || friend.isGroup) return;
        abortPhoneLockFetch();
        state.friend = friend;
        state.friendId = friend.id;
        state.attemptsLeft = 3;
        state.input = '';
        state.expectedPin = '';

        setPhoneViews(false, true, false);
        ensurePhoneLockKeypad();
        updatePhoneLockClock();
        stopPhoneLockTimer();
        state.timeTimer = setInterval(updatePhoneLockClock, 15000);

        setPhoneLockPwdHintDisplay('正在获取密码提示…');

        const atEl = document.getElementById('phone-lock-attempts');
        if (atEl) atEl.textContent = '';
        refreshPhoneLockDots();

        showLoading();
        let lockData = null;
        try {
            lockData = await fetchPhoneLockPin(friend, { forceRefresh: false });
        } finally {
            hideLoading();
        }
        if (!lockData || !lockData.pin) {
            showNotification('无法生成锁屏密码，请检查 API 与网络');
            phoneResetToMenu();
            renderPhoneFriendsGrid();
            return;
        }
        state.expectedPin = lockData.pin;
        setPhoneLockPwdHintDisplay(lockData.hint || fallbackPhoneLockHint(friend));
        updatePhoneLockPinRefreshCountdown();
        state.pinRefreshTimer = setInterval(updatePhoneLockPinRefreshCountdown, 1000);
    };

    window.phoneOnEnterPhonePage = function () {
        phoneResetToMenu();
        renderPhoneFriendsGrid();
    };
})();
