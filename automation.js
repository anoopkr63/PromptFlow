// Batch runner: one row per prompt. Each row can carry a reference image.
// Sends them one at a time, waits for each image, saves it as <name>-<n>.
(() => {
  const TIMEOUT_MS = 300000; // per image
  const GAP_MS = 4000;       // breather between prompts
  const RETRY_GAP_MS = 8000; // longer pause before re-sending a failed prompt
  const MAX_ATTEMPTS = 3;    // a prompt is re-sent automatically before failing
  const POLL_MS = 1000;
  const SETTLE_POLLS = 2;    // stable polls before an image counts as finished
  const MIN_GEN_PX = 400;
  const PROBE_MS = 4000;     // per-URL probe budget; they run in parallel
  const PROBE_MAX = 16;      // newest N captured URLs are probed, not all of them

  const dl = () => window.__cgptDL;

  // --- clock -------------------------------------------------------------
  // setTimeout is clamped to ~1/minute once the tab has been hidden a while,
  // which stalls a run. The extension's offscreen document ticks every second
  // regardless, so a sleep finishes on whichever arrives first.
  let waiters = [];
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "tick") return;
    for (const fn of waiters.slice()) fn();
  });

  function sleep(ms) {
    return new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const check = () => {
        if (Date.now() < deadline) return;
        clearInterval(id);
        waiters = waiters.filter((f) => f !== check);
        resolve();
      };
      const id = setInterval(check, Math.min(200, Math.max(25, ms)));
      waiters.push(check);
    });
  }

  async function ticker(on) {
    try {
      if (dl().extAlive()) await chrome.runtime.sendMessage({ type: "ticker", on });
    } catch {}
  }

  let running = false;
  let abort = false;

  // --- trace -------------------------------------------------------------
  // Every boundary the run crosses is recorded with a timestamp, so a stall can
  // be read off one dump instead of guessed at from the visible symptom.
  const trace = [];
  let t0 = Date.now();
  function tr(stage, data = {}) {
    trace.push({ t: +((Date.now() - t0) / 1000).toFixed(1), stage, ...data });
    if (trace.length > 5000) trace.splice(0, 2500);
  }

  // ---------- ChatGPT DOM plumbing ----------
  const STOP = ['[data-testid="stop-button"]', 'button[aria-label*="Stop generating" i]',
                'button[aria-label*="Stop streaming" i]', 'button[aria-label*="Stop answering" i]'];

  const pick = (sels) => sels.map((s) => document.querySelector(s)).find(Boolean) || null;
  // React keeps stop buttons mounted but hidden after a reply finishes, so a
  // plain querySelector reports "still generating" forever. Require visibility.
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  function generatingEl() {
    for (const sel of STOP) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
    }
    // The send button becomes a stop button while streaming; labels vary.
    const form = composer()?.closest("form") || composer()?.parentElement;
    for (const b of form?.querySelectorAll("button") || []) {
      if (/^stop\b/i.test(b.getAttribute("aria-label") || "") && visible(b)) return b;
    }
    return null;
  }

  const isGenerating = () => !!generatingEl();

  // ChatGPT renames this button often, so search rather than trust one selector.
  function findSend() {
    const direct = pick([
      '[data-testid="send-button"]',
      "#composer-submit-button",
      '[data-testid="composer-send-button"]',
      'button[aria-label*="Send" i]'
    ]);
    if (direct) return direct;
    const form = composer()?.closest("form");
    return form ? form.querySelector('button[type="submit"]') : null;
  }

  // textContent, never innerText: the empty ProseMirror editor renders an
  // "Ask anything" placeholder that innerText picks up, which made an
  // already-sent prompt look like it was still sitting in the box.
  const composerText = () => {
    const b = composer();
    if (!b) return "";
    return (b.tagName === "TEXTAREA" ? b.value : b.textContent || "").trim();
  };

  const userMsgCount = () => document.querySelectorAll('[data-message-author-role="user"]').length;

  const composer = () =>
    document.querySelector("#prompt-textarea") ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector("textarea");

  // ChatGPT refuses a byte-identical re-upload ("You've already uploaded this
  // file"), so each prompt gets a fresh copy: a few random bytes appended past
  // the image's end marker, which decoders ignore.
  async function freshCopy(file, n) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const salt = new Uint8Array(12);
    crypto.getRandomValues(salt);
    const dot = file.name.lastIndexOf(".");
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? file.name.slice(dot) : ".png";
    return new File([buf, salt], `${base}-${n}${ext}`, { type: file.type || "image/png" });
  }

  async function attachImage(file) {
    const box = composer();
    if (!box) throw new Error("composer not found");

    // Preferred: hand the file to ChatGPT's own file input.
    const input = document.querySelector('input[type="file"]');
    if (input) {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Fallback: paste it into the composer.
      const dt = new DataTransfer();
      dt.items.add(file);
      box.focus();
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }

    // Wait for the upload thumbnail so we don't send before it lands.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await sleep(500);
      // "You've already uploaded this file" means it's in the conversation
      // already — dismiss and carry on rather than failing the row.
      if (dismissDialog()) { await sleep(500); return; }
      const form = box.closest("form") || document.body;
      if (form.querySelector('img[alt*="upload" i], [data-testid*="attachment"], button[aria-label*="Remove" i]')) {
        await sleep(800);
        return;
      }
    }
    throw new Error("reference image never finished uploading");
  }

  async function typePrompt(text) {
    const box = composer();
    if (!box) throw new Error("composer not found");
    box.focus();

    if (box.tagName === "TEXTAREA") {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);
      if (composerText()) return;
    } else {
      // 1) execCommand — what a real keystroke looks like to ProseMirror.
      // It silently does nothing in an unfocused tab, so skip it there.
      if (document.hasFocus()) {
        document.execCommand("selectAll", false, null);
        document.execCommand("delete", false, null);
        document.execCommand("insertText", false, text);
        await sleep(300);
        if (composerText()) return tr("typed", { via: "execCommand" });
      }

      // 2) paste event.
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(400);
      if (composerText()) return tr("typed", { via: "paste" });

      // 3) write the ProseMirror paragraphs directly.
      box.innerHTML = text
        .split("\n")
        .map((line) => {
          const p = document.createElement("p");
          p.textContent = line || " ";
          return p.outerHTML;
        })
        .join("");
      box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      await sleep(400);
      if (composerText()) return tr("typed", { via: "prosemirror" });
    }
    tr("type-failed");
    throw new Error("could not put the prompt in the composer (ChatGPT's editor changed)");
  }

  async function submit() {
    const beforeTurns = turnNodes().length;
    const beforeMsgs = userMsgCount();
    // Sent = a new turn appeared, or streaming began, or the box emptied.
    // Turn count is the reliable one; the others cover markup differences.
    const sent = () =>
      turnNodes().length > beforeTurns || userMsgCount() > beforeMsgs || isGenerating() || !composerText();

    // The send button stays disabled while an attached photo is still
    // finalising server-side — that can take a while, so wait up to ~30s
    // for a sendable state before falling back to Enter.
    for (let i = 0; i < 120; i++) {
      const btn = findSend();
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true" && !isGenerating()) {
        btn.click();
        for (let w = 0; w < 20; w++) {
          await sleep(400);
          if (sent()) return tr("sent", { via: "button", turnsBefore: beforeTurns, turnsAfter: turnNodes().length });
        }
        break;
      }
      await sleep(250);
    }

    // Fallback: Enter, the way a person sends it.
    const box = composer();
    box?.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      box?.dispatchEvent(
        new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
    for (let w = 0; w < 12; w++) {
      await sleep(400);
      if (sent()) return tr("sent", { via: "enter", turnsBefore: beforeTurns, turnsAfter: turnNodes().length });
    }

    tr("send-failed", { turns: turnNodes().length, composer: (composerText() || "").slice(0, 40) });
    throw new Error("prompt went in but ChatGPT would not send it");
  }

  // ChatGPT blocks the composer with "You've already uploaded this file."
  // when the same reference is sent twice. Clear it.
  function dismissDialog() {
    for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (!/already uploaded|try uploading something new/i.test(d.textContent || "")) continue;
      const btns = [...d.querySelectorAll("button")];
      (btns.find((b) => /^(ok|got it|close|dismiss)$/i.test(b.textContent.trim())) || btns[0])?.click();
      return true;
    }
    return false;
  }

  // Nothing may be sent until the previous answer is completely finished.
  async function waitForIdle(timeoutMs = 120000, onStuck) {
    const deadline = Date.now() + timeoutMs;
    let reported = false;
    while (Date.now() < deadline) {
      if (abort) throw new Error("stopped");
      dismissDialog();
      const busy = generatingEl();
      if (!busy) {
        await sleep(1500);            // double-check: streaming can pause briefly
        if (!isGenerating()) return true;
        tr("idle-false-alarm");
      } else if (!reported && Date.now() > deadline - timeoutMs + 25000) {
        reported = true;
        // Say what it thinks is still running — otherwise "waiting" is a dead end.
        onStuck?.(busy.getAttribute("aria-label") || busy.getAttribute("data-testid") || busy.tagName);
      }
      await sleep(POLL_MS);
    }
    tr("idle-timeout", { ms: timeoutMs });
    return false; // caller decides whether to push on
  }

  const bigImages = () => dl().collect().filter(eligible);

  // ChatGPT's markup varies by build — this one has no data-message-author-role
  // at all. Try each known shape and use the first that actually matches.
  const TURN_SELECTORS = [
    "[data-message-author-role]",
    'article[data-testid^="conversation-turn"]',
    "[data-message-id]",
    "article"
  ];
  function turnNodes() {
    for (const sel of TURN_SELECTORS) {
      const found = document.querySelectorAll(sel);
      if (found.length) return [...found];
    }
    return [];
  }

  // Lazy-loaded images report naturalWidth 0 until they render, so fall back to
  // laid-out size rather than dismissing them as too small.
  const imgSize = (img) => dl().sizeOf(img);

  // Accept an unmeasurable (lazy) image from ChatGPT's asset host too —
  // isContentImage has already ruled out uploads, avatars and panel chrome.
  const eligible = (img) => dl().isContentImage(img) && (imgSize(img) >= MIN_GEN_PX || imgSize(img) === 0);

  // Anchored on the reply, not on "a URL I haven't seen". Waiting for an unseen
  // URL fails whenever the answer arrives in a chat that already held images.
  // Any element that carries an image, including CSS backgrounds — some
  // ChatGPT builds render the generated result that way.
  function imagesIn(root) {
    const out = [...root.querySelectorAll("img")].filter(eligible);
    if (out.length) return out;
    for (const el of root.querySelectorAll("*")) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
      if (m && el.getBoundingClientRect().width >= MIN_GEN_PX) {
        const fake = new Image();
        fake.src = m[1];
        out.push(fake);
      }
    }
    return out;
  }

  // --- network capture ----------------------------------------------------
  const capture = async (on) => {
    try { if (dl().extAlive()) await chrome.runtime.sendMessage({ type: "capture", on }); } catch {}
  };
  // Re-arms itself if the background worker was evicted and lost the list —
  // otherwise capture died silently and every later poll saw an empty array.
  const capturedUrls = async () => {
    try {
      if (!dl().extAlive()) return [];
      const r = await chrome.runtime.sendMessage({ type: "captured" });
      if (r && r.armed === false) {
        tr("capture-lost");
        await capture(true);
        return [];
      }
      return r?.urls || [];
    } catch (e) {
      tr("capture-error", { err: String(e.message || e) });
      return [];
    }
  };

  // A captured URL is only the generated image if it actually loads at size.
  function probe(url) {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok ? { url, w: img.naturalWidth, h: img.naturalHeight } : null);
      };
      img.onload = () => done(Math.min(img.naturalWidth, img.naturalHeight) >= 256);
      img.onerror = () => done(false);
      img.src = url;
      sleep(PROBE_MS).then(() => done(false)); // ticked clock: survives a hidden tab
    });
  }

  // Probing serially at 15s each meant one poll could burn longer than the whole
  // run budget once a chat had accumulated image requests. Probe the newest
  // handful together and take the newest that comes back good.
  async function firstGood(urls) {
    const tail = urls.slice(-PROBE_MAX);
    const hits = await Promise.all(tail.map(probe));
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i]) return hits[i];
    return null;
  }

  async function waitForImage({ turnsBefore, before, seen, prompt }, onTick, note) {
    const deadline = Date.now() + TIMEOUT_MS;
    const key = dl().imageKey;
    // Your uploaded photo re-fetches as your message renders — a real,
    // full-size image URL. When streaming pauses mid-generation (!busy after
    // sawGen), that refetch was mistaken for the finished result, so every
    // frame-N ended up a copy of your upload. Its file id is known the moment
    // your turn renders, so exclude anything from your own turns/composer.
    const own = new Set();
    const refreshOwn = () => {
      for (const img of document.querySelectorAll("img")) {
        if (!dl().isGenerated(img)) own.add(key(img.currentSrc || img.src));
      }
    };
    const isNew = (u) => u && !seen.has(key(u)) && !before.has(key(u)) && !own.has(key(u));
    let lastSrc = null, stable = 0, sawGenerating = false, told = false, polls = 0, dry = 0;
    let lastCap = -1;
    refreshOwn();

    while (Date.now() < deadline) {
      if (abort) throw new Error("stopped");
      await sleep(POLL_MS);
      polls++;

      const busy = isGenerating();
      if (busy) sawGenerating = true;
      refreshOwn(); // your upload's file id lands here once your turn renders

      const nodes = turnNodes();
      const tail = nodes[nodes.length - 1];
      if (tail) { try { tail.scrollIntoView({ block: "end" }); } catch {} }

      // 1) Network capture — build-independent, and the only signal that can't
      //    be broken by a ChatGPT markup change. Only trusted once generation
      //    has actually started and stopped, so the reference image being
      //    re-fetched as your message renders is never mistaken for the result.
      if (!busy && sawGenerating) {
        const all = await capturedUrls();
        const urls = all.filter(isNew);
        if (all.length !== lastCap) {
          lastCap = all.length;
          tr("capture-scan", { captured: all.length, fresh: urls.length });
        }
        const hit = await firstGood(urls);
        if (hit) {
          tr("hit", { via: "network", url: hit.url, px: `${hit.w}x${hit.h}` });
          return { src: hit.url };
        }
      }

      // 2) DOM, newest turn first.
      let candidate = null;
      const newTurns = nodes.slice(turnsBefore);
      for (let i = newTurns.length - 1; i >= 0 && !candidate; i--) {
        candidate = imagesIn(newTurns[i]).find((img) => isNew(img.src)) || null;
      }
      // 3) Anything on the page that wasn't there when the prompt went out.
      if (!candidate) candidate = bigImages().find((img) => isNew(img.src)) || null;

      const src = candidate?.src || null;
      stable = src && src === lastSrc && !busy ? stable + 1 : 0;
      if (src !== lastSrc || polls % 15 === 0) {
        tr("poll", { n: polls, busy, sawGen: sawGenerating, turns: nodes.length,
                     newTurns: newTurns.length, cand: src ? key(src) : null, dry });
      }
      lastSrc = src;

      if (newTurns.length >= 2 && !busy && !candidate) {
        if (++dry > 20) throw new Error("reply arrived without an image — check the chat");
      } else {
        dry = 0;
      }

      onTick(
        busy ? "generating…" : candidate ? "finishing…" : sawGenerating ? "waiting for the image…" : "waiting for ChatGPT to start…"
      );

      if (!told && polls === 20 && !candidate) {
        told = true;
        const shot = dl().debugImages();
        const urls = await capturedUrls();
        note(`… no image yet — turns:${nodes.length} imgs:${shot.length} accepted:${shot.filter((i) => i.accepted).length} captured:${urls.length}`);
        console.log("[ChatGPT Image Downloader] nothing matched yet.");
        console.table(shot);
        console.log("captured image requests:", urls);
      }

      if (stable >= SETTLE_POLLS && candidate) {
        tr("hit", { via: "dom", url: candidate.src });
        return candidate;
      }
    }
    tr("timeout", { polls, sawGen: sawGenerating });
    throw new Error("timed out waiting for the image");
  }

  // ---------- panel ----------
  const panel = document.createElement("div");
  panel.id = "cgpt-batch";
  panel.innerHTML = `
    <div class="cgpt-b-head">
      <span>Image queue</span>
      <em class="cgpt-b-ver"></em>
      <button class="cgpt-b-toggle" type="button" title="Collapse">–</button>
      <i class="cgpt-b-progress"></i>
    </div>
    <div class="cgpt-b-body">
      <div class="cgpt-b-dest">
        <span class="cgpt-b-folder">…</span>
        <button class="cgpt-b-change" type="button">change</button>
      </div>
      <label class="cgpt-b-name">File name
        <input class="cgpt-b-base" type="text" value="frame" spellcheck="false">
      </label>
      <div class="cgpt-b-hint"></div>
      <div class="cgpt-b-ref">
        <label class="cgpt-ref-slot" title="Reference image used by every prompt">
          <input type="file" accept="image/*" hidden>
          <svg class="cgpt-ref-clip" viewBox="0 0 24 24" width="15" height="15" fill="none"
               stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L11 18.5a2 2 0 0 1-3-3l7.5-7.5"/>
          </svg>
          <img class="cgpt-ref-thumb" alt="" hidden>
        </label>
        <span class="cgpt-ref-text">Reference for all prompts</span>
        <button class="cgpt-ref-clear" type="button" title="Remove" hidden>×</button>
      </div>
      <div class="cgpt-b-rows"></div>
      <div class="cgpt-b-tools">
        <button class="cgpt-b-add" type="button">+ Add prompt</button>
        <label class="cgpt-b-import" title="Load prompts from an image-prompts.md file">
          <input type="file" accept=".md,.markdown,.txt" hidden>
          Import .md
        </label>
      </div>
      <div class="cgpt-b-actions">
        <button class="cgpt-b-start-btn" type="button">Start</button>
        <button class="cgpt-b-stop" type="button" disabled>Stop</button>
        <button class="cgpt-b-redo" type="button" title="Clear results and run every prompt again" hidden>↺</button>
        <button class="cgpt-b-new" type="button" title="Clear all prompts and the last run's results">Reset</button>
      </div>
      <button class="cgpt-b-zip" type="button" hidden>Download ZIP</button>
      <div class="cgpt-b-status"></div>
      <div class="cgpt-b-log"></div>
      <button class="cgpt-b-diag" type="button"
              title="Copy a timestamped trace of the last run">Copy diagnostics</button>
    </div>`;
  document.body.appendChild(panel);

  const q = (c) => panel.querySelector(c);
  const rowsEl = q(".cgpt-b-rows");
  const baseEl = q(".cgpt-b-base");
  const hintEl = q(".cgpt-b-hint");
  const statusEl = q(".cgpt-b-status");
  const logEl = q(".cgpt-b-log");
  const startBtn = q(".cgpt-b-start-btn");
  const stopBtn = q(".cgpt-b-stop");

  // Shows which build is actually live — a stale content script is otherwise
  // indistinguishable from a bug.
  try {
    q(".cgpt-b-ver").textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {}

  const setStatus = (t) => (statusEl.textContent = t);

  const log = (t) => {
    const d = document.createElement("div");
    d.textContent = t;
    if (t.startsWith("✓")) d.className = "ok";
    else if (t.startsWith("✗")) d.className = "fail";
    else if (t.startsWith("↻")) d.className = "retry";
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const progressEl = q(".cgpt-b-progress");
  const setProgress = (done, total) => {
    progressEl.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  };

  const rows = () => [...rowsEl.querySelectorAll(".cgpt-row")];

  // Whether saved files keep their file extension (frame-1.png) or not (frame-1).
  let includeExt = true;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.includeExt) {
        includeExt = changes.includeExt.newValue !== false;
        renumber();
      }
    });
  } catch {}

  function renumber() {
    rows().forEach((r, i) => {
      r.querySelector(".cgpt-row-n").textContent = i + 1;
      r.querySelector(".cgpt-row-p").placeholder = `Prompt ${i + 1}`;
    });
    const n = rows().length;
    const base = baseEl.value.trim() || "image";
    hintEl.textContent = n
      ? (includeExt ? `saves as ${base}-1.png … ${base}-${n}.png` : `saves as ${base}-1 … ${base}-${n} (no extension)`)
      : "";
    refreshControls();
    save();
  }

  function save() {
    try {
      if (!dl().extAlive()) return;
      chrome.storage.local.set({
        batchRows: rows().map((r) => r.querySelector(".cgpt-row-p").value),
        batchBase: baseEl.value
      });
    } catch {}
  }

  function addRow(text = "", focus = false) {
    const row = document.createElement("div");
    row.className = "cgpt-row";
    row.innerHTML = `
      <span class="cgpt-row-n"></span>
      <textarea class="cgpt-row-p" rows="1" spellcheck="false"></textarea>
      <label class="cgpt-row-img" title="Attach a reference image">
        <input type="file" accept="image/*" hidden>
        <svg class="cgpt-row-clip" viewBox="0 0 24 24" width="15" height="15" fill="none"
             stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L11 18.5a2 2 0 0 1-3-3l7.5-7.5"/>
        </svg>
        <img class="cgpt-row-thumb" alt="" hidden>
      </label>
      <button class="cgpt-row-clear" type="button" title="Remove image" hidden>×</button>
      <button class="cgpt-row-x" type="button" title="Remove row">×</button>`;

    const ta = row.querySelector(".cgpt-row-p");
    ta.value = text;
    const grow = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 130) + "px";
    };
    ta.addEventListener("input", () => { grow(); save(); refreshControls(); });

    const file = row.querySelector('input[type="file"]');
    const thumb = row.querySelector(".cgpt-row-thumb");
    const clip = row.querySelector(".cgpt-row-clip");
    const clear = row.querySelector(".cgpt-row-clear");

    function setFile(f) {
      if (row._thumbUrl) URL.revokeObjectURL(row._thumbUrl);
      row._file = f || null;
      row._thumbUrl = f ? URL.createObjectURL(f) : null;
      thumb.src = row._thumbUrl || "";
      thumb.hidden = !f;
      clip.style.display = f ? "none" : "";
      clear.hidden = !f;
      row.classList.toggle("has-img", !!f);
      row.querySelector(".cgpt-row-img").title = f ? `${f.name} — click to replace` : "Attach a reference image";
    }
    file.addEventListener("change", () => setFile(file.files?.[0] || null));
    clear.addEventListener("click", () => { file.value = ""; setFile(null); });

    // Dropping an image on the row attaches it too.
    row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop"); });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (e) => {
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
      row.classList.remove("drop");
      if (!f) return;
      e.preventDefault();
      const dt = new DataTransfer();
      dt.items.add(f);
      file.files = dt.files;
      file.dispatchEvent(new Event("change"));
    });

    row.querySelector(".cgpt-row-x").addEventListener("click", () => {
      row.remove();
      if (!rows().length) addRow("");
      renumber();
    });

    rowsEl.appendChild(row);
    requestAnimationFrame(grow);
    if (focus) ta.focus();
    return row;
  }

  // Reference image shared by every row. A row's own image overrides it.
  let globalRef = null;
  const refInput = panel.querySelector(".cgpt-b-ref input");
  const refThumb = panel.querySelector(".cgpt-ref-thumb");
  const refClip = panel.querySelector(".cgpt-ref-clip");
  const refClear = panel.querySelector(".cgpt-ref-clear");
  const refText = panel.querySelector(".cgpt-ref-text");
  const refBox = panel.querySelector(".cgpt-b-ref");
  let refUrl = null;

  function setGlobalRef(file, persist = true) {
    if (refUrl) URL.revokeObjectURL(refUrl);
    globalRef = file || null;
    refUrl = file ? URL.createObjectURL(file) : null;
    refThumb.src = refUrl || "";
    refThumb.hidden = !file;
    refClip.style.display = file ? "none" : "";
    refClear.hidden = !file;
    refText.textContent = file ? file.name : "Reference for all prompts";
    refBox.classList.toggle("has-img", !!file);
    if (persist) saveRef(file);
  }

  function saveRef(file) {
    try {
      if (!dl().extAlive()) return;
      if (!file) return chrome.storage.local.remove(["refImage", "refName"]);
      if (file.size > 4 * 1024 * 1024) return; // too big to keep in storage
      const fr = new FileReader();
      fr.onload = () => chrome.storage.local.set({ refImage: fr.result, refName: file.name });
      fr.readAsDataURL(file);
    } catch {}
  }

  async function restoreRef() {
    try {
      if (!dl().extAlive()) return;
      const { refImage, refName } = await chrome.storage.local.get({ refImage: "", refName: "" });
      if (!refImage) return;
      const blob = await (await fetch(refImage)).blob();
      setGlobalRef(new File([blob], refName || "reference.png", { type: blob.type }), false);
    } catch {}
  }

  refInput.addEventListener("change", () => setGlobalRef(refInput.files?.[0] || null));
  refClear.addEventListener("click", () => { refInput.value = ""; setGlobalRef(null); });
  refBox.addEventListener("dragover", (e) => { e.preventDefault(); refBox.classList.add("drop"); });
  refBox.addEventListener("dragleave", () => refBox.classList.remove("drop"));
  refBox.addEventListener("drop", (e) => {
    e.preventDefault();
    refBox.classList.remove("drop");
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("image/"));
    if (f) setGlobalRef(f);
  });

  async function showDest() {
    try {
      if (!dl().extAlive()) return;
      const cfg = await chrome.storage.local.get({ mode: "downloads", subfolder: "ChatGPT", folderName: "" });
      q(".cgpt-b-folder").textContent =
        cfg.mode === "folder" && cfg.folderName ? `📁 ${cfg.folderName}` : `📁 Downloads/${cfg.subfolder}`;
    } catch {}
  }

  q(".cgpt-b-add").addEventListener("click", () => { addRow("", true); renumber(); });
  baseEl.addEventListener("input", renumber);
  q(".cgpt-b-toggle").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    q(".cgpt-b-toggle").textContent = panel.classList.contains("collapsed") ? "+" : "–";
  });
  q(".cgpt-b-change").addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "open-picker" }); } catch {}
  });

  // Drag by the header — the panel often sits over the composer.
  (() => {
    const head = panel.querySelector(".cgpt-b-head");
    let sx, sy, ox, oy, dragging = false;

    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.top}px`;
      head.setPointerCapture(e.pointerId);
    });

    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const w = panel.offsetWidth, h = panel.offsetHeight;
      const x = Math.min(Math.max(0, ox + e.clientX - sx), innerWidth - w);
      const y = Math.min(Math.max(0, oy + e.clientY - sy), innerHeight - h);
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    });

    head.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;
      try {
        if (dl().extAlive()) chrome.storage.local.set({ panelPos: { left: panel.style.left, top: panel.style.top } });
      } catch {}
    });
  })();

  // ---------- markdown import ----------
  // Reads blocks like:  **frame-3** — *"caption"*  \n  <prompt paragraph>
  // The prompt may sit on the header line itself:
  //   **frame-1:** Monkey ...            **frame-1 HOOK (3.9s):** Monkey ...
  // or the header may just carry a caption, with the prompt on the next line:
  //   **frame-1** — *"caption"*
  function inlinePrompt(rest) {
    let t = (rest || "").trim();
    if (!t) return "";
    if (/^[—–-]/.test(t)) return ""; // caption dash → prompt is on the following line

    const colon = t.indexOf(":");
    if (colon > -1 && colon < 40) {
      const label = t.slice(0, colon);
      // Only drop it if it reads like a label ("", "HOOK (3.98s)"), not prose.
      if (/^[\s*_()\d.a-z]*$/i.test(label) && !/[,;]/.test(label) && label.split(/\s+/).length <= 4) {
        t = t.slice(colon + 1);
      }
    }
    t = t.replace(/^[\s*_]+/, "").trim();
    return t.length > 30 ? t : ""; // too short to be a prompt — it's a caption
  }

  function parsePrompts(text) {
    // A marker line is bolded/headed (**frame-1**, ## frame-1) or hyphenated
    // (frame-1). Bare prose like "Frame 5 is the only standing shot." is not.
    const head = /^([\s>#*_-]*)\**\s*(frame|image|shot|scene|prompt)([-_ ]?)(\d+)\b\**\s*(.*)$/i;
    const blocks = [];
    let cur = null;
    let kind = "frame";

    for (const line of text.split(/\r?\n/)) {
      const m = line.match(head);
      const isMarker = m && (/[*#]/.test(m[1]) || m[3] === "-" || m[3] === "_");
      if (isMarker) {
        kind = m[2].toLowerCase();
        cur = { n: parseInt(m[4], 10), lines: [] };
        blocks.push(cur);
        const inline = inlinePrompt(m[5]);
        if (inline) cur.lines.push(inline);
        continue;
      }
      if (!cur) continue;
      // A rule, a heading, or a blank line after content ends the block —
      // captions and tables above the prompts never get swept in.
      if (/^\s*(-{3,}|\*{3,}|#{1,6}\s)/.test(line)) { cur = null; continue; }
      if (!line.trim()) { if (cur.lines.length) cur = null; continue; }
      cur.lines.push(line.trim());
    }

    return {
      kind,
      items: blocks
        .filter((b) => b.lines.length)
        .sort((a, b) => a.n - b.n)
        .map((b) => b.lines.join("\n"))
    };
  }

  async function importFile(file) {
    const text = await file.text();
    const { kind, items } = parsePrompts(text);
    if (!items.length) {
      setStatus(`No prompts found in ${file.name} — expected lines like **frame-1**`);
      return;
    }
    rowsEl.textContent = "";
    items.forEach((t) => addRow(t));
    baseEl.value = kind === "prompt" ? "image" : kind;
    renumber();
    setStatus(`Loaded ${items.length} prompts from ${file.name}`);
  }

  const importInput = panel.querySelector(".cgpt-b-import input");
  importInput.addEventListener("change", () => {
    const f = importInput.files?.[0];
    importInput.value = "";
    if (f) importFile(f).catch((e) => setStatus(String(e.message || e)));
  });

  // Dropping a .md anywhere on the panel imports it.
  panel.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.items || [])].some((i) => i.kind === "file")) e.preventDefault();
  });
  panel.addEventListener("drop", (e) => {
    const f = [...(e.dataTransfer?.files || [])].find((x) => /\.(md|markdown|txt)$/i.test(x.name));
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    importFile(f).catch((err) => setStatus(String(err.message || err)));
  });

  // ---------- results ----------
  // Each finished row carries its own output, so an interrupted run can resume
  // and the zip still contains everything produced across the attempts.
  const zipBtn = q(".cgpt-b-zip");
  const redoBtn = q(".cgpt-b-redo");

  const outputs = () => rows().map((r) => r._out).filter(Boolean);

  function clearResults() {
    rows().forEach((r) => {
      r._out = null;
      r.classList.remove("done", "failed");
    });
    refreshControls();
    setProgress(0, 0);
  }

  // Primary button reflects what pressing it will actually do.
  function refreshControls() {
    const prompts = rows().filter((r) => r.querySelector(".cgpt-row-p").value.trim());
    const pending = prompts.filter((r) => !r._out);
    const done = outputs().length;

    if (done && pending.length) {
      startBtn.textContent = `Continue (${pending.length})`;
      startBtn.dataset.mode = "resume";
    } else {
      startBtn.textContent = "Start";
      startBtn.dataset.mode = "fresh";
    }
    redoBtn.hidden = !done;
    zipBtn.hidden = !done;
    if (done) zipBtn.textContent = `Download ZIP (${done})`;
  }

  const extOf = (url) => {
    try {
      const m = new URL(url).pathname.match(/\.(png|jpe?g|webp|gif)$/i);
      if (m) return m[1].toLowerCase();
    } catch {}
    return "png";
  };

  async function makeZipNow() {
    const found = outputs();
    if (!found.length) return;
    const label = `Download ZIP (${found.length})`;
    zipBtn.disabled = true;
    zipBtn.textContent = "Zipping…";
    setStatus(`Building zip of ${found.length} images…`);
    // Bytes are read in the page (its cookies unlock estuary URLs) so every
    // entry keeps its frame-N name with real photo bytes behind it.
    const items = [];
    for (const o of found) {
      try { items.push(await dl().portable(o)); }
      catch { items.push(o); }
    }
    try {
      const r = await chrome.runtime.sendMessage({
        type: "zip-images",
        name: baseEl.value.trim() || "chatgpt-images",
        items
      });
      setStatus(r?.ok ? `Zipped ${r.count} images → ${r.where}` : `Zip failed: ${r?.reason || "unknown"}`);
    } catch (e) {
      setStatus(`Zip failed: ${e.message || e}`);
    }
    zipBtn.disabled = false;
    zipBtn.textContent = label;
  }

  zipBtn.addEventListener("click", makeZipNow);

  // Fresh start for the panel itself: empty rows, no leftover results, so a
  // new batch can never inherit the previous one's images.
  panel.querySelector(".cgpt-b-new").addEventListener("click", () => {
    if (running) return setStatus("Stop the run before resetting.");
    rowsEl.textContent = "";
    ["", "", ""].forEach(() => addRow(""));
    renumber();
    clearResults();
    logEl.textContent = "";
    setStatus("Cleared. The reference image and file name are kept.");
    try {
      if (dl().extAlive()) chrome.storage.local.set({ batchRows: [] });
    } catch {}
  });

  // ---------- run ----------
  async function run(mode = "fresh") {
    running = true;
    abort = false;
    const base = baseEl.value.trim() || "image";

    // Numbering follows the row badge, so frame-3 is always row 3 — whether it
    // was produced on the first pass or on a later Continue.
    const entries = rows()
      .map((row, idx) => ({ row, n: idx + 1, text: row.querySelector(".cgpt-row-p").value.trim(), file: row._file }))
      .filter((e) => e.text);

    if (mode === "fresh") {
      clearResults();
      logEl.textContent = "";
    }
    const list = mode === "resume" ? entries.filter((e) => !e.row._out) : entries;

    if (!list.length) { setStatus("Nothing left to run."); return finish(); }

    const shape = TURN_SELECTORS.find((sel) => document.querySelectorAll(sel).length);
    log(`· markup: ${shape || "no turns found"} (${shape ? document.querySelectorAll(shape).length : 0} turns)`);

    if (mode === "fresh") { trace.length = 0; t0 = Date.now(); }
    tr("run-start", {
      mode, rows: entries.length, todo: list.length, base,
      markup: shape || "none", turns: shape ? document.querySelectorAll(shape).length : 0,
      ref: !!globalRef, ua: navigator.userAgent.slice(0, 60),
      ver: (() => { try { return chrome.runtime.getManifest().version; } catch { return "?"; } })()
    });

    panel.classList.add("busy");
    setProgress(outputs().length, entries.length);
    await ticker(true); // keep running while the tab sits in the background

    // Images already collected must never be picked up again.
    const key = dl().imageKey;
    const seen = new Set(outputs().map((o) => key(o.url)));
    let saved = 0;

    for (let i = 0; i < list.length; i++) {
      if (abort) break;
      const { text, file, row, n } = list[i];
      row.classList.remove("failed");

      // One attempt: free → attach → send → wait for the image.
      const attempt = async (label) => {
        if (!dl().extAlive()) { dl().showStale(); throw new Error("extension reloaded — refresh the page"); }

        tr("attempt", { n, label, chars: text.length });
        setStatus(`${label} — waiting for ChatGPT to be free`);
        const idle = await waitForIdle(120000, (what) =>
          log(`… still busy (${what}) — will send anyway if it doesn't clear`)
        );
        if (!idle) log(`… ${base}-${n}: gave up waiting, sending anyway`);

        const before = new Set(bigImages().map((img) => key(img.src)));
        const turnsBefore = turnNodes().length;
        tr("baseline", { idle, before: before.size, turnsBefore, seen: seen.size });
        if (anchorTurns == null) { anchorTurns = turnsBefore; anchorBefore = before; }

        let attach = file || globalRef;
        if (attach) {
          setStatus(`${label} — attaching ${attach.name}`);
          if (attach === globalRef) attach = await freshCopy(globalRef, n);
          await attachImage(attach);
          tr("attached", { name: attach.name, bytes: attach.size });
        }
        setStatus(`${label} — sending prompt`);
        await typePrompt(text);
        await capture(false);      // drop anything captured while attaching
        await submit();
        await capture(true);       // watch for the generated image from here

        return waitForImage(
          { turnsBefore, before, seen, prompt: text },
          (st) => setStatus(`${label} — ${st}`),
          (msg) => log(msg)
        );
      };

      row.classList.add("active");
      // Anchor from the first try: a send that "failed" can still land late
      // (or the user hits Enter by hand) — a new turn since this baseline
      // means the prompt is already in the chat and must NOT be re-sent.
      let anchorTurns = null, anchorBefore = null;
      for (let tryNo = 1; tryNo <= MAX_ATTEMPTS; tryNo++) {
        const label = `${i + 1}/${list.length}${tryNo > 1 ? ` · try ${tryNo}` : ""}`;
        try {
          let img;
          if (tryNo > 1 && anchorTurns != null && turnNodes().length > anchorTurns) {
            tr("already-sent", { n, turnsBefore: anchorTurns, turnsNow: turnNodes().length });
            log(`↻ ${base}-${n}: prompt already went out — waiting for its image`);
            setStatus(`${label} — prompt already sent, waiting for the image`);
            img = await waitForImage(
              { turnsBefore: anchorTurns, before: anchorBefore, seen, prompt: text },
              (st) => setStatus(`${label} — ${st}`),
              (msg) => log(msg)
            );
          } else {
            img = await attempt(label);
          }
          seen.add(key(img.src));
          row._out = { url: img.src, name: includeExt ? `${base}-${n}.${extOf(img.src)}` : `${base}-${n}` };
          row.classList.add("done");
          row.classList.remove("failed");
          tr("saved", { file: `${base}-${n}`, url: key(img.src) });
          log(`✓ ${base}-${n}`);
          saved++;
          break;
        } catch (e) {
          const msg = String(e.message || e);
          tr("attempt-failed", { n, tryNo, msg });
          // Stopping or a reloaded extension are not retryable.
          if (abort || /stopped|extension reloaded/i.test(msg)) {
            row.classList.add("failed");
            log(`✗ ${base}-${n}: ${msg}`);
            break;
          }
          if (tryNo < MAX_ATTEMPTS) {
            log(`↻ ${base}-${n}: ${msg} — retrying (${tryNo + 1}/${MAX_ATTEMPTS})`);
            setStatus(`${label} — retrying after: ${msg}`);
            try { await waitForIdle(120000); } catch {}
            await sleep(RETRY_GAP_MS); // let ChatGPT settle before asking again
          } else {
            row.classList.add("failed");
            log(`✗ ${base}-${n}: ${msg} (gave up after ${MAX_ATTEMPTS} tries)`);
          }
        }
      }
      row.classList.remove("active");

      setProgress(outputs().length, entries.length);
      if (i < list.length - 1 && !abort) {
        // The reply must be completely finished before the next prompt goes in.
        setStatus("waiting for ChatGPT to settle…");
        try { await waitForIdle(120000); } catch {}
        await sleep(GAP_MS);
      }
    }

    const total = outputs().length;
    const left = entries.length - total;
    tr("run-end", { total, of: entries.length, aborted: abort });
    setStatus(
      abort
        ? `Stopped — ${total}/${entries.length} done${left ? ", press Continue" : ""}`
        : left
          ? `${total}/${entries.length} done — ${left} failed, press Continue to retry`
          : `Done — all ${total} images`
    );
    if (total) await makeZipNow(); // zip holds every image produced so far
    finish();
  }

  function finish() {
    running = false;
    ticker(false);
    capture(false);
    panel.classList.remove("busy");
    startBtn.disabled = false;
    stopBtn.disabled = true;
    refreshControls();
  }

  startBtn.addEventListener("click", () => {
    if (running) return;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    run(startBtn.dataset.mode === "resume" ? "resume" : "fresh");
  });

  redoBtn.addEventListener("click", () => {
    if (running) return setStatus("Stop the run first.");
    clearResults();
    logEl.textContent = "";
    setStatus("Results cleared — Start runs every prompt again.");
  });
  stopBtn.addEventListener("click", () => {
    abort = true;
    stopBtn.disabled = true;
    setStatus("Stopping after this step…");
  });

  // One click produces everything needed to see which stage stalled: the trace,
  // what the extension thinks every image on the page is, and the raw list of
  // image requests the background worker saw.
  q(".cgpt-b-diag").addEventListener("click", async () => {
    let shot = [], urls = [];
    try { shot = dl().debugImages(); } catch (e) { shot = [{ error: String(e.message || e) }]; }
    try { urls = await capturedUrls(); } catch {}

    const report = [
      "=== ChatGPT Image Downloader diagnostics ===",
      `version : ${(() => { try { return chrome.runtime.getManifest().version; } catch { return "stale content script"; } })()}`,
      `when    : ${new Date().toISOString()}`,
      `url     : ${location.href}`,
      `ua      : ${navigator.userAgent}`,
      `running : ${running}   rows: ${rows().length}   done: ${outputs().length}`,
      `markup  : ${TURN_SELECTORS.find((sel) => document.querySelectorAll(sel).length) || "no turns found"}`,
      `generating now: ${isGenerating()}`,
      "",
      `--- trace (${trace.length} events) ---`,
      ...trace.map((e) => JSON.stringify(e)),
      "",
      `--- images on page (${shot.length}) ---`,
      ...shot.map((i) => JSON.stringify(i)),
      "",
      `--- captured image requests (${urls.length}) ---`,
      ...urls
    ].join("\n");

    console.log(report);
    try {
      await navigator.clipboard.writeText(report);
      setStatus(`Diagnostics copied (${trace.length} events) — paste them to me.`);
    } catch {
      // Clipboard needs focus; fall back to a selectable box.
      const ta = document.createElement("textarea");
      ta.value = report;
      Object.assign(ta.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      setStatus(ok ? `Diagnostics copied (${trace.length} events).` : "Copy failed — it's in the console instead.");
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // ---------- boot ----------
  (async () => {
    let saved = { batchRows: [], batchBase: "frame", includeExt: true };
    try {
      if (dl().extAlive()) saved = await chrome.storage.local.get({ batchRows: [], batchBase: "frame", includeExt: true });
    } catch {}
    includeExt = saved.includeExt !== false;
    baseEl.value = saved.batchBase || "frame";
    const list = saved.batchRows?.length ? saved.batchRows : ["", "", ""];
    list.forEach((t) => addRow(t));
    renumber();
    showDest();
    restoreRef();
    try {
      const { panelPos } = await chrome.storage.local.get({ panelPos: null });
      if (panelPos?.left) {
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = panelPos.left;
        panel.style.top = panelPos.top;
      }
    } catch {}
  })();
})();
