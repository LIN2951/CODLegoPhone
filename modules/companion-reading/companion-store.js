const DATABASE = 'LegoCompanionReadingConversations';
const STORE = 'conversations';
let connection;

function openDatabase() {
    if (connection) return connection;

    connection = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: ['scope', 'bookId'] });
        request.onblocked = () => {
            blocked = true;
            reject(new Error('共读记录正在被其他页面使用，请关闭旧页面后重试。'));
        };
        request.onerror = () => reject(new Error('无法打开共读记录，请检查浏览器存储权限。'));
        request.onsuccess = () => {
            const db = request.result;
            if (blocked) { db.close(); return; }
            db.onversionchange = () => { db.close(); connection = undefined; };
            db.onclose = () => { connection = undefined; };
            resolve(db);
        };
    }).catch(error => { connection = undefined; throw error; });

    return connection;
}

export async function readCompanionState(scope, bookId) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get([scope, bookId]);
        tx.oncomplete = () => resolve(request.result ?? null);
        tx.onabort = () => reject(new Error('无法读取共读记录，请重新打开书籍。'));
    });
}

export async function readCompanionScope(scope) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const range = IDBKeyRange.bound([scope], [scope, []]);
        const request = tx.objectStore(STORE).getAll(range);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(new Error('无法恢复共读留言，请重新打开相伴阅读。'));
    });
}

// The read, ownership check and replacement share one transaction across all tabs.
export async function changeCompanionState(scope, bookId, change) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const records = tx.objectStore(STORE);
        const key = [scope, bookId];
        const request = records.get(key);
        let next, error;

        request.onsuccess = () => {
            try {
                next = change(request.result ?? null);
                if (next === null) records.delete(key);
                else if (next !== undefined) records.put(next);
            } catch (cause) {
                error = cause;
                tx.abort();
            }
        };
        tx.oncomplete = () => resolve(next ?? null);
        tx.onabort = () => reject(error || new Error('共读记录保存失败，请检查浏览器可用空间后重试。'));
    });
}
