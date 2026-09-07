// Routing: if the user picked a real folder, writes go through the offscreen
// document (File System Access). Otherwise fall back to chrome.downloads,
// which can only write inside the browser's Downloads folder.

const DEFAULTS = { mode: "downloads", subfolder: "ChatGPT", folderName: "", perConversation: false };

const getCfg = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) });

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
}

function extFor(url, mime) {
  if (url.startsWith("data:") && mime) return (mime.split("/")[1] || "png").split("+")[0];
  try {
    const m = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif|svg)$/i);
    if (m) return m[1].toLowerCase();
  } catch {}
  return "png";
}

function baseName({ url, convo, index, mime, name }) {
  const ext = extFor(url, mime);
  // Batch runs supply their own name (e.g. "frame-3"); ad-hoc saves get date_convo_NN.
  if (name) return `${sanitize(name)}.${ext}`;
  const stamp = new Date().toISOString().slice(0, 10);
  const n = String(index ?? 1).padStart(2, "0");
  return `${stamp}_${sanitize(convo || "chat")}_${n}.${ext}`;
}

// --- offscreen document ---
let creating;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Write downloaded images into the folder the user selected."
      })
      .finally(() => (creating = null));
  }
  await creating;
}

async function askOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", ...msg });
}

function setBadge(text, color = "#d93025") {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
}

// --- download paths ---
function viaDownloads(payload, cfg) {
  const parts = [cfg.subfolder, cfg.perConversation ? sanitize(payload.convo) : null]
    .filter(Boolean)
    .map((p) => p.split("/").map(sanitize).filter(Boolean).join("/"))
    .filter(Boolean);
  const filename = [...parts, baseName(payload)].join("/");
  return new Promise((resolve) => {
    // saveAs:false explicitly suppresses Chrome's "Ask where to save each file".
    chrome.downloads.download({ url: payload.url, filename, saveAs: false, conflictAction: "uniquify" }, (id) =>
      resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : { ok: true, id, where: filename })
    );
  });
}

async function handleDownload(payload) {
  const cfg = await getCfg();

  if (cfg.mode === "folder") {
    const r = await askOffscreen({
      type: "write-file",
      url: payload.url,
      filename: baseName(payload),
      subpath: cfg.perConversation ? sanitize(payload.convo) : ""
    });
    if (r?.ok) {
      setBadge("");
      return { ok: true, where: `${cfg.folderName}/${r.name}` };
    }
    // Folder unusable (Chrome drops the grant on restart) — don't lose the image.
    setBadge("!");
    const fb = await viaDownloads(payload, cfg);
    return { ...fb, warning: r?.reason === "no-permission" ? "folder-needs-reconnect" : r?.reason };
  }

  setBadge("");
  return viaDownloads(payload, cfg);
}

let tickerTab = null;

// ---- generated-image capture -------------------------------------------
// The DOM is unreliable across ChatGPT builds, but the image always arrives
// over the network. Watching requests is build-independent.
//
// An MV3 service worker is evicted after ~30s idle and plain module state dies
// with it. Generation takes longer than that, so an in-memory-only Map went
// empty mid-wait and capture silently stopped recording for the rest of the
// prompt. chrome.storage.session survives eviction, so the armed tabs and the
// URLs seen so far are rehydrated when the worker comes back.
const captures = new Map(); // tabId -> string[]

const persist = () =>
  chrome.storage.session.set({ captures: Object.fromEntries(captures) }).catch(() => {});

const hydrated = (async () => {
  try {
    const { captures: saved } = await chrome.storage.session.get("captures");
    for (const [id, urls] of Object.entries(saved || {})) {
      if (!captures.has(+id)) captures.set(+id, urls);
    }
  } catch {}
})();
hydrated.then(() => {});

chrome.webRequest.onCompleted.addListener(
  (d) => {
    const list = captures.get(d.tabId);
    if (!list) return;
    if (d.statusCode >= 400) return;
    // Images only: either the resource type says so, or the URL looks like one.
    // fetch()/XHR-loaded results have neither, so accept OpenAI's asset host on
    // any type - that host serves nothing but user/model files.
    const asset = /oaiusercontent\.com/i.test(d.url);
    if (!asset && d.type !== "image" && !/\.(png|jpe?g|webp)(\?|$)/i.test(d.url)) return;
    if (list.includes(d.url)) return;
    list.push(d.url);
    if (list.length > 400) list.splice(0, list.length - 400);
    persist();
  },
  { urls: ["https://*.oaiusercontent.com/*", "https://*.openai.com/*", "https://*.chatgpt.com/*"] }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return; // not ours

  // Heartbeat relay: offscreen document → this worker → the running tab.
  if (msg?.type === "tick-source") {
    if (tickerTab != null) {
      chrome.tabs.sendMessage(tickerTab, { type: "tick" }).catch(() => {
        tickerTab = null; // tab closed or navigated
        askOffscreen({ type: "ticker", on: false });
      });
    }
    return;
  }
  if (msg?.type === "capture") {
    const id = sender.tab?.id;
    if (id != null) {
      if (msg.on) captures.set(id, []);
      else captures.delete(id);
      persist();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "captured") {
    // `armed` lets the runner tell "nothing arrived yet" apart from "capture
    // was lost", which used to look identical: both returned an empty list.
    (async () => {
      await hydrated;
      const list = sender.tab?.id != null ? captures.get(sender.tab.id) : null;
      sendResponse({ urls: list || [], armed: !!list });
    })();
    return true;
  }
  if (msg?.type === "ticker") {
    tickerTab = msg.on ? sender.tab?.id ?? null : null;
    askOffscreen({ type: "ticker", on: !!msg.on }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "download-image") {
    handleDownload(msg).then(sendResponse);
    return true;
  }
  if (msg?.type === "open-picker") {
    chrome.tabs.create({ url: chrome.runtime.getURL("picker.html") });
    return;
  }
  if (msg?.type === "zip-images") {
    (async () => {
      const cfg = await getCfg();
      const stamp = new Date().toISOString().slice(0, 10);
      const zipName = `${sanitize(msg.name || "chatgpt-images")}-${stamp}.zip`;

      const r = await askOffscreen({
        type: "make-zip",
        items: msg.items,
        folder: cfg.mode === "folder" ? zipName : null
      });
      if (!r?.ok) return sendResponse(r || { ok: false, reason: "zip failed" });
      if (r.written) return sendResponse({ ok: true, count: r.count, where: `${cfg.folderName}/${r.written}` });

      const filename = [cfg.subfolder, zipName].filter(Boolean).join("/");
      chrome.downloads.download({ url: r.url, filename, saveAs: false, conflictAction: "uniquify" }, () =>
        sendResponse(
          chrome.runtime.lastError
            ? { ok: false, reason: chrome.runtime.lastError.message }
            : { ok: true, count: r.count, where: filename }
        )
      );
    })();
    return true;
  }
  if (msg?.type === "folder-status") {
    (async () => {
      const cfg = await getCfg();
      if (cfg.mode !== "folder") return sendResponse({ mode: "downloads", cfg });
      const r = await askOffscreen({ type: "check-folder" });
      sendResponse({ mode: "folder", ok: !!r?.ok, reason: r?.reason, cfg });
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cgpt-save-image",
    title: "Save ChatGPT image",
    contexts: ["image"],
    documentUrlPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
});

// No popup: the toolbar click opens the image queue panel directly.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) return;
    await chrome.tabs.sendMessage(tab.id, { type: "show-panel" });
  } catch {}
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "cgpt-save-image" || !info.srcUrl) return;
  const convo = (tab?.url || "").split("/c/")[1]?.slice(0, 8) || "chat";
  handleDownload({ url: info.srcUrl, convo, index: 1 });
});
