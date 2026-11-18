/**
 * Lego 小手机 · 微信模块命名空间（拆迁阶段 0 空壳）
 *
 * 后续阶段将拆入：
 * - wechat-store.js  → Wechat.store（好友/聊天记录/KV）
 * - wechat-prompts.js → Wechat.prompts（buildWechatSendContent 等）
 * - wechat-ui.js      → Wechat.ui（DOM 与 window 全局 onclick 实现）
 *
 * 约束：迁移期 `index.html` 仍使用 `onclick="全局函数名()"`，实现可逐步改为
 * `window.foo = Wechat.ui.foo` 而不改 HTML 属性。
 */
(function (global) {
    'use strict';

    function runWechatInit(prevInit, self) {
        if (typeof global.loadHtmlFragments !== 'function') {
            if (typeof prevInit === 'function') prevInit.call(self);
            return Promise.resolve();
        }
        function postFragmentBind() {
            try {
                if (typeof global.bindWechatChatPipelineDom === 'function') {
                    global.bindWechatChatPipelineDom();
                }
            } catch (e) {
                console.error('[Wechat] bindWechatChatPipelineDom after fragments:', e);
            }
        }
        return global.loadHtmlFragments()
            .then(function () {
                postFragmentBind();
                if (typeof prevInit === 'function') prevInit.call(self);
                try {
                    if (typeof global.scheduleLoadChatList === 'function') global.scheduleLoadChatList();
                } catch (e) {}
            })
            .catch(function (err) {
                // fetch 失败（离线、file://、片段 404）时仍保证聊天按钮可用
                console.warn('[Wechat] loadHtmlFragments failed, continuing:', err && err.message ? err.message : err);
                postFragmentBind();
                if (typeof prevInit === 'function') prevInit.call(self);
                try {
                    if (typeof global.scheduleLoadChatList === 'function') global.scheduleLoadChatList();
                } catch (e) {}
            });
    }

    var Wechat = {
        version: '0.1.0-shell',
        /** @type {Record<string, unknown>} 阶段 1 挂载数据层 API */
        store: {},
        /** @type {Record<string, unknown>} 阶段 2 挂载提示词拼装 */
        prompts: {},
        /** @type {Record<string, unknown>} 阶段 3 挂载 UI 实现 */
        ui: {},
        /**
         * 由 app.js 的 initApp() 调用。先加载已拆出的静态 HTML 片段，再继续执行后续 UI 初始化链。
         */
        init: function () {
            return runWechatInit(function () {}, this);
        }
    };

    global.Wechat = Wechat;
})(typeof window !== 'undefined' ? window : this);
