import { renderCardFace, releaseFaceCache } from './upstream/tarot/cardface.js';

export const ART_CACHE = 'lego-milian-tarot-art-v2';
export const STATIC_CACHE = 'lego-milian-tarot-static-v2';
let queue = Promise.resolve();
let generation = 0;
const objectUrls = new Map();
export function releaseImages() {
  generation++;
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear(); releaseFaceCache();
}
export function cardImage(card) {
  if (objectUrls.has(card.id)) return Promise.resolve(objectUrls.get(card.id));
  const ownGeneration = generation;
  const job = queue.catch(() => {}).then(async () => {
    if (ownGeneration !== generation) return '';
    if (objectUrls.has(card.id)) return objectUrls.get(card.id);
    const request = new Request(new URL('card-images/v2/' + card.id + '.png', import.meta.url));
    let cache, blob;
    try { cache = await caches.open(ART_CACHE); blob = await (await cache.match(request))?.blob(); } catch (_) {}
    if (!blob) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (ownGeneration !== generation) return '';
      const canvas = renderCardFace(card);
      blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('牌面绘制失败')), 'image/png'));
      releaseFaceCache();
      if (cache && ownGeneration === generation) {
        try { await cache.put(request, new Response(blob, { headers: { 'Content-Type': 'image/png' } })); } catch (_) {}
      }
    }
    if (ownGeneration !== generation) return '';
    const url = URL.createObjectURL(blob); objectUrls.set(card.id, url); return url;
  });
  queue = job;
  return job;
}
export async function clearTarotCache() {
  releaseImages();
  await queue.catch(() => {});
  if (!('caches' in globalThis)) return;
  const names = await caches.keys();
  await Promise.all(names.filter(name => name.startsWith('lego-milian-tarot-art-') || name.startsWith('lego-milian-tarot-static-')).map(name => caches.delete(name)));
}
export async function cacheInformation() {
  try {
    const keys = await caches.keys();
    const cache = keys.includes(ART_CACHE) ? await caches.open(ART_CACHE) : null;
    const staticCache = keys.includes(STATIC_CACHE) ? await caches.open(STATIC_CACHE) : null;
    const required = ['index.html', 'app.js', 'style.css', 'core.js', 'storage.js', 'prompts.js', 'cache.js',
      'upstream/tarot/cards.js', 'upstream/tarot/spreads.js', 'upstream/tarot/cardface.js', 'upstream/tarot/reading.js', 'upstream/companion/result.js'];
    const offline = !!staticCache && (await Promise.all(required.map(file => staticCache.match(new URL(file, import.meta.url))))).every(Boolean);
    return { cards: cache ? (await cache.keys()).length : 0, offline };
  } catch (_) { return { cards: 0, offline: false }; }
}
export async function registerOfflineCache() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('lego-milian-tarot-art-') && name !== ART_CACHE).map(name => caches.delete(name)));
    return true;
  } catch (_) { return false; }
}
