// Runs in a DOM context so it can hold the FileSystemDirectoryHandle and write files.
// The service worker cannot do this itself.

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 1; i < 500; i++) {
    try {
      await dir.getFileHandle(candidate, { create: false });
      candidate = `${base}-${i}${ext}`; // taken, try next
    } catch {
      return candidate; // not found = free
    }
  }
  return `${base}-${Date.now()}${ext}`;
}

async function resolveDir(dir, subpath) {
  let cur = dir;
  for (const part of (subpath || "").split("/").filter(Boolean)) {
    cur = await cur.getDirectoryHandle(part, { create: true });
  }
  return cur;
}

async function writeToFolder({ url, filename, subpath }) {
  const root = await cgptGetHandle();
  if (!root) return { ok: false, reason: "no-folder" };

  const perm = await root.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") return { ok: false, reason: "no-permission" };

  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return { ok: false, reason: `fetch-${res.status}` };
  const blob = await res.blob();

  const dir = await resolveDir(root, subpath);
  const name = await uniqueName(dir, filename);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return { ok: true, name };
}

let lastZipUrl = null;
let tickTimer = null;

// Chrome clamps timers in a hidden tab to about one per minute. This document
// is not a tab, so its clock keeps real time — it drives the run instead.
function setTicker(on) {
  clearInterval(tickTimer);
  tickTimer = null;
  if (on) tickTimer = setInterval(() => chrome.runtime.sendMessage({ type: "tick-source" }), 1000);
}

async function buildZip({ items, folder }) {
  const entries = [];
  for (const it of items) {
    try {
      const res = await fetch(it.url, { credentials: "include" });
      if (!res.ok) continue;
      entries.push({ name: it.name, bytes: new Uint8Array(await res.arrayBuffer()) });
    } catch {}
  }
  if (!entries.length) return { ok: false, reason: "no images could be fetched" };

  // If the user picked a real folder, write the zip straight into it.
  const blob = makeZip(entries);
  if (folder) {
    const root = await cgptGetHandle();
    if (root && (await root.queryPermission({ mode: "readwrite" })) === "granted") {
      const name = await uniqueName(root, folder);
      const fh = await root.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return { ok: true, count: entries.length, written: name };
    }
  }

  if (lastZipUrl) URL.revokeObjectURL(lastZipUrl);
  lastZipUrl = URL.createObjectURL(blob);
  return { ok: true, count: entries.length, url: lastZipUrl, size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "write-file") {
    writeToFolder(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === "ticker") {
    setTicker(msg.on);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "make-zip") {
    buildZip(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
  if (msg.type === "check-folder") {
    cgptGetHandle()
      .then(async (h) => {
        if (!h) return sendResponse({ ok: false, reason: "no-folder" });
        const p = await h.queryPermission({ mode: "readwrite" });
        sendResponse(p === "granted" ? { ok: true, name: h.name } : { ok: false, reason: "no-permission", name: h.name });
      })
      .catch((e) => sendResponse({ ok: false, reason: String(e) }));
    return true;
  }
});
