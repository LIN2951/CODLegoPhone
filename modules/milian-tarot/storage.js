import { normalizeSession, makeBackup, parseBackup, MAX_RECORDS } from './core.js';

export const DATABASE_NAME = 'LegoMilianTarotDB';
let opened;
let generation = 0;
export function openDatabase() {
  if (opened) return opened;
  opened = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    let expired = false;
    const timer = setTimeout(() => { expired = true; reject(new Error('塔罗存储暂不可用，请关闭旧塔罗页面后重试')); }, 6000);
    request.onupgradeneeded = () => {
      const db = request.result;
      const records = db.createObjectStore('sessions', { keyPath: 'id' });
      records.createIndex('scope', 'scope', { unique: false });
      db.createObjectStore('preferences', { keyPath: 'scope' });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      if (expired) { db.close(); return; }
      db.onversionchange = () => { db.close(); opened = null; };
      const tx = db.transaction('preferences', 'readonly');
      const marker = tx.objectStore('preferences').get('__generation');
      marker.onsuccess = () => { generation = marker.result?.generation || 0; };
      tx.oncomplete = () => resolve(db);
      tx.onabort = () => { db.close(); reject(new Error('无法读取塔罗存储状态')); };
    };
    request.onerror = () => { clearTimeout(timer); reject(new Error('无法保存塔罗记录，请检查浏览器存储权限或可用空间')); };
  }).catch(error => { opened = null; throw error; });
  return opened;
}

async function transaction(names, mode, work, reset = false) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(mode === 'readwrite' ? [...new Set([...names, 'preferences'])] : names, mode);
    let result, error;
    const fail = err => { error = err; try { tx.abort(); } catch (_) {} };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(error || new Error('塔罗记录未保存：存储空间不足或写入被中断'));
    tx.onerror = () => {};
    const run = () => { try { work(tx, value => { result = value; }, fail); } catch (err) { fail(err); } };
    if (mode === 'readwrite' && !reset) {
      tx.objectStore('preferences').get('__generation').onsuccess = event => {
        if ((event.target.result?.generation || 0) !== generation) { fail(new Error('塔罗数据已被清空，请关闭旧页面后重新进入')); return; }
        run();
      };
    } else run();
  });
}

export const getSession = (id, scope) => transaction(['sessions'], 'readonly', (tx, done) => {
  tx.objectStore('sessions').get(id).onsuccess = event => {
    const value = event.target.result;
    done(value && value.scope === scope ? value : null);
  };
});
export const listSessions = scope => transaction(['sessions'], 'readonly', (tx, done) => {
  const records = tx.objectStore('sessions');
  const req = scope ? records.index('scope').getAll(scope) : records.getAll();
  req.onsuccess = () => done(req.result.sort((a, b) => b.createdAt - a.createdAt));
});
export const getPreferences = scope => transaction(['preferences'], 'readonly', (tx, done) => {
  tx.objectStore('preferences').get(scope).onsuccess = event => done(event.target.result || { scope });
});
export const setPreferences = (scope, patch) => transaction(['preferences'], 'readwrite', tx => {
  const preferences = tx.objectStore('preferences');
  preferences.get(scope).onsuccess = event => {
    const value = { ...(event.target.result || { scope }) };
    for (const key of ['activeId', 'question', 'spreadChoice', 'reversals']) if (Object.hasOwn(patch, key)) value[key] = patch[key];
    preferences.put(value);
  };
});

export async function addSession(session) {
  const record = normalizeSession(session);
  return transaction(['sessions', 'preferences'], 'readwrite', (tx, done, fail) => {
    const records = tx.objectStore('sessions');
    records.index('scope').count(record.scope).onsuccess = event => {
      if (event.target.result >= MAX_RECORDS) { fail(new Error('此空间已有 500 条记录，请先导出并删除部分旧记录')); return; }
      records.add(record);
      const prefs = tx.objectStore('preferences');
      prefs.get(record.scope).onsuccess = event => prefs.put({ ...(event.target.result || {}), scope: record.scope, activeId: record.id });
      done(record);
    };
  });
}

export function updateSession(id, scope, revision, change) {
  return transaction(['sessions'], 'readwrite', (tx, done, fail) => {
    const records = tx.objectStore('sessions');
    records.get(id).onsuccess = event => {
      try {
        const current = event.target.result;
        if (!current || current.scope !== scope) throw new Error('记录已被删除或属于其他空间');
        if (current.revision !== revision) throw new Error('记录已在另一页面更新，已重新同步，请重试');
        const next = normalizeSession({ ...change(structuredClone(current)), id, scope, revision: current.revision + 1, updatedAt: Date.now() });
        records.put(next); done(next);
      } catch (error) { fail(error); }
    };
  });
}

// Completion must still own the persisted request. Deleting/importing/cancelling never resurrects a record.
export function finishRequest(id, scope, kind, requestId, patch, allowUnknown = false) {
  return transaction(['sessions'], 'readwrite', (tx, done, fail) => {
    const records = tx.objectStore('sessions');
    records.get(id).onsuccess = event => {
      try {
        const current = event.target.result;
        const status = current?.[kind]?.status;
        if (!current || current.scope !== scope || !(status === 'running' || (allowUnknown && status === 'unknown')) || current[kind].requestId !== requestId) { done(null); return; }
        const next = normalizeSession({ ...current, revision: current.revision + 1, updatedAt: Date.now(),
          [kind]: { ...current[kind], ...patch, finishedAt: Date.now() } });
        records.put(next); done(next);
      } catch (error) { fail(error); }
    };
  });
}

export const deleteSession = (id, scope) => transaction(['sessions', 'preferences'], 'readwrite', tx => {
  const records = tx.objectStore('sessions');
  records.get(id).onsuccess = event => { if (event.target.result?.scope === scope) records.delete(id); };
  const prefs = tx.objectStore('preferences');
  prefs.get(scope).onsuccess = event => { const value = event.target.result; if (value?.activeId === id) prefs.put({ ...value, activeId: '' }); };
});

export async function exportBackup(scope) { return makeBackup(await listSessions(scope)); }

export function clearAllData() {
  return transaction(['sessions', 'preferences'], 'readwrite', (tx, done) => {
    const prefs = tx.objectStore('preferences');
    prefs.get('__generation').onsuccess = event => {
      const next = (event.target.result?.generation || 0) + 1;
      tx.objectStore('sessions').clear(); prefs.clear();
      prefs.put({ scope: '__generation', generation: next });
      done(next);
    };
  }, true).then(next => { generation = next; });
}

export async function importBackup(backup, targetScope) {
  const imported = parseBackup(backup, targetScope);
  return transaction(['sessions'], 'readwrite', (tx, done, fail) => {
    const records = tx.objectStore('sessions');
    records.getAll().onsuccess = event => {
      try {
        const existing = event.target.result;
        const known = new Map(existing.map(r => [r.id, r]));
        const counts = new Map();
        for (const record of existing) counts.set(record.scope, (counts.get(record.scope) || 0) + 1);
        const additions = [];
        for (const record of imported) {
          const old = known.get(record.id);
          if (old) {
            if (old.scope !== record.scope || old.question !== record.question || old.createdAt !== record.createdAt || JSON.stringify(old.deck) !== JSON.stringify(record.deck)) throw new Error('备份记录与已有记录标识冲突，未导入任何记录');
            continue; // Never overwrite a newer local record with an older backup.
          }
          const count = (counts.get(record.scope) || 0) + 1;
          if (count > MAX_RECORDS) throw new Error('导入后超过每个空间 500 条上限，请先导出并整理历史');
          counts.set(record.scope, count); additions.push(record);
        }
        for (const record of additions) records.add(record);
        done({ added: additions.length, skipped: imported.length - additions.length });
      } catch (error) { fail(error); }
    };
  });
}
