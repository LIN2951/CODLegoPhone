const DB_NAME = 'LegoCompanionReadingShelf';
let database;

function openDatabase() {
    database ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            db.createObjectStore('catalog').createIndex('scope', 'scope');
            db.createObjectStore('content');
            db.createObjectStore('settings');
        };
        request.onsuccess = () => {
            request.result.onversionchange = () => {
                request.result.close();
                database = undefined;
            };
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
    }).catch(error => {
        database = undefined;
        throw error;
    });
    return database;
}

async function transact(names, mode, operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(names, mode);
        const store = name => transaction.objectStore(name);
        let value;
        const setResult = result => { value = result; };
        transaction.oncomplete = () => resolve(value);
        transaction.onabort = () => reject(transaction.error || new Error('保存被中止，请重试。'));
        try {
            operation(store, setResult);
        } catch (error) {
            transaction.abort();
            reject(error);
        }
    });
}

export function createShelfStore(scope) {
    const bookKey = id => [scope, id];
    function read(name, key) {
        return transact(name, 'readonly', (store, result) => {
            const request = store(name).get(key);
            request.onsuccess = () => result(request.result);
        });
    }

    return {
        list: () => transact('catalog', 'readonly', (store, result) => {
            const request = store('catalog').index('scope').getAll(scope);
            request.onsuccess = () => result(request.result);
        }),
        record: id => read('catalog', bookKey(id)),
        content: id => read('content', bookKey(id)),
        settings: () => read('settings', scope),
        saveSettings: settings => transact('settings', 'readwrite', store => {
            store('settings').put(settings, scope);
        }),
        add: (metadata, content) => transact(['catalog', 'content'], 'readwrite', store => {
            const record = { ...metadata, scope, addedAt: Date.now() };
            store('catalog').add(record, bookKey(metadata.id));
            store('content').add(content, bookKey(metadata.id));
        }),
        update: (id, changes, seed) => transact('catalog', 'readwrite', (store, result) => {
            const catalog = store('catalog');
            const key = bookKey(id);
            const request = catalog.get(key);
            request.onsuccess = () => {
                const previous = request.result ?? seed;
                if (!previous || previous.hidden) return;
                const patch = typeof changes === 'function' ? changes(previous) : changes;
                const record = { ...previous, ...patch, id, scope };
                catalog.put(record, key);
                result(record);
            };
        }),
        remove: (id, { hide = false } = {}) => transact(['catalog', 'content'], 'readwrite', store => {
            const key = bookKey(id);
            if (hide) store('catalog').put({ id, scope, hidden: true }, key);
            else store('catalog').delete(key);
            store('content').delete(key);
        })
    };
}
