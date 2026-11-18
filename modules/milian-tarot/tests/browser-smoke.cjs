'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createFixture } = require('./fixture-server.cjs');
const playwrightPath = process.argv[2];
if (!playwrightPath) throw new Error('Pass the absolute installed Playwright package path as argument 1');
const { chromium } = require(playwrightPath);
const browserPath = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const output = path.resolve(__dirname, '../../../.claude/milian-tarot-review/verification');
fs.mkdirSync(output, { recursive: true });
const { service, state } = createFixture();
const report = { browser: browserPath, checks: [], screenshots: [], errors: [], blockedExternalRequests: 0 };
function pass(name, details) { report.checks.push({ name, passed: true, ...(details ? { details } : {}) }); console.log('PASS ' + name); }
async function until(test, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) { if (Date.now() > deadline) throw new Error('Condition timed out'); await new Promise(r => setTimeout(r, 80)); }
}
(async () => {
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + service.address().port;
  let browser, page, ctx;
  try {
    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await ctx.route('**/*', route => {
      if (!route.request().url().startsWith(origin + '/')) { report.blockedExternalRequests++; return route.abort(); }
      return route.continue();
    });
    page = await ctx.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    const open = async target => {
      await target.locator('#couple-private-tarot-btn').click();
      const frame = await (await target.waitForSelector('#lego-milian-tarot-layer iframe')).contentFrame();
      await frame.waitForFunction(() => !!document.querySelector('#question, .card-grid'), { timeout: 15000 });
      return frame;
    };
    const saved = frame => frame.evaluate(async () => {
      const store = await import('/modules/milian-tarot/storage.js');
      const scope = parent.LegoMilianTarot.context(window).scope;
      return (await store.listSessions(scope))[0] || null;
    });
    const generate = async (frame, kind) => {
      await frame.locator('[data-action="generate"][data-kind="' + kind + '"]').click();
      if (await frame.locator('#dialog').isVisible()) await frame.locator('#dialog button[value="ok"]').click();
    };
    const screenshot = async name => {
      const file = path.join(output, name + '.png'); await page.screenshot({ path: file }); report.screenshots.push(file);
    };
    await page.goto(origin, { waitUntil: 'load' });
    let frame = await open(page);
    assert.equal(state.calls, 0); pass('real host entry opens the isolated module without API calls');
    await screenshot('home-390x844');
    await frame.locator('#question').fill('我们可以怎样更好地靠近彼此？');
    await frame.locator('#spread-choice').selectOption('three');
    await frame.locator('[data-action="start"]').click();
    await frame.locator('.deck-card').first().waitFor();
    assert.equal(await frame.locator('.deck-card').count(), 78);
    await frame.locator('.deck-card').nth(17).click();
    await until(async () => (await saved(frame))?.selected.length === 1);
    const once = await saved(frame);
    await frame.evaluate(() => location.reload());
    await frame.waitForFunction(() => document.querySelectorAll('.deck-card.selected').length === 1);
    const restored = await saved(frame);
    assert.deepEqual(restored.deck, once.deck); assert.deepEqual(restored.selected, once.selected);
    pass('partial draw reload retains all 78 cards, orientations and selection');
    await frame.locator('[data-action="auto-draw"]').click();
    await frame.locator('[data-action="reveal"]').waitFor();
    await frame.locator('[data-action="reveal"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('.tarot-card img').length === 3);
    const revealed = await saved(frame);
    assert.ok(revealed.revealed); assert.equal(state.calls, 0); pass('whole-group reveal renders original Canvas artwork with zero AI calls');
    await frame.waitForFunction(() => document.getAnimations().every(animation => animation.playState === 'finished'));
    const opacity = await frame.evaluate(() => [...document.querySelectorAll('.tarot-card img')].map(img => {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 896;
      const drawing = canvas.getContext('2d'); drawing.drawImage(img, 0, 0);
      return drawing.getImageData(256, 448, 1, 1).data[3];
    }));
    assert.ok(opacity.every(alpha => alpha >= 250)); pass('rounded clipping retains opaque, legible original artwork', opacity);
    await screenshot('revealed-390x844');
    await frame.locator('[data-action="detail"]').first().click();
    assert.ok((await frame.locator('#dialog-body').textContent()).includes('另一方向的牌义'));
    await frame.locator('#dialog button[value="ok"]').click(); pass('card details expose both original orientations and slot meaning');
    await generate(frame, 'reading');
    await until(async () => (await saved(frame)).reading.status === 'succeeded');
    await generate(frame, 'companion');
    await until(async () => (await saved(frame)).companion.status === 'succeeded');
    assert.equal(state.calls, 2);
    assert.ok(state.prompts[1].includes('让彼此的需要变得具体'));
    pass('host API bridge returns two distinct views with the same canonical draw and original synthesis');
    await screenshot('reading-390x844');
    await page.reload({ waitUntil: 'load' }); frame = await open(page);
    assert.equal((await saved(frame)).reading.status, 'succeeded'); assert.equal(state.calls, 2);
    assert.deepEqual((await saved(frame)).deck, revealed.deck); pass('full host reload restores saved draw and both readings without paid retry');

    const other = await ctx.newPage(); await other.goto(origin, { waitUntil: 'load' }); const otherFrame = await open(other);
    state.mode = 'delayed';
    const beforeRace = state.calls;
    await frame.locator('[data-action="generate"][data-kind="reading"]').click();
    await otherFrame.locator('[data-action="generate"][data-kind="reading"]').click();
    await Promise.all([frame.locator('#dialog button[value="ok"]').click(), otherFrame.locator('#dialog button[value="ok"]').click()]);
    await until(() => state.calls > beforeRace);
    await until(async () => (await saved(frame)).reading.status === 'succeeded');
    assert.equal(state.calls, beforeRace + 1); pass('two concurrent tabs commit only one paid request'); await other.close();
    await generate(frame, 'reading'); await frame.locator('[data-action="cancel"]').waitFor();
    await until(() => state.calls === beforeRace + 2);
    await frame.locator('[data-action="cancel"]').click();
    await until(async () => (await saved(frame)).reading.status === 'unknown');
    const afterCancel = await saved(frame);
    await new Promise(resolve => setTimeout(resolve, 3700));
    assert.equal((await saved(frame)).reading.status, 'unknown');
    assert.equal((await saved(frame)).reading.text, afterCancel.reading.text); pass('cancel rejects late completion and preserves prior reading');
    state.mode = 'failure'; const beforeFailure = state.calls;
    await generate(frame, 'reading'); await until(async () => (await saved(frame)).reading.status === 'unknown' && state.calls > beforeFailure);
    await new Promise(resolve => setTimeout(resolve, 1800)); assert.equal(state.calls, beforeFailure + 1);
    pass('401 releases controls, preserves cards and performs no automatic retry'); state.mode = 'success';

    await frame.evaluate(() => {
      window.fixtureOriginalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, ...args) {
        if (this.name === 'sessions' && value?.reading?.status === 'succeeded') throw new DOMException('fixture full disk', 'QuotaExceededError');
        return window.fixtureOriginalPut.call(this, value, ...args);
      };
    });
    const beforeSaveFailure = state.calls;
    await generate(frame, 'reading'); await frame.locator('[data-action="save-result"]').waitFor();
    await frame.evaluate(async () => {
      IDBObjectStore.prototype.put = window.fixtureOriginalPut;
      const store = await import('/modules/milian-tarot/storage.js');
      const scope = parent.LegoMilianTarot.context(window).scope; const record = (await store.listSessions(scope))[0];
      await store.updateSession(record.id, scope, record.revision, value => ({ ...value, reading: { ...value.reading, leaseUntil: 1 } }));
    });
    await until(async () => (await saved(frame)).reading.status === 'unknown');
    await frame.locator('[data-action="save-result"]').click();
    await until(async () => (await saved(frame)).reading.status === 'succeeded');
    assert.equal(state.calls, beforeSaveFailure + 1); pass('failed result persistence can be retried after lease expiry without another API call');

    const backup = await page.evaluate(async () => (await Wechat.backup.collectWechatDataAsync()).milianTarot);
    assert.equal(backup.records.length, 1); assert.ok(!JSON.stringify(backup).includes('fixture-only-never-real'));
    pass('whole-WeChat backup includes independent records without credentials');
    await frame.locator('#settings').click();
    const damaged = structuredClone(backup); damaged.records[0].deck[1] = damaged.records[0].deck[0];
    await frame.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(damaged)) });
    await until(async () => (await frame.locator('#notice').textContent()).includes('重复牌'));
    assert.equal((await saved(frame)).id, revealed.id); pass('malformed backup is rejected before any records are changed');
    await frame.locator('#import-file').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await frame.locator('#dialog button[value="ok"]').click();
    await until(async () => (await frame.locator('#notice').textContent()).includes('跳过已有 1'));
    pass('independent JSON import is idempotent and keeps the existing record');
    await page.evaluate(() => tarotFixtureOpen('tarot-fixture-b')); frame = await open(page);
    assert.ok(await frame.locator('#question').isVisible()); assert.equal(await saved(frame), null);
    pass('switching partners exposes neither the other draw nor history');
    await page.evaluate(async () => {
      const friends = loadFriendsFromStorage(); friends.find(f => f.id === 'tarot-fixture-a').persona.id = 'tarot-persona-other';
      await saveFriendsToStorageAsync(friends); await tarotFixtureOpen('tarot-fixture-a');
    }); frame = await open(page); assert.equal(await saved(frame), null); pass('switching personas isolates the same partner history');
    await page.evaluate(async () => {
      const friends = loadFriendsFromStorage(); friends.find(f => f.id === 'tarot-fixture-a').persona.id = 'tarot-persona-a';
      await saveFriendsToStorageAsync(friends); await tarotFixtureOpen('tarot-fixture-a');
    }); frame = await open(page);

    for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await frame.locator('#back').waitFor();
      const geometry = await frame.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        header: document.querySelector('.toolbar').getBoundingClientRect().height, height: innerHeight }));
      assert.equal(geometry.overflow, false); assert.ok(geometry.height > geometry.header + 100);
      await frame.locator('[data-action="new"]').scrollIntoViewIfNeeded();
      await screenshot('layout-' + viewport.width + 'x' + viewport.height);
      pass('scrollable viewport ' + viewport.width + 'x' + viewport.height, geometry);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await until(() => frame.evaluate(async () => {
      const cache = await caches.open('lego-milian-tarot-static-v2'); return (await cache.keys()).length >= 15 && !!navigator.serviceWorker.controller;
    }));
    const beforeOffline = state.calls;
    await ctx.setOffline(true); await frame.evaluate(() => location.reload());
    await frame.waitForFunction(() => document.querySelectorAll('.tarot-card img').length === 3);
    assert.equal(state.calls, beforeOffline); pass('offline iframe reload restores page, original artwork and records from independent caches');
    await ctx.setOffline(false);
    await frame.locator('#settings').click();
    await frame.evaluate(async () => { const c = await caches.open('fixture-unrelated-cache'); await c.put('/unrelated-fixture', new Response('keep')); });
    await frame.locator('[data-action="clear-cache"]').click(); await frame.locator('#dialog button[value="ok"]').click();
    await until(async () => (await frame.locator('#notice').textContent()).includes('完整保留'));
    assert.equal((await saved(frame)).id, revealed.id);
    assert.ok(await frame.evaluate(async () => !!(await (await caches.open('fixture-unrelated-cache')).match('/unrelated-fixture'))));
    pass('cache cleanup preserves records and unrelated cache namespaces');

    await page.evaluate(async () => {
      await LegoMilianTarot.close(false);
      window.fixtureSavedApi = localStorage.getItem('apiSettings'); localStorage.setItem('apiSettings', '{}');
    }); frame = await open(page);
    assert.ok(await frame.locator('[data-action="generate"]').first().isDisabled());
    await frame.locator('[data-action="detail"]').first().click();
    assert.ok((await frame.locator('#dialog-body').textContent()).includes('牌位：'));
    await frame.locator('#dialog button[value="ok"]').click();
    await page.evaluate(() => localStorage.setItem('apiSettings', window.fixtureSavedApi));
    pass('missing API settings disable paid actions while original card meanings remain usable');

    const downloadPromise = page.waitForEvent('download');
    await page.evaluate(() => exportAllData());
    const downloaded = await downloadPromise; const stream = await downloaded.createReadStream(); const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const fullBackupText = Buffer.concat(chunks).toString('utf8');
    const fullBackup = JSON.parse(fullBackupText.slice(fullBackupText.indexOf('{')));
    assert.equal(fullBackup.data.wechat.milianTarot.records.length, 1);
    const roundtrip = await page.evaluate(async raw => {
      const before = localStorage.getItem('friends'); const corrupted = structuredClone(raw);
      corrupted.data.wechat.milianTarot.records[0].deck[1] = corrupted.data.wechat.milianTarot.records[0].deck[0];
      let refused = false; try { await strictImportAllData(corrupted); } catch (_) { refused = true; }
      if (!refused || localStorage.getItem('friends') !== before) throw new Error('Malformed tarot backup changed host data');
      await LegoMilianTarot.clearAllData(); await strictImportAllData(raw);
      return { records: (await LegoMilianTarot.exportBackup()).records,
        pair: Wechat.store.coupleSpace.getPair('tarot-fixture-a'), persona: loadFriendsFromStorage().find(f => f.id === 'tarot-fixture-a').persona };
    }, fullBackup);
    assert.equal(roundtrip.records[0].id, revealed.id); assert.deepEqual(roundtrip.records[0].deck, revealed.deck);
    assert.equal(roundtrip.pair.acceptedAt, 1767225600000); assert.equal(roundtrip.persona.id, 'tarot-persona-a');
    pass('real whole-app export/import roundtrip retains tarot ownership and rejects corrupt payload before host clearing');
    await page.evaluate(() => tarotFixtureOpen('tarot-fixture-a')); frame = await open(page);
    await frame.locator('#history').click(); await frame.locator('.history-item').first().click();
    assert.equal((await saved(frame)).id, revealed.id); pass('restored tarot record is reachable through the actual partner entry');

    const dbChecks = await frame.evaluate(async () => {
      const s = await import('/modules/milian-tarot/storage.js'); const c = await import('/modules/milian-tarot/core.js');
      const checks = []; const verify = (v, name) => { if (!v) throw new Error(name); checks.push(name); };
      const seed = c.createSession({ scope: 'fixture_db_scope', userName: 'Test', friendName: 'Test' }, 'Test', 'single', false);
      let r = await s.addSession(seed);
      const competing = await Promise.allSettled([s.updateSession(r.id, r.scope, r.revision, v => c.selectCard(v, 0)), s.updateSession(r.id, r.scope, r.revision, v => c.selectCard(v, 1))]);
      verify(competing.filter(v => v.status === 'fulfilled').length === 1, 'native IDB CAS has one winner');
      r = await s.getSession(r.id, r.scope); const before = JSON.stringify(r);
      try { await s.updateSession(r.id, r.scope, r.revision, () => { throw new DOMException('fixture quota', 'QuotaExceededError'); }); } catch (_) {}
      verify(JSON.stringify(await s.getSession(r.id, r.scope)) === before, 'aborted transaction preserves original record');
      r = await s.updateSession(r.id, r.scope, r.revision, c.revealCards);
      r = await s.updateSession(r.id, r.scope, r.revision, v => ({ ...v, reading: { status: 'running', text: '', requestId: 'fixture_pending', leaseUntil: Date.now() + 10000 } }));
      const exported = await s.exportBackup(r.scope); await s.deleteSession(r.id, r.scope);
      verify(await s.finishRequest(r.id, r.scope, 'reading', 'fixture_pending', { status: 'succeeded', text: 'late' }) === null, 'deleted record cannot be resurrected');
      await s.importBackup(exported); r = await s.getSession(r.id, r.scope);
      verify(r.reading.status === 'unknown', 'imported interrupted request is unknown, never running again');
      verify(await s.getSession(r.id, 'another_scope') === null, 'IDB reads enforce scope');
      const stale = await import('/modules/milian-tarot/storage.js?fixture-stale-generation'); await stale.openDatabase();
      await s.clearAllData();
      let refused = false; try { await stale.setPreferences('fixture_db_scope', { question: 'late draft' }); } catch (_) { refused = true; }
      verify(refused && (await s.listSessions()).length === 0, 'clear-all generation blocks stale drafts and records');
      return checks;
    });
    dbChecks.forEach(name => pass(name));
    assert.deepEqual(report.errors, []); pass('no uncaught browser page errors');
    report.calls = state.calls; report.passed = true;
  } catch (error) {
    report.passed = false; report.failure = error.stack; console.error(error.stack);
    if (page) {
      try { await page.screenshot({ path: path.join(output, 'failure.png') });
        fs.writeFileSync(path.join(output, 'failure-text.txt'), (await page.locator('body').innerText()) + '\nFRAMES\n' + (await Promise.all(page.frames().map(f => f.locator('body').innerText().catch(() => '')))).join('\n'), 'utf8'); } catch (_) {}
    }
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    await browser?.close(); await new Promise(resolve => service.close(resolve));
  }
})();
