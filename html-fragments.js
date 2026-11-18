(function (global) {
    'use strict';

    // 构建时合并（无运行时 fetch）：npm run build:html → dist/index-inlined.html（见 scripts/inline-html-fragments.js）
    // 注意：不要在此处加载 chat-page / chat-modals 片段。
    // index.html 已内联完整聊天页与聊天模态（含表情面板、更多面板等）；
    // 若再 fetch 注入，会产生第二个 #chat-page、重复的 #emoji-panel / #chat-more-panel，
    // 导致 showPage('chat') 与 getElementById 命中「未绑定事件、未 init 表情」的那一份 DOM，
    // 表现为底部「接收」「更多」无反应、表情列表空白。
    var FRAGMENT_HOSTS = [
        {
            anchorId: 'wechat-page-fragment-anchor',
            path: 'fragments/wechat-page.html'
        },
        {
            anchorId: 'wechat-me-page-fragment-anchor',
            path: 'fragments/wechat-me-page.html'
        },
        {
            anchorId: 'wechat-settings-page-fragment-anchor',
            path: 'fragments/wechat-settings-page.html'
        }
    ];

    function injectHtmlBefore(anchor, html) {
        if (!anchor) return;
        anchor.insertAdjacentHTML('beforebegin', html);
        anchor.remove();
    }

    function loadFragment(host) {
        var anchor = document.getElementById(host.anchorId);
        if (!anchor) return Promise.resolve();
        return fetch(host.path, { cache: 'no-store' })
            .then(function (response) {
                if (!response.ok) throw new Error('Failed to load fragment: ' + host.path);
                return response.text();
            })
            .then(function (html) {
                injectHtmlBefore(anchor, html);
            });
    }

    function loadHtmlFragments() {
        return FRAGMENT_HOSTS.reduce(function (promise, host) {
            return promise.then(function () {
                return loadFragment(host);
            });
        }, Promise.resolve());
    }

    global.loadHtmlFragments = loadHtmlFragments;
})(typeof window !== 'undefined' ? window : globalThis);
