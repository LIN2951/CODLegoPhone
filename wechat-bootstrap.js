/**
 * Lego 小手机 · 微信相关系统指令 bootstrap（从 app.js 迁出）
 * 依赖：app.js 的 CommandManager、localStorage systemCommands
 * 加载顺序：紧接在 app.js 之后。
 */
(function (global) {
    'use strict';

    function bootstrapWechatMoneyCommands() {
        var KEY = 'systemCommands';
        var ID6 = 990106;
        try {
            var cmds = JSON.parse(localStorage.getItem(KEY) || '[]');
            var has6 = cmds.some(function (c) {
                return c && c.id === ID6;
            });
            if (!has6) {
                cmds.push({
                    id: ID6,
                    name: '微信聊天规范⑥ · 资金往来',
                    content: [
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【微信聊天规范⑥ · 资金往来】',
                        '',
                        '【适用范围】',
                        '本规范**仅适用于**好友与用户之间的「微信线上聊天」场景。',
                        '好友通过本规范向用户发送转账或微信红包（由 {{char}} 主动发起），用户收到后可在聊天界面操作「收款/拒绝」或「拆红包」。',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【资金消息类型定义】',
                        '',
                        '// 转账：正式金钱往来、大额赠予或还款，content 为金额（纯数字），message 为附言',
                        '{"type":"transfer", "content":"金额纯数字", "message":"附言（非必填）"}',
                        '',
                        '// 红包：表达爱意、节日祝福或哄人，content 为金额（纯数字），message 为祝福语',
                        '{"type":"redpacket", "content":"金额纯数字", "message":"祝福语（非必填）"}',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【何时使用转账 / 红包】',
                        '',
                        '【转账适用场景】',
                        '  · 用户向好友借款/还钱，好友主动表示转账给对方',
                        '  · 好友主动大额赠予（发工资/还钱/共同消费分摊）',
                        '  · 好友转账给用户表达支持（如用户创业/买礼物）',
                        '  · 金额通常较大（≥100 元），或涉及正式财务往来',
                        '',
                        '【红包适用场景】',
                        '  · 节日祝福：春节、中秋、生日、纪念日、520、情人节',
                        '  · 表达爱意：日常撒狗粮、哄人、表达好感',
                        '  · 调侃/逗趣：朋友间开玩笑、整蛊',
                        '  · 金额通常较小（≤520 元）或特殊寓意（5.20 / 6.66 / 8.88 等）',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【消息频率约束】',
                        '  · 好友主动发起转账或红包：**每次刷新至多 1 条**，且需符合当前聊天情境（节日/借钱/表达情感等）。',
                        '  · 禁止无理由频繁发资金消息（如每次刷新都发）。',
                        '  · 禁止同一次 API 回复中同时发转账 + 发红包。',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【行为约束】',
                        '  · 禁止虚构大额转账（如突然转几万、几十万），金额须符合好友角色卡的「收入水平」设定。',
                        '  · 禁止频繁（>3次/天）发红包或转账，除非聊天中有明确的合理情境（节日连续轰炸/借款多笔等）。',
                        '  · 禁止将资金往来用于贿赂、诈骗等违规情节。',
                        '  · 金额须为正数，message 字段最多 20 字。',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【输出格式·必须严格遵守】',
                        '资金消息**必须**以独立的 JSON 行输出（占一条消息），不可混入文字内容中。',
                        '',
                        '示例（红包）：',
                        '{"type":"redpacket", "content":"520", "message":"情人节快乐~"}',
                        '（可选附文字消息，如"你也想要一个吗？哈哈"）',
                        '',
                        '示例（转账）：',
                        '{"type":"transfer", "content":"200", "message":"买点好吃的"}',
                        '',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
                        '【与普通消息的关系】',
                        '  · 资金消息可与普通文字消息共存：先发资金消息 JSON，再发文字内容。',
                        '  · 资金消息不会打断正常对话流程。',
                        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
                    ].join('\n'),
                    createdAt: ID6,
                    active: true
                });
                localStorage.setItem(KEY, JSON.stringify(cmds));
                CommandManager.syncCommandsToFile(cmds).then(function () {});
                console.log('[WechatMoney bootstrap] 已追加「微信聊天规范⑥ · 资金往来」');
            }
        } catch (e) {
            console.error('[WechatMoney bootstrap] 初始化失败:', e);
        }
    }

    function bootstrapSystemCommands() {
        bootstrapWechatMoneyCommands();
    }

    global.Wechat = global.Wechat || {};
    global.Wechat.bootstrapSystemCommands = bootstrapSystemCommands;
})(typeof window !== 'undefined' ? window : globalThis);
