const $ = (s) => document.querySelector(s);
const modeInputs = [...document.querySelectorAll('input[name=mode]')];
const statusEl = $("#status");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

async function load() {
  const cfg = await chrome.storage.local.get({
    mode: "downloads", subfolder: "ChatGPT", folderName: "", perConversation: false
  });
  modeInputs.forEach((i) => (i.checked = i.value === cfg.mode));
  $("#subfolder").value = cfg.subfolder;
  $("#perConversation").checked = cfg.perConversation;
  $("#folder").textContent = cfg.folderName ? `📁 ${cfg.folderName}` : "No folder chosen";

  if (cfg.mode !== "folder") return setStatus("");

  const r = await chrome.runtime.sendMessage({ type: "folder-status" });
  if (r?.ok) setStatus("Folder connected", "ok");
  else if (r?.reason === "no-permission")
    setStatus("Chrome dropped access after restart — click Choose folder to reconnect.", "warn");
  else setStatus("Click Choose folder… to finish setup.", "warn");
}

// showDirectoryPicker() is not exposed inside extension popups (Chromium
// restriction), so the picking happens in a real tab.
$("#pick").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("picker.html") });
  window.close();
});

modeInputs.forEach((i) =>
  i.addEventListener("change", async () => {
    if (i.value === "folder" && !(await cgptGetHandle())) {
      await chrome.storage.local.set({ mode: "folder" });
      return setStatus("Now click Choose folder…", "warn");
    }
    await chrome.storage.local.set({ mode: i.value });
    load();
  })
);

$("#subfolder").addEventListener("change", (e) =>
  chrome.storage.local.set({ subfolder: e.target.value.trim() || "ChatGPT" })
);
$("#perConversation").addEventListener("change", (e) =>
  chrome.storage.local.set({ perConversation: e.target.checked })
);

load();
