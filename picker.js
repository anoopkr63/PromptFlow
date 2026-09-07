const $ = (s) => document.getElementById(s);
const set = (t, cls = "") => { $("status").textContent = t; $("status").className = `status ${cls}`; };

// Brave strips the File System Access API for fingerprint resistance; Firefox
// never shipped it. Chrome/Edge/Opera/Vivaldi have it.
function browserName() {
  const ua = navigator.userAgent;
  if (navigator.brave?.isBrave) return "Brave";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "This browser";
}

async function showFallback() {
  const name = browserName();
  $("fsa").hidden = true;
  $("fallback").hidden = false;
  $("why").innerHTML =
    name === "Brave"
      ? "<b>Brave removes the folder-picking API</b> (File System Access) to resist fingerprinting, so no extension can open a folder picker here. Chrome supports it if you'd rather switch browsers for this."
      : `<b>${name} doesn't support the File System Access API</b>, so a folder picker isn't available.`;

  const cfg = await chrome.storage.local.get({ subfolder: "ChatGPT" });
  $("subfolder").value = cfg.subfolder;
  const preview = () => {
    const v = $("subfolder").value.trim();
    $("preview").textContent = v ? `Downloads/${v}` : "Downloads";
  };
  preview();
  $("subfolder").addEventListener("input", async () => {
    preview();
    await chrome.storage.local.set({ subfolder: $("subfolder").value.trim(), mode: "downloads" });
  });
  await chrome.storage.local.set({ mode: "downloads" });
}

(async () => {
  const { folderName, mode } = await chrome.storage.local.get({ folderName: "", mode: "downloads" });
  $("current").textContent =
    mode === "folder" && folderName ? `Current: 📁 ${folderName}` : "Currently saving into your browser's download location.";

  if (typeof window.showDirectoryPicker !== "function") await showFallback();
})();

$("pick").addEventListener("click", async () => {
  try {
    const dir = await showDirectoryPicker({ id: "cgpt-dl", mode: "readwrite", startIn: "downloads" });
    let perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm !== "granted") perm = await dir.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return set("Write access denied.", "warn");

    await cgptSetHandle(dir);
    await chrome.storage.local.set({ mode: "folder", folderName: dir.name });
    chrome.action.setBadgeText({ text: "" });
    $("current").textContent = `Current: 📁 ${dir.name}`;
    set(`Connected. Images now save into "${dir.name}". You can close this tab.`, "ok");
  } catch (e) {
    if (e?.name !== "AbortError") set(String(e.message || e), "warn");
  }
});
