// Tiny IndexedDB store for the FileSystemDirectoryHandle.
// Handles cannot go through chrome.storage (not structured-clone-safe there),
// so they live in IndexedDB on the extension origin, shared by popup + offscreen.
const CGPT_DB = "cgpt-dl";
const CGPT_STORE = "handles";

function cgptOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(CGPT_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(CGPT_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function cgptSetHandle(handle) {
  const db = await cgptOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(CGPT_STORE, "readwrite");
    tx.objectStore(CGPT_STORE).put(handle, "dir");
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function cgptGetHandle() {
  const db = await cgptOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(CGPT_STORE, "readonly");
    const q = tx.objectStore(CGPT_STORE).get("dir");
    q.onsuccess = () => res(q.result || null);
    q.onerror = () => rej(q.error);
  });
}

async function cgptClearHandle() {
  const db = await cgptOpen();
  return new Promise((res, rej) => {
    const tx = db.transaction(CGPT_STORE, "readwrite");
    tx.objectStore(CGPT_STORE).delete("dir");
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
