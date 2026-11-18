/**
 * Lego 小手机 · 微信心跳监控模块
 *
 * 从 app.js 迁出：心跳监控 prompt、上下文拼装、缓存恢复、API 调用与渲染。
 * 依赖 app.js 中既有的 CommandManager / FeatureCommandMapper / 存储工具；需在 wechat-prompts.js 之后加载。
 */
(function (global) {
    'use strict';

    const HEARTBEAT_MONITOR_SYSTEM_INSTRUCTION = `【心跳监控 · 好友状态深度分析】
你是一个精准捕捉好友情绪与身心状态的「心跳监控器」。

【核心任务】
根据下方「好友角色卡」「用户人设」以及「本轮与过往最多 3 轮完整对话」的合并上下文，推断好友此刻的所处环境与内心活动，输出结构化心跳报告。不要输出服装、动作、姿态类描写。
- 对话范围：最后一轮为「本轮」，再往前最多 3 轮为「过往」；须同时参考这最多 4 轮内的语气、关系变化与情节推进。

【分析维度】（请综合判断）
- 心率（BPM）：60~140 区间，越激动越高（禁止超过 140），须为整数
- 情绪标签：取最贴切的一个或多个（限用下列中文标签，可选 1~3 个）
  · 平静（normal）| 心跳加速（excited）| 害羞脸红（shy）
  · 开心愉悦（happy）| 生气愤怒（angry）| 嫉妒吃醋（jealous）
  · 心疼担忧（worried）| 思念牵挂（miss）| 傲娇别扭（tsundere）
  · 心动沦陷（crush）| 感动温暖（touched）| 困惑迷茫（confused）
  · 期待兴奋（eager）| 失落沮丧（sad）| 撒娇任性（pouty）

【两段描写 · 长度与内容要求】（正文须为中文；下列字数均为汉字计）
1. 环境：不超过 200 字。只写环境与氛围（如地点、光线、声音、天气、周围事物、空间气氛），须与对话与角色逻辑一致；未提及地点时可合理推断但不可与角色卡冲突。禁止写穿着、肢体动作、表情细节。
2. 心理：不超过 300 字。描写好友此刻的真实心理活动；必须先根据「好友角色卡 + 用户人设 + 双方聊天记录」判断二人关系与氛围，再决定心理描写的尺度：
   · 若为闺蜜、好兄弟、铁哥们、普通同事、一般同学、无暧昧的纯友谊等：禁止任何露骨性幻想、禁止描写想与对方发生性行为或性器官相关欲望；心理可写关心、吐槽、护短、竞争、玩笑、专业距离感等。
   · 若为暧昧、恋人、夫妻或角色卡/对话明确存在浪漫与性张力：允许心理层面较露骨的欲望与联想（仍须符合人设与当下对话，禁止机械重复）。
   · 禁止让「好兄弟」「好闺蜜」或单纯同事关系对用户产生性幻想或露骨性欲望（本条为硬限制）。

【输出格式 · 必须严格遵守】
直接输出一段 HTML，不要 markdown 代码块，不要任何前缀后记，不要 JSON，不要解释说明。
class 名必须与下列示例完全一致（class 用英文，正文用中文）；禁止输出 heartbeat-outfit、heartbeat-action 区块：
<div class="heartbeat-report">
  <div class="heartbeat-rate"><span class="heartbeat-rate-num">80</span> <span class="heartbeat-rate-unit">BPM</span></div>
  <div class="heartbeat-emotions">
    <span class="heartbeat-emotion-tag">心跳加速</span>
    <span class="heartbeat-emotion-tag">心动沦陷</span>
  </div>
  <div class="heartbeat-section heartbeat-env"><span class="heartbeat-section-label">环境</span><div class="heartbeat-section-body">……</div></div>
  <div class="heartbeat-section heartbeat-mind"><span class="heartbeat-section-label">心理</span><div class="heartbeat-section-body">……</div></div>
</div>

【注意事项】
1. 心率必须为整数；情绪标签限用上述列表中的中文标签
2. 环境与心理两段各自遵守字数上限，避免重复粘贴聊天记录
3. 只输出上述 HTML，不要输出任何其他内容`;

    const HeartbeatMonitor = {
        REPORT_KEY: 'heartbeatMonitorReport',
        COUNT_KEY: 'heartbeatMonitorLastFriendMsgCount',
        _inFlightFriendId: null,
        _inFlightPromise: null,

        buildHeartbeatMonitorContent: function(friendId) {
            const friends = loadFriendsFromStorage();
            const friend = friends.find(f => String(f.id) === String(friendId));
            if (!friend) return null;

            const myProfile = safeReadJsonFromStorage('myProfile', null);
            const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);

            const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
            let allEmojis = [];
            for (const c in emojiData) allEmojis = allEmojis.concat(emojiData[c] || []);
            const fmt = (c) => typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c;

            const rounds = CommandManager._buildRoundsFromChatHistory(chatHistory);
            const recentRounds = rounds.slice(-4);

            const friendsById = new Map(friends.map(f => [String(f.id), f]));
            const resolveGroupFriendLine = (it, fmtFn) => {
                const sid = it && it.speakerId != null ? String(it.speakerId) : '';
                let m = sid ? friendsById.get(sid) : null;
                if (!m && sid && friend.isGroup && typeof resolveGroupChatSpeakerMember === 'function') {
                    m = resolveGroupChatSpeakerMember(sid, friend, friends);
                }
                const name = m ? ((m.remark || m.nickname || '成员').trim() || '成员') : (sid || '成员');
                const compact =
                    typeof compactChatMessageContentForApi === 'function'
                        ? compactChatMessageContentForApi(it)
                        : String((it && it.content) || '');
                return `${name}: ${fmtFn(compact)}`;
            };

            const contextLines = CommandManager._formatHistoryLines(
                recentRounds,
                recentRounds.length,
                fmt,
                friend.isGroup
                    ? { userLabel: '用户', resolveFriendLine: resolveGroupFriendLine }
                    : { userLabel: '用户', friendLabel: '好友' }
            );

            const friendDisplayName = (friend.remark || friend.nickname || '好友').trim() || '好友';
            const userPersona = friend.isGroup ? (friend.groupMyPersona || myProfile) : (friend.persona || myProfile);
            const userNickname = userPersona?.nickname || myProfile?.nickname || '未设置';
            const userIdentity = userPersona?.identity || myProfile?.identity || '未设置';
            const userRoleCard = String(userPersona?.roleSetting || userPersona?.role || myProfile?.roleSetting || myProfile?.role || '').trim() || '（未填写）';
            const friendRoleCard = String(friend.roleSetting || friend.role || '').trim() || '（未填写）';

            let roleBlocks = [];
            if (friend.isGroup) {
                const memberIds = Array.isArray(friend.memberIds) ? friend.memberIds.map(String) : [];
                const members = memberIds.map(id => friendsById.get(String(id))).filter(Boolean).filter(m => !m.isGroup);
                const memberBlocks = members.map(m => {
                    const displayName = (m.remark || m.nickname || '成员').trim() || '成员';
                    const roleCard = m.roleSetting || m.role || '无';
                    return `- memberId: ${String(m.id)}\n  昵称: ${displayName}\n  角色卡:\n${roleCard}`;
                }).join('\n\n');
                roleBlocks = [
                    '【群聊】',
                    `群名称: ${(friend.nickname || '群聊').trim() || '群聊'}`,
                    '群成员角色卡（发言者请对号入座）:',
                    memberBlocks || '（无）',
                    '',
                    '用户人设（请严格遵守，禁止编造未设定内容）:',
                    `昵称: ${userNickname}`,
                    `身份: ${userIdentity}`,
                    `用户角色卡/补充: ${userRoleCard}`
                ];
            } else {
                roleBlocks = [
                    '【私聊】',
                    `好友对外昵称: ${friendDisplayName}`,
                    '好友角色卡:',
                    friendRoleCard,
                    '',
                    '用户人设（请严格遵守，禁止编造未设定内容）:',
                    `昵称: ${userNickname}`,
                    `身份: ${userIdentity}`,
                    `用户角色卡/补充: ${userRoleCard}`
                ];
            }

            const historyBlock = contextLines.length > 0 ? contextLines.join('\n') : '（暂无完整来回轮次，请仅依据已有消息与角色卡合理推断）';

            return (
                HEARTBEAT_MONITOR_SYSTEM_INSTRUCTION +
                '\n\n' +
                roleBlocks.join('\n') +
                '\n\n【本轮及过往最多 3 轮对话合并上下文】（自旧到新；用于推断关系与当下状态）\n' +
                historyBlock
            );
        },

        restore: function(friendId) {
            const panel = document.getElementById('chat-heartbeat-monitor-content');
            if (!panel) return;

            const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
            const currentFriendMsgCount = chatHistory.filter(m => m.type === 'friend').length;

            try {
                const counts = JSON.parse(localStorage.getItem(this.COUNT_KEY) || '{}');
                const lastCount = parseInt(counts[friendId] || '0', 10);
                if (currentFriendMsgCount > lastCount) return;
                const reports = JSON.parse(localStorage.getItem(this.REPORT_KEY) || '{}');
                const html = reports[friendId];
                if (html) {
                    panel.innerHTML = html;
                    try {
                        panel.querySelectorAll('.heartbeat-outfit, .heartbeat-action').forEach((el) => el.remove());
                    } catch (e2) {}
                }
            } catch (e) {}
        },

        fetchAndRender: async function(friendId, controller = null) {
            if (this._inFlightPromise && String(this._inFlightFriendId) === String(friendId)) {
                return this._inFlightPromise;
            }
            const content = this.buildHeartbeatMonitorContent(friendId);
            if (!content) return;

            const self = this;
            self._inFlightFriendId = friendId;
            self._inFlightPromise = (async function () {
                try {
                    const html = await FeatureCommandMapper.callApiModel(content, controller, {
                        skipOverlay: true,
                        apiRetry: false
                    });
                    if (html && typeof html === 'string') {
                        self.render(html, friendId);
                    }
                } finally {
                    if (String(self._inFlightFriendId) === String(friendId)) {
                        self._inFlightFriendId = null;
                        self._inFlightPromise = null;
                    }
                }
            })();
            return self._inFlightPromise;
        },

        render: function(html, friendId) {
            const panel = document.getElementById('chat-heartbeat-monitor-content');
            if (!panel) return;
            panel.innerHTML = html;
            try {
                panel.querySelectorAll('.heartbeat-outfit, .heartbeat-action').forEach((el) => el.remove());
            } catch (e) {}
            if (!friendId) return;

            try {
                const reports = JSON.parse(localStorage.getItem(this.REPORT_KEY) || '{}');
                reports[friendId] = html;
                localStorage.setItem(this.REPORT_KEY, JSON.stringify(reports));

                const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
                const friendMsgCount = chatHistory.filter(m => m.type === 'friend').length;
                const counts = JSON.parse(localStorage.getItem(this.COUNT_KEY) || '{}');
                counts[friendId] = friendMsgCount;
                localStorage.setItem(this.COUNT_KEY, JSON.stringify(counts));
            } catch (e) {}
        }
    };

    global.HEARTBEAT_MONITOR_SYSTEM_INSTRUCTION = HEARTBEAT_MONITOR_SYSTEM_INSTRUCTION;
    global.HeartbeatMonitor = HeartbeatMonitor;

    if (typeof global.Wechat !== 'undefined' && global.Wechat) {
        global.Wechat.heartbeat = {
            version: '0.2.0',
            HEARTBEAT_MONITOR_SYSTEM_INSTRUCTION,
            ...HeartbeatMonitor,
        };
    }
})(typeof window !== 'undefined' ? window : this);
