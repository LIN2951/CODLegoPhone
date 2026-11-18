/**
 * Lego 小手机 · 微信朋友圈 — API 文案与 CommandManager 扩展（阶段 3）
 *
 * 依赖（由 app.js 提供）：loadFriendsFromStorage、safeReadJsonFromStorage、parseJsonFromPossiblyEncodedStorage、
 * EMOJI_DATA_LS_KEY、formatMessageForApi、getWorldBookData、getRecentChatHistoryLinesForMoments、
 * _buildMomentsChatHistoryLines、CommandManager（加载本文件前已定义）。
 *
 * 单入口：Moments.prompts.* 与 Moments.bootstrapCommands(CommandManager)；
 * 本文件末尾会自动调用 bootstrapCommands，亦可在 app.js 中再调一行（幂等安全需自行保证，当前实现为覆盖同名方法）。
 */
(function (global) {
    'use strict';

    var MOMENTS_API_CHAT_HISTORY_MAX_ROUNDS = 5;

    /** 朋友圈评论回复专用输出规则：纯文本，禁 HTML，禁推特结构 */
    var WECHAT_MOMENTS_COMMENT_OUTPUT_RULE = '---\n【朋友圈评论·输出规则｜仅本条 API 调用】\n本任务仅用于 App 内「微信朋友圈」评论回复，**不影响**推特等其他功能。\n\n【输出格式】直接输出评论文字，不要包裹任何格式。\n- 禁止输出 HTML 标签（如 <div>、<img>、<style> 等）\n- 禁止输出 JSON 或任何结构化格式\n- 禁止输出 Markdown 代码块围栏（```）\n- 禁止输出推特/X 的 UI 结构（如 @handle、display-name、retweet、like 等）\n- 禁止输出任何外链图片或表情包 URL\n- 直接输出一段自然的中文文字即可（如：「哈哈笑死我了」「你这太绝了」「等你更新！」）\n';

    /** 朋友圈评论·JSON 格式专用输出规则（用于 buildMomentsUserPostReactionsSendContent） */
    var WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE = '---\n【朋友圈评论·JSON 输出规则｜仅本条 API 调用】\n本任务仅用于 App 内「微信朋友圈」评论，**不影响**推特等其他功能。\n\n【JSON 字段说明】\n- authorName：评论者显示名，须与该好友角色卡中的**原文**一致（英文名写英文，中文名写中文）。\n- text：评论正文，≤80字，口语化，自然得像真人在朋友圈看到熟人动态后留言。\n- 禁止输出 HTML 标签或 Markdown 围栏；禁止在 authorName 中写 @handle 或 Twitter 格式。\n';

    global.WECHAT_MOMENTS_COMMENT_OUTPUT_RULE = WECHAT_MOMENTS_COMMENT_OUTPUT_RULE;
    global.WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE = WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE;

    /** 朋友圈专用：提取单个好友关联的世界书条目（仅世界观和角色塑造相关） */
    function buildMomentsWorldBooksBlock(friend) {
        if (!friend) return '';
        var wbData = typeof getWorldBookData === 'function' ? getWorldBookData() : { entries: [] };
        var entries = wbData.entries || [];
        var wbIds = Array.isArray(friend.worldBookIds) ? friend.worldBookIds
            : (friend.worldBookId ? [friend.worldBookId] : []);
        var ids = new Set(wbIds.map(String));
        var chunks = [];
        entries.forEach(function (entry) {
            if (!entry || !entry.content) return;
            var name = (entry.name || '').trim();
            if (!ids.has(String(entry.id))) return;
            if (/中英对照|功能性/.test(name)) return;
            if (/私密动态|朋友圈|微信.*(模板|样式|HTML)|消息气泡|聊天界面|Story|Ins风|美化/i.test(name)) return;
            var c = String(entry.content || '');
            if ((c.match(/<[^>]+>/g) || []).length >= 10) return;
            chunks.push('---\n世界书《' + name + '》:\n' + entry.content + '\n');
        });
        return chunks.length ? '【世界书·好友关联】\n' + chunks.join('\n') : '';
    }

    /**
     * 朋友圈刷新：为各好友生成动态（含点赞+评论互动）
     */
    function buildMomentsRefreshSendContent(cm) {
        var friends = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted && !f.momentsHidden && !f.isGroup; });
        if (friends.length === 0) return null;

        var myProfile = safeReadJsonFromStorage('myProfile', null);
        var emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        var allEmojis = [];
        for (var category in emojiData) {
            allEmojis = allEmojis.concat(emojiData[category] || []);
        }
        var fmt = function (c) { return (typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c); };

        var parts = [];
        cm.getCoreCommands().forEach(function (cmd) { parts.push(cmd.content); });

        var momentsSpecCmds = cm.getActiveCommands().filter(function (cmd) {
            return (cmd.name || '').indexOf('微信聊天规范⑦') !== -1 && /朋友圈/.test(cmd.name || '');
        });
        momentsSpecCmds.forEach(function (cmd) {
            parts.push('---\n' + cmd.content);
        });

        parts.push('---\n【朋友圈刷新·系统任务】\n你要同时为**所有本地好友**各撰写一条**刚发**的朋友圈动态，并同步生成该动态的点赞与评论。\n\n**总任务分两步：**\n- 步骤一：为每位好友生成 1 条朋友圈 post\n- 步骤二：为该 post 生成点赞列表（likes）+ 评论列表（comments）\n\n**步骤二·互动生成规则（核心）**\n1. 评论者来源优先级：①优先让其他**本地好友角色**（A类）评论 → ②其次从该好友关系网NPC（B类）补充\n2. 评论数量：每条动态 2～5 条评论，不要所有人都发言\n3. A类角色评论：必须完全符合该角色卡性格，允许较长表达（5～100字），允许调侃/关心/起哄\n4. B类NPC评论：简短随意（5～30字），像真实朋友圈里不太熟的人随手留言\n5. 点赞：仅显示头像昵称，无文字，人数建议 2～8 人\n6. 禁止虚构用户在该动态下的评论\n');

        var friendCardSummaries = friends.map(function (f, i) {
            var displayName = (f.remark || f.nickname || '好友').trim();
            var cardSnippet = (f.roleSetting || f.role || '无').slice(0, 600);
            return '[' + (i + 1) + '] ' + displayName + '（friendId:' + String(f.id) + '）\n' + cardSnippet;
        });
        parts.push('---\n【本地好友角色卡总览·用于识别A类评论者】\n以下为所有本地好友角色，在生成评论时可优先选其中与当前动态发布者互相认识的人进行评论。\n' + friendCardSummaries.join('\n\n') + '\n');

        parts.push('---\n【语言规则·最高优先级】\n朋友圈动态正文（text 字段）必须为**简体中文**。\n- 朋友圈是中文社交平台，正文、评论、点赞昵称一律用中文。\n- 若角色卡中引用了外文台词/歌词/梗，**必须翻译为中文**后再写入 text，禁止直接输出英文/日文/韩文原文。\n- 允许保留外文人名、地名、品牌名等专有名词，但正文正文（句子/段落）必须是中文。\n- 朋友圈评论同样遵守此规则。\n');

        friends.forEach(function (f) {
            var displayName = f.remark || f.nickname || '好友';
            var persona = f.persona || myProfile;
            var hist = typeof getRecentChatHistoryLinesForMoments === 'function'
                ? getRecentChatHistoryLinesForMoments(f.id, MOMENTS_API_CHAT_HISTORY_MAX_ROUNDS, fmt)
                : '（历史获取失败）';
            parts.push('---\n【好友 ' + displayName + '】friendId（JSON里必须原样填写）: ' + String(f.id) + '\n对外显示昵称（参考）: ' + displayName + '\n角色卡:\n' + (f.roleSetting || f.role || '无') + '\n\n用户人设（User，请与 TA 的关系代入本条朋友圈语境）:\n昵称: ' + (persona && persona.nickname || myProfile && myProfile.nickname || '未设置') + '\n身份: ' + (persona && persona.identity || myProfile && myProfile.identity || '未设置') + '\n\n双方最近 ' + MOMENTS_API_CHAT_HISTORY_MAX_ROUNDS + ' 轮完整聊天（每轮为 User 连续消息 + 好友连续消息；格式已脱敏表情为名称）:\n' + hist + '\n');
        });

        if (allEmojis.length > 0) {
            parts.push('---\n【用户上传表情·调用格式】\n在 text 中需要插入表情时，请单独使用格式 [发送表情:表情名称]，名称须与下表完全一致（系统会将之渲染为图片）。\n' + allEmojis.map(function (e, i) { return (i + 1) + '. ' + (e.name || '未命名'); }).join('\n') + '\n');
        }

        parts.push('---\n【输出格式·必须严格遵守】\n1. 仅输出**一个** JSON 对象，不要 markdown 代码块，不要任何前缀或后记说明文字。\n2. 顶层字段为 "posts"，值为数组，长度必须为 ' + friends.length + '，每位好友恰好出现一次。\n3. 每条 post 结构（含动态内容 + 点赞 + 评论）：\n{\n  "friendId": "字符串，与上文一致",\n  "text": "可选，≤800字；可为空字符串若仅用图；可用 [发送表情:名称]",\n  "images": ["可选，0~9 个字符串，每项为 http(s) 或 data:image 开头的图片 URL"],\n  "polaroid": { "searchQuery": "可选", "caption": "可选" },\n  "likes": [\n    { "authorName": "点赞者昵称", "authorId": "简短唯一标识", "isFriendCard": true/false }\n  ],\n  "comments": [\n    {\n      "authorName": "评论者昵称",\n      "authorId": "简短唯一标识",\n      "text": "评论内容，A类≤100字/B类≤30字，单条上限200字",\n      "isFriendCard": true/false,\n      "replyTo": "层主昵称（层主评论时不填）"\n    }\n  ]\n}\n4. text、images、polaroid 至少一类非空；likes/comments 至少 likes 非空（可空数组但建议有）。\n5. 禁止输出 HTML 标签；表情仅用 [发送表情:名称]。\n');

        return parts.join('\n');
    }

    /**
     * 用户对好友动态留言 → API 以好友身份回复用户
     */
    function buildMomentsFriendReplySendContent(cm, post, userCommentText) {
        if (!post || !userCommentText) return null;
        if (post.friendId && String(post.friendId) !== 'me') {
            var author = loadFriendsFromStorage().find(function (x) { return String(x.id) === String(post.friendId); });
            if (author && author.isGroup) return null;
        }
        var myProfile = safeReadJsonFromStorage('myProfile', null);
        var emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        var allEmojis = [];
        for (var c in emojiData) { allEmojis = allEmojis.concat(emojiData[c] || []); }
        var fmt = function (x) { return (typeof formatMessageForApi === 'function' ? formatMessageForApi(x, allEmojis) : x); };

        var parts = [];

        cm.getCoreCommands().forEach(function (cmd) { parts.push(cmd.content); });

        if (post.friendId && String(post.friendId) !== 'me') {
            var friends = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted; });
            var f = friends.find(function (x) { return String(x.id) === String(post.friendId); });
            if (f) {
                var wbBlock = buildMomentsWorldBooksBlock(f);
                if (wbBlock) parts.push(wbBlock);
            }
        }

        if (post.friendId && String(post.friendId) !== 'me') {
            var friends2 = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted; });
            var f2 = friends2.find(function (x) { return String(x.id) === String(post.friendId); });
            if (f2) {
                var displayName = (f2.remark || f2.nickname || '好友').trim() || '好友';
                parts.push('---\n【好友 ' + displayName + '】\n角色卡:\n' + (f2.roleSetting || f2.role || '无') + '\n');
                var userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role))
                    ? String(myProfile.roleSetting || myProfile.role).trim() : '';
                parts.push('---\n【用户角色卡 / User】\n昵称: ' + (myProfile && myProfile.nickname || '未设置') + '\n身份: ' + (myProfile && myProfile.identity || '未设置') + '\n' + (userRoleExtra ? '补充设定:\n' + userRoleExtra + '\n' : ''));
            }
        }

        if (post.friendId && String(post.friendId) !== 'me') {
            var friends3 = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted; });
            var f3 = friends3.find(function (x) { return String(x.id) === String(post.friendId); });
            if (f3) {
                var hist = _buildMomentsChatHistoryLines(f3.id, MOMENTS_API_CHAT_HISTORY_MAX_ROUNDS, fmt);
                parts.push('---\n【' + (f3.remark || f3.nickname || '好友').trim() + '】与用户的最近聊天记录（表情已脱敏为名称）:\n' + (hist || '（暂无聊天记录）') + '\n');
            }
        }

        var postText = post.text || '';
        var postImages = Array.isArray(post.images) ? post.images.join('\n') : '';
        parts.push('---\n【好友朋友圈动态】\n发布者: ' + (post.friendName || '好友') + '\n内容: ' + (postText || '（仅图片动态）') + '\n' + (postImages ? '图片:\n' + postImages + '\n' : '') + '\n【用户对该动态的留言】\n用户留言: ' + userCommentText + '\n');

        parts.push('---\n【任务】\n以上是一条好友的朋友圈动态，用户在下方留了言"' + userCommentText + '"。\n请你以**该好友**的角度，针对用户的这条留言写出一条**自然的回复**。\n要求：\n- 回复语气必须完全符合该好友角色卡（自然、口语化，像真人回复好友评论）\n- 回复可表达认同、调侃、撒娇、反问、害羞、傲娇等，符合好友性格\n- 回复字数建议 5～40 字，避免机械式应答\n- 不要复述用户说的话，直接给出好友的回复即可\n- 禁止在回复中代入用户身份或替用户说话\n');

        parts.push(WECHAT_MOMENTS_COMMENT_OUTPUT_RULE);

        return parts.join('\n');
    }

    /**
     * 用户发朋友圈 → API 扮演各好友对用户动态进行留言
     */
    function buildMomentsUserPostReactionsSendContent(cm, post) {
        if (!post) return null;
        var friends = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted && !f.isGroup; });
        if (friends.length === 0) return null;

        var apiSettings = {};
        try { apiSettings = JSON.parse(localStorage.getItem('apiSettings') || '{}'); } catch (e) { apiSettings = {}; }
        var memGlobal = cm._clampInt(apiSettings.memoryCount, 1, 100, 50);
        var roundsPerFriend = Math.min(memGlobal, MOMENTS_API_CHAT_HISTORY_MAX_ROUNDS);

        var myProfile = safeReadJsonFromStorage('myProfile', null);
        var emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        var allEmojis = [];
        for (var c2 in emojiData) { allEmojis = allEmojis.concat(emojiData[c2] || []); }
        var fmt = function (x) { return (typeof formatMessageForApi === 'function' ? formatMessageForApi(x, allEmojis) : x); };

        var ROLE_CARD_CAP = 2800;
        function clampRoleCardBody(str) {
            var t = String(str || '').trim() || '无';
            if (t.length <= ROLE_CARD_CAP) return t;
            return t.slice(0, ROLE_CARD_CAP) + '\n…（角色卡已截断以控制请求体积）';
        }

        var parts = [];

        cm.getCoreCommands().forEach(function (cmd) { parts.push(cmd.content); });

        if (friends.length > 0) {
            var wbBlock = buildMomentsWorldBooksBlock(friends[0]);
            if (wbBlock) {
                if (wbBlock.length > 8000) {
                    wbBlock = wbBlock.slice(0, 8000) + '\n…（世界书已截断）';
                }
                parts.push(wbBlock);
            }
        }

        friends.forEach(function (f) {
            var displayName = (f.remark || f.nickname || '好友').trim() || '好友';
            parts.push('---\n【好友 ' + displayName + '】friendId: ' + String(f.id) + '\n角色卡:\n' + clampRoleCardBody(f.roleSetting || f.role));
        });

        var userRoleExtra = (myProfile && (myProfile.roleSetting || myProfile.role))
            ? String(myProfile.roleSetting || myProfile.role).trim() : '';
        parts.push('---\n【用户角色卡 / User】\n昵称: ' + (myProfile && myProfile.nickname || '未设置') + '\n身份: ' + (myProfile && myProfile.identity || '未设置') + '\n' + (userRoleExtra ? '补充设定:\n' + userRoleExtra + '\n' : ''));

        friends.forEach(function (f) {
            var displayName = (f.remark || f.nickname || '好友').trim() || '好友';
            var hist = _buildMomentsChatHistoryLines(f.id, roundsPerFriend, fmt);
            parts.push('---\n【' + displayName + '】与用户的最近聊天记录（表情已脱敏为名称）:\n' + (hist || '（暂无聊天记录）') + '\n');
        });

        var postText = post.text || '';
        var postImages = Array.isArray(post.images) ? post.images.join('\n') : '';
        parts.push('---\n【用户刚刚发布的朋友圈动态】\n内容: ' + (postText || '（仅图片动态）') + '\n' + (postImages ? '图片:\n' + postImages + '\n' : ''));

        parts.push('---\n【任务】\n用户（User）刚刚发布了上述朋友圈动态，请为该动态生成**各好友的评论列表**。\n要求：\n- 为上述**所有好友**各生成 1 条评论（每人 1 条，不要为空）\n- 每条评论语气必须完全符合该好友角色卡（自然、口语化，像真人在朋友圈看到熟人发消息后留言）\n- 评论方向可包括：调侃、关心、八卦、羡慕、起哄、催婚、吐槽、磕糖、表白等，符合好友与用户的关系\n- 可出现好友与用户之间的亲昵称呼、两人专属梗\n- 用户（User）本人不在评论中出现\n- 禁止虚构用户说了什么\n- 输出格式：JSON 数组，每项为 { "friendId": "数字字符串", "authorName": "评论者显示名", "text": "评论内容（≤80字）" }\n- 仅输出 JSON，不要 markdown 围栏，不要前言后记\n');

        parts.push(WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE);

        return parts.join('\n');
    }

    /** 微信聊天规范⑦朋友圈：仅当本地尚无 id 990107 时追加到 systemCommands */
    function bootstrapWechatMomentsSystemCommand(cm) {
        var KEY = 'systemCommands';
        var ID7 = 990107;
        try {
            var cmds = JSON.parse(localStorage.getItem(KEY) || '[]');
            var has7 = cmds.some(function (c) { return c && c.id === ID7; });
            if (!has7) {
                cmds.push({
                    id: ID7,
                    name: '微信聊天规范⑦ · 朋友圈',
                    content: [
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【微信聊天规范⑦ · 朋友圈】',
                        '',
                        '【适用范围】',
                        '本规范**仅适用于**微信朋友圈动态刷新场景（好友发朋友圈 → 系统自动生成点赞与评论）。',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【朋友圈互动角色分类】',
                        '',
                        '本规范将评论区人物分为两类，执行不同规则：',
                        '',
                        '▌A类：好友角色（有角色卡）',
                        '  · 定义：在本地好友列表中拥有完整角色卡的人物（如林浩、王思雨等）',
                        '  · 评论风格：必须完全符合该角色卡的**性格、语气、用词习惯**',
                        '  · 可以主动@、调侃、关心、吐槽、撒娇、表达暧昧等，符合角色性格',
                        '  · 可使用角色卡中特有的称呼、梗、口头禅',
                        '  · 允许与其他 A 类角色互动（如"林浩 回复 王思雨：哈哈哈"）',
                        '',
                        '▌B类：关系网NPC（无角色卡）',
                        '  · 定义：该好友角色卡「关系网/社交圈/亲友」字段中提及，但本地无角色卡的人物',
                        '  · 如：教练、队友、同事、邻居、家人、闺蜜、对手等',
                        '  · 评论风格：通用潜水留言风格（简短随意、口语化、自然）',
                        '  · 语气参考：像真实朋友圈里不太熟的人随手留言',
                        '  · 示例：点赞 + "恭喜！"、"666"、"加油"、"周末愉快~"、"厉害"',
                        '  · 不使用角色卡中独有的称呼或梗，不主动提及用户',
                        '  · 字数控制在 5～30 字，避免长篇大论',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【评论选取优先级规则】',
                        '',
                        '评论者来源按以下优先级选取（不要所有人都留言）：',
                        '',
                        '  ① 优先：A类角色（其他好友角色）中**与该动态发布者互相认识的人**',
                        '     - 例如：林浩发动态 → 若王思雨、李明在各自角色卡中均提及林浩，则优先让王思雨、李明评论',
                        '     - 优先选取 1～2 位 A 类角色进行评论',
                        '',
                        '  ② 其次：从该好友角色卡的关系网中选取 B 类 NPC 补充至 2～5 条评论',
                        '     - 选取数量以总评论数达到 2～5 条为准',
                        '     - 若 A 类角色已占满 2～5 条，可不额外添加 B 类评论',
                        '',
                        '  ③ 控制总量：每条动态评论数 **2～5 条**，不要所有人都发言',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【评论字数约束】',
                        '  · A类角色评论：5～100 字（允许较长、有角色特色的表达）',
                        '  · B类NPC评论：5～30 字（简短随意即可）',
                        '  · 单条评论上限：不超过 200 字',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【点赞规则】',
                        '  · 点赞仅显示点赞者头像与昵称，**不附带任何文字**',
                        '  · 点赞者可包含：A类角色、B类NPC、或虚构的共同好友',
                        '  · 点赞人数建议 2～8 人，营造活跃感但不过度夸张',
                        '  · 点赞列表放在 comments 数组之后，用独立的 likes 数组表示',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【JSON 输出格式·必须严格遵守】',
                        '  · 每条 post 必须包含 likes（点赞列表）和 comments（评论列表）字段',
                        '  · likes 为数组，每项：{ "authorName": "昵称", "authorId": "唯一标识", "isFriendCard": true/false }',
                        '    - isFriendCard=true 表示该点赞者是本地好友角色，false 表示关系网NPC或虚构人物',
                        '  · comments 为数组，每项：{ "authorName": "昵称", "authorId": "唯一标识", "text": "评论内容", "isFriendCard": true/false, "replyTo": "被回复者昵称（可选，层主评论时不填）" }',
                        '  · authorId 用简短英文字符串，如 "coach_chen"、"rival_lina"、"teammate_wang"',
                        '  · 禁止在评论 text 中使用 @ 提及语法，应在 replyTo 字段中表达层主关系',
                        '',
                        '  · JSON 示例：',
                        '  {',
                        '    "friendId": "123",',
                        '    "friendName": "林浩",',
                        '    "text": "今天的训练终于突破了个人纪录！",',
                        '    "images": [],',
                        '    "likes": [',
                        '      { "authorName": "陈教练", "authorId": "coach_chen", "isFriendCard": false },',
                        '      { "authorName": "王思雨", "authorId": "siyu_456", "isFriendCard": true },',
                        '      { "authorName": "李娜", "authorId": "rival_lina", "isFriendCard": false }',
                        '    ],',
                        '    "comments": [',
                        '      { "authorName": "王思雨", "authorId": "siyu_456", "text": "林浩你也太强了吧！下次带我一起练！", "isFriendCard": true },',
                        '      { "authorName": "陈教练", "authorId": "coach_chen", "text": "好样的，保持这个状态！", "isFriendCard": false },',
                        '      { "authorName": "李娜", "authorId": "rival_lina", "text": "下次我也要追上你！等着", "isFriendCard": false }',
                        '    ]',
                        '  }',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【评论语言风格·行为约束】',
                        '  · 禁止在朋友圈评论中使用微信私聊中才合理的表达（如单独发送大段情话、长篇感慨）',
                        '  · 评论是对**动态内容**的反应，不是对用户说私密话',
                        '  · 禁止虚构用户在该动态下的评论（用户评论由系统单独处理）',
                        '  · 禁止出现与角色卡明显矛盾的语气或用词',
                        '  · 禁止在 B 类 NPC 评论中使用角色卡中独有的特定称呼',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                    ].join('\n'),
                    createdAt: ID7,
                    active: true
                });
                localStorage.setItem(KEY, JSON.stringify(cmds));
                cm.syncCommandsToFile(cmds).then(function () {});
                console.log('[WechatMoments bootstrap] 已追加「微信聊天规范⑦ · 朋友圈」');
            }
        } catch (e) {
            console.error('[WechatMoments bootstrap] 初始化失败:', e);
        }
    }

    function bootstrapCommands(cm) {
        if (!cm) return;
        var p = global.Moments.prompts;
        cm.buildMomentsWorldBooksBlock = function (friend) {
            return p.buildMomentsWorldBooksBlock(friend);
        };
        cm.buildMomentsRefreshSendContent = function () {
            return p.buildMomentsRefreshSendContent(this);
        };
        cm.buildMomentsFriendReplySendContent = function (post, userCommentText) {
            return p.buildMomentsFriendReplySendContent(this, post, userCommentText);
        };
        cm.buildMomentsUserPostReactionsSendContent = function (post) {
            return p.buildMomentsUserPostReactionsSendContent(this, post);
        };
        bootstrapWechatMomentsSystemCommand(cm);
    }

    var promptsApi = {
        buildMomentsWorldBooksBlock: buildMomentsWorldBooksBlock,
        buildMomentsRefreshSendContent: buildMomentsRefreshSendContent,
        buildMomentsFriendReplySendContent: buildMomentsFriendReplySendContent,
        buildMomentsUserPostReactionsSendContent: buildMomentsUserPostReactionsSendContent,
        WECHAT_MOMENTS_COMMENT_OUTPUT_RULE: WECHAT_MOMENTS_COMMENT_OUTPUT_RULE,
        WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE: WECHAT_MOMENTS_JSON_COMMENT_OUTPUT_RULE
    };

    var M = global.Moments || {};
    global.Moments = Object.assign(M, {
        prompts: Object.assign(M.prompts || {}, promptsApi),
        bootstrapCommands: bootstrapCommands
    });

    try {
        if (typeof CommandManager !== 'undefined') {
            global.Moments.bootstrapCommands(CommandManager);
        }
    } catch (e) {
        console.error('[WechatMoments] bootstrapCommands 自动注册失败:', e);
    }
})(typeof window !== 'undefined' ? window : globalThis);
