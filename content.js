(() => {
  const MIN_SIZE = 150; // px — filters out avatars, icons, logos
  const MARK = "cgptDlAttached";
  let dead = false; // set by hideUI(): nothing attaches until showUI() runs

  // Last-resort net: any promise anywhere (including Chrome's own internal
  // callbacks) that rejects because the extension was reloaded gets turned into
  // the banner rather than a red console error the user has to decode.
  window.addEventListener("unhandledrejection", (e) => {
    const msg = String(e.reason?.message || e.reason || "");
    if (/Extension context invalidated|Receiving end does not exist/i.test(msg)) {
      e.preventDefault();
      showStale();
    }
  });

  // Version stamp: proves which build the page is actually executing.
  // If this line is missing or shows an old number, the extension card was
  // never reloaded and stale code is still running.
  try {
    console.log(`%c[ChatGPT Image Downloader] v${chrome.runtime.getManifest().version} ready`, "color:#10a37f");
  } catch {}

  const convoId = () => (location.pathname.match(/\/c\/([\w-]+)/)?.[1] || "chat").slice(0, 8);

  // Exclude what you uploaded. Newer ChatGPT builds drop
  // data-message-author-role entirely, so also exclude anything inside the
  // composer (upload previews live there) and any obvious attachment chrome.
  function isGenerated(img) {
    if (img.closest('[data-message-author-role="user"]')) return false;
    if (img.closest("form")) return false;
    if (img.closest('[data-testid*="attachment" i], [class*="attachment" i]')) return false;
    return true;
  }

  // An image scrolled out of view reports naturalWidth 0, so measure the
  // laid-out box too, and trust ChatGPT's own asset hosts even when neither
  // measurement is available yet.
  const ASSET_HOST = /oaiusercontent|oaistatic|openai\.com/i;

  function sizeOf(img) {
    return Math.max(
      img.naturalWidth || 0,
      img.width || 0,
      img.clientWidth || 0,
      img.getBoundingClientRect().width || 0
    );
  }

  function isContentImage(img) {
    if (!img.src) return false;
    if (img.closest("#cgpt-dl-bar") || img.closest("#cgpt-batch")) return false;
    if (!isGenerated(img)) return false;
    if (/\/(avatar|profile)/i.test(img.src)) return false;
    if (!/^(https?:|blob:|data:)/.test(img.src)) return false;
    if (sizeOf(img) >= MIN_SIZE) return true;
    // Not measurable yet (lazy) — accept if it comes from a content host.
    return sizeOf(img) === 0 && ASSET_HOST.test(img.src);
  }

  // ChatGPT renders one generated image in several <img> nodes (inline,
  // lightbox, viewer), and the same file can appear under different signed
  // URLs. Key on the stable file identity: estuary-style URLs
  // (/backend-api/estuary/content?id=file_…) share ONE pathname for every
  // image, so a pathname-only key collapsed all images into one — new images
  // never looked new and collect() kept a single one.
  function imageKey(src) {
    try {
      const u = new URL(src);
      const id = u.searchParams.get("id");
      if (id) return `${u.pathname}?id=${id}`;
      return u.pathname;
    } catch {
      return src;
    }
  }

  function collect() {
    const seen = new Set();
    return [...document.querySelectorAll("img")].filter((img) => {
      if (!isContentImage(img)) return false;
      const k = imageKey(img.src);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // blob:/data: URLs can't be handed to chrome.downloads from the worker,
  // so read them here and send a data URL instead.
  async function toDataUrl(url) {
    const blob = await (await fetch(url)).blob();
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res({ url: fr.result, mime: blob.type });
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  // After the extension is reloaded/updated, this script keeps running in the
  // page but its port to the extension is dead. Detect that instead of throwing
  // "Extension context invalidated" out of a promise nobody catches.
  function extAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  let staleShown = false;
  function showStale() {
    if (staleShown) return;
    staleShown = true;
    const b = document.createElement("div");
    b.id = "cgpt-dl-stale";
    b.innerHTML = 'Extension was reloaded — <button type="button">refresh this page</button> to re-enable downloads.';
    b.querySelector("button").addEventListener("click", () => location.reload());
    document.body.appendChild(b);
  }

  async function sendToExtension(payload) {
    if (!extAlive()) {
      showStale();
      return { ok: false, error: "extension-reloaded" };
    }
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/context invalidated|receiving end does not exist/i.test(msg)) showStale();
      return { ok: false, error: msg };
    }
  }

  async function save(img, index, name) {
    let payload = { url: img.src, convo: convoId(), index, name };
    if (img.src.startsWith("blob:") || img.src.startsWith("data:")) {
      const d = await toDataUrl(img.src);
      payload = { ...payload, url: d.url, mime: d.mime };
    }
    const res = await sendToExtension({ type: "download-image", ...payload });
    if (!res?.ok) console.warn("[ChatGPT Image Downloader]", res.error);
    return res;
  }

  function attachButton(img, index) {
    if (img.dataset[MARK]) return;
    img.dataset[MARK] = "1";

    const host = img.parentElement;
    if (!host) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";

    const btn = document.createElement("button");
    btn.className = "cgpt-dl-btn";
    btn.type = "button";
    btn.title = "Download image";
    btn.textContent = "↓";
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = "…";
      const r = await save(img, index);
      btn.textContent = r?.ok ? "✓" : "!";
      setTimeout(() => (btn.textContent = "↓"), 1500);
    });
    host.appendChild(btn);
  }

  function refresh() {
    if (dead) return;
    collect().forEach((img, i) => attachButton(img, i + 1));
    const n = collect().length;
    if (bar) {
      bar.hidden = n === 0;
      count.textContent = n;
    }
  }

  // --- floating "download all" bar ---
  let bar, count;
  function buildBar() {
    bar = document.createElement("div");
    bar.id = "cgpt-dl-bar";
    bar.hidden = true;

    const zip = document.createElement("button");
    zip.className = "cgpt-dl-zip";
    zip.type = "button";
    zip.title = "Bundle the generated images on this page into one .zip";
    zip.textContent = "ZIP";
    zip.addEventListener("click", async () => {
      const imgs = collect();
      if (!imgs.length) return;
      const label = zip.textContent;
      zip.disabled = true;
      zip.textContent = "…";
      const base = await batchBase();
      const stamp = new Date().toISOString().slice(0, 10);
      const raw = imgs.map((img, i) => {
        const m = (() => {
          try { return new URL(img.src).pathname.match(/\.(png|jpe?g|webp|gif)$/i); } catch { return null; }
        })();
        return { url: img.src, name: `${base}-${i + 1}.${m ? m[1].toLowerCase() : "png"}` };
      });
      const items = [];
      for (const it of raw) items.push(await portable(it));
      const r = await sendToExtension({ type: "zip-images", name: `${base}-${stamp}`, items });
      zip.textContent = r?.ok ? "✓" : "!";
      if (!r?.ok) console.warn("[ChatGPT Image Downloader] zip:", r?.reason || r?.error);
      setTimeout(() => { zip.textContent = label; zip.disabled = false; }, 2000);
    });

    const all = document.createElement("button");
    all.className = "cgpt-dl-all";
    all.type = "button";
    all.innerHTML = 'Download generated images (<span id="cgpt-dl-count">0</span>)';
    all.addEventListener("click", async () => {
      const imgs = collect();
      const base = await batchBase();
      all.disabled = true;
      let done = 0;
      for (const [i, img] of imgs.entries()) {
        try { await save(img, i + 1, `${base}-${i + 1}`); done++; } catch (e) { console.warn(e); }
        all.innerHTML = `Downloading ${done}/${imgs.length}…`;
        await new Promise((r) => setTimeout(r, 250)); // avoid download throttling
      }
      all.innerHTML = `Saved ${done} image${done === 1 ? "" : "s"} ✓`;
      setTimeout(() => {
        all.innerHTML = 'Download generated images (<span id="cgpt-dl-count">0</span>)';
        count = document.getElementById("cgpt-dl-count");
        all.disabled = false;
        refresh();
      }, 2000);
    });

    bar.appendChild(all);
    bar.appendChild(zip);
    document.body.appendChild(bar);
    count = document.getElementById("cgpt-dl-count");
  }

  buildBar();
  refresh();

  // Shared with automation.js (same isolated world).
  // Full picture of every image on the page and why it was or wasn't taken.
  // Printed to the console when a wait stalls, so a DOM change is diagnosable
  // instead of guessable.
  function debugImages() {
    return [...document.querySelectorAll("img")].map((img) => ({
      src: (img.currentSrc || img.src || "").slice(0, 90),
      size: sizeOf(img),
      natural: img.naturalWidth,
      inUserTurn: !!img.closest('[data-message-author-role="user"]'),
      inForm: !!img.closest("form"),
      inPanel: !!(img.closest("#cgpt-batch") || img.closest("#cgpt-dl-bar")),
      accepted: isContentImage(img)
    }));
  }

  window.__cgptDL = {
    collect, save, isContentImage, isGenerated, imageKey, sizeOf, debugImages,
    convoId, extAlive, showStale, toDataUrl, batchBase, portable, hideUI, showUI
  };

  // The batch panel's file name is the single source of truth for frame
  // numbering, so floating-bar saves come out as frame-1 … frame-N too.
  async function batchBase() {
    try {
      if (!extAlive()) return "frame";
      return (await chrome.storage.local.get({ batchBase: "frame" })).batchBase || "frame";
    } catch {
      return "frame";
    }
  }

  // Estuary/backend URLs need the page's own cookies. Read the bytes here
  // (same-origin, cached) so the zip/offscreen never faces a login wall.
  // Falls back to the original URL if the read fails.
  async function portable(item) {
    try {
      if (/chatgpt\.com\/backend-api|estuary/i.test(item.url)) {
        const d = await toDataUrl(item.url);
        return { name: item.name, url: d.url };
      }
    } catch {}
    return item;
  }

  // ChatGPT streams DOM in; re-scan on mutations (debounced) and on SPA navigation.
  let t;
  const mo = new MutationObserver(() => {
    if (dead) return;
    clearTimeout(t);
    t = setTimeout(refresh, 400);
  });
  mo.observe(document.body, { childList: true, subtree: true });

  // × hides every injected element; the popup's "Open image queue" button
  // brings it all back. A body class hides the bar + buttons (their author
  // display rules override the [hidden] attribute), while disconnecting the
  // observer + the dead flag stop anything new from attaching meanwhile.
  function hideUI() {
    dead = true;
    try { mo.disconnect(); } catch {}
    clearTimeout(t);
    document.body.classList.add("cgpt-dl-off");
    document.getElementById("cgpt-dl-stale")?.remove();
  }
  function showUI() {
    dead = false;
    document.body.classList.remove("cgpt-dl-off");
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch {}
    refresh();
  }
})();
