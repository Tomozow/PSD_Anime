// 直前に開いた PSD 本体を IndexedDB に保持する。
// localStorage には入らないサイズなので IndexedDB を使う。
// これにより、リロードしても「作業していたPSD + その設定」がそのまま戻る。

const DB_NAME = 'psd-anime';
const STORE = 'files';
const KEY = 'last';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const store = db.transaction(STORE, mode).objectStore(STORE);
      const req = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveLastFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    await tx('readwrite', (s) => s.put({ name: file.name, buffer, savedAt: Date.now() }, KEY));
  } catch (err) {
    console.warn('PSDの保持に失敗しました', err);
  }
}

export async function loadLastFile() {
  try {
    const rec = await tx('readonly', (s) => s.get(KEY));
    if (!rec) return null;
    return new File([rec.buffer], rec.name, { type: 'image/vnd.adobe.photoshop' });
  } catch {
    return null;
  }
}

export async function clearLastFile() {
  try {
    await tx('readwrite', (s) => s.delete(KEY));
  } catch {
    /* noop */
  }
}
