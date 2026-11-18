'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function includes(source, token, message) {
    assert(source.includes(token), message + `（缺少：${token}）`);
}

includes(html, 'onclick="openMusicAddMenu()"', '播放列表添加按钮必须打开来源菜单');
includes(html, 'id="music-add-source-modal"', '缺少本地上传/联网搜索来源菜单');
includes(html, 'onclick="chooseLocalMusicUpload()"', '缺少本地上传入口');
includes(html, 'onclick="openMusicOnlineSearch()"', '缺少联网搜索入口');
includes(html, 'id="music-search-title"', '缺少歌名输入框');
includes(html, 'id="music-search-artist"', '缺少歌手输入框');
includes(html, 'onsubmit="searchOnlineMusic(event)"', '联网搜索表单未接通');
includes(html, 'aria-label="歌曲列表" tabindex="0"', '隐形滚动区域缺少键盘入口');
assert(/id="api-settings-page"[\s\S]*?<div class="settings-content" role="region" aria-label="API 设置内容" tabindex="0">/.test(html), 'API 设置隐形滚动区域缺少键盘入口');
includes(html, 'style.css?v=0.1.6-music-add', '样式缓存版本未更新');
const appVersion = html.match(/app\.js\?v=(\d+)\.(\d+)\.(\d+)/);
assert(appVersion && (Number(appVersion[1]) * 1000000 + Number(appVersion[2]) * 1000 + Number(appVersion[3])) >= 1008036, '脚本缓存版本必须至少为 1.8.36');
assert(!html.includes("onclick=\"document.getElementById('music-upload-input').click()\">添加</button>"), '播放列表添加按钮仍绕过来源菜单');

assert(/\.music-playlist-list\s*\{[\s\S]*?scrollbar-width:\s*none;/.test(css), '播放列表滚动条未隐藏');
assert(/\.music-playlist-list::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none;/.test(css), '播放列表 WebKit 滚动条未隐藏');
assert(/#api-settings-page \.settings-content\s*\{[\s\S]*?scrollbar-width:\s*none;/.test(css), 'API 设置滚动条未隐藏');
assert(/#api-settings-page \.settings-content::\-webkit-scrollbar\s*\{[\s\S]*?display:\s*none;/.test(css), 'API 设置 WebKit 滚动条未隐藏');
includes(css, 'touch-action: pan-y;', '隐藏滚动条后必须保留触摸纵向滚动');
includes(css, 'overscroll-behavior: contain;', '滚动区域缺少边界约束');

includes(app, 'function getLocalMusicFileKey(file)', '本地音频缺少稳定重复判断');
includes(app, 'function validateMusicBlobPlayable(blob, timeoutMs)', '本地/在线音频缺少可播放性校验');
includes(app, 'file.size > MAX_MUSIC_SIZE_MB * 1024 * 1024', '本地音频缺少大小限制');
includes(app, "fetch('/api/music/search?'", '客户端未调用同源音乐搜索接口');
includes(app, "fetch('/api/music/audio?'", '客户端未调用同源音频缓存接口');
includes(app, 'remoteId: String(result.id)', '在线歌曲缺少持久化来源标识');
includes(app, 'const saved = await savePlaylistToIndexedDB();', '添加完成前未确认 IndexedDB 持久化');
includes(app, 'MusicPlayer.playlist = MusicPlayer.playlist.filter', '持久化失败时缺少列表回滚');
includes(app, 'MusicOnlineSearchState.downloadController.abort()', '关闭搜索页时未取消下载');
includes(app, 'localFileKey: t.localFileKey ||', '备份/恢复链路未保留本地歌曲去重标识');
includes(app, 'musicPlaylistPersistQueue.then(commit, commit)', '播放列表写入未串行化，旧快照可能覆盖新列表');
includes(app, 'searchSequence', '联网搜索缺少迟到响应隔离');
includes(app, 'downloadSequence', '音频缓存缺少关闭/切换隔离');
includes(app, 'function handleMusicPlaylistItemKeydown(event, index)', '播放列表歌曲缺少键盘选择支持');

includes(server, "urlPath === '/api/music/search'", '服务端缺少音乐搜索路由');
includes(server, "urlPath === '/api/music/audio'", '服务端缺少音频代理路由');
includes(server, "const MUSIC_SEARCH_SOURCE = 'netease';", '服务端音乐来源未收敛');
includes(server, "br: '128'", '音频缓存未请求适合本地存储的低码率版本');
includes(server, 'const MUSIC_AUDIO_MAX_BYTES = 45 * 1024 * 1024;', '服务端缺少音频大小上限');
includes(server, 'function isAllowedNeteaseAudioUrl(input)', '音频代理缺少上游域名白名单');
includes(server, 'function isAllowedMusicSearchApiUrl(input)', '搜索代理缺少固定上游白名单');
includes(server, 'redirectsLeft - 1, urlValidator', '音频重定向未持续执行域名白名单校验');
includes(server, "'Cache-Control': 'no-store'", '搜索/下载响应可能误缓存临时音源');

console.log('OK: music playlist source menu, online cache, persistence, scroll and proxy guards');
