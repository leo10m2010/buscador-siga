const DB_NAME = 'siga-catalogo';
const STORE_NAME = 'database';
const VERSION_KEY = 'db-version';
const DATA_KEY = 'sqlite-data';

window.saveDatabaseToIndexedDB = async function saveDatabaseToIndexedDB(arrayBuffer, version) {
  return new Promise((resolve, reject) => {
    // Use version 2 to force store creation
    const request = indexedDB.open(DB_NAME, 2);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        // Delete and retry if store is still missing
        indexedDB.deleteDatabase(DB_NAME).onsuccess = () => {
          window.saveDatabaseToIndexedDB(arrayBuffer, version).then(resolve).catch(reject);
        };
        return;
      }

      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      if (!(arrayBuffer instanceof ArrayBuffer)) {
        return reject(new Error('Invalid database buffer'));
      }
      store.put(arrayBuffer, DATA_KEY);
      store.put(version, VERSION_KEY);

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };

    request.onerror = () => reject(request.error);
  });
};

let openFailures = 0;

window.loadDatabaseFromIndexedDB = async function loadDatabaseFromIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onsuccess = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        openFailures++;
        resolve(null);
        return;
      }

      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);

      const versionReq = store.get(VERSION_KEY);
      const dataReq = store.get(DATA_KEY);

      let version = null;
      let data = null;

      versionReq.onsuccess = () => { version = versionReq.result; };
      dataReq.onsuccess = () => { data = dataReq.result; };

      tx.oncomplete = () => {
        db.close();
        openFailures = 0; // reset on success

        if (data && data instanceof ArrayBuffer) {
          resolve({ data, version });
        } else {
          resolve(null);
        }
      };

      tx.onerror = () => {
        db.close();
        openFailures++;
        reject(tx.error);
      };
    };

    request.onerror = () => {
      openFailures++;
      reject(request.error);
    };
  });
}

window.getStoredVersion = async function getStoredVersion() {
  try {
    const result = await window.loadDatabaseFromIndexedDB();
    return result?.version || null;
  } catch {
    return null;
  }
};

window.clearDatabaseCache = async function clearDatabaseCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.delete(DATA_KEY);
      store.delete(VERSION_KEY);

      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };

    request.onerror = () => reject(request.error);
  });
}

// Auto-cleanup if too many failures
setTimeout(() => {
  if (openFailures >= 3) {
    console.warn('[Buscador SIGA] Demasiados fallos en IndexedDB. Limpiando caché...');
    window.clearDatabaseCache?.().catch(() => {});
  }
}, 10000);
