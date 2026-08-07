/* dls-store.js -- persists a *reference* to the user's gm.dls file across
 * sessions, not the file itself. Uses the File System Access API's
 * FileSystemFileHandle: the browser (not this site) owns and enforces
 * permission for that handle, and IndexedDB stores only the handle object
 * (it's structured-cloneable) -- never the file's bytes, and nothing is
 * ever written to disk or uploaded anywhere. This is the same model
 * Photopea uses to remember a locally-loaded font across visits: a
 * pointer the browser re-confirms access to, not a copy.
 *
 * Chromium-family only (Chrome/Edge/Brave/Opera) -- Firefox and Safari
 * don't implement the File System Access API. Every function here
 * degrades to a no-op/null on unsupported browsers rather than throwing,
 * so callers never need their own capability branch beyond checking the
 * return value.
 */
"use strict";

const DB_NAME = "slopgs-player";
const STORE_NAME = "handles";
const DLS_KEY = "gmdls";

function hasFileSystemAccess() {
  return typeof window.showOpenFilePicker === "function";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Best-effort only: losing the remembered handle just means the next
 * visit falls back to the normal drop prompt, never a hard failure. */
async function saveDlsHandle(handle) {
  if (!hasFileSystemAccess()) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(handle, DLS_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignored -- see doc comment above.
  }
}

/** Returns the stored FileSystemFileHandle, or null if none/unsupported. */
async function loadDlsHandle() {
  if (!hasFileSystemAccess()) return null;
  try {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(DLS_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

async function clearDlsHandle() {
  if (!hasFileSystemAccess()) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(DLS_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignored -- worst case a stale handle just fails permission/getFile()
    // next time, and callers already treat that as "forget it and re-prompt."
  }
}

window.SlopgsDlsStore = { hasFileSystemAccess, saveDlsHandle, loadDlsHandle, clearDlsHandle };
