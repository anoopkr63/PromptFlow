# ChatGPT Image Downloader

Hover download button on every image in a ChatGPT conversation, a "Download all
images" button, and a right-click "Save ChatGPT image" item.

## Choosing where images go
Click the extension icon in the toolbar:

- **A folder I choose** — click **Choose folder…**; it opens a settings tab
  (Chrome blocks the folder picker inside popups) where you pick any folder on
  disk once. Every image goes straight there, no dialog.
  **Chrome / Edge / Opera / Vivaldi only.** Brave removes the File System Access
  API to resist fingerprinting and Firefox never shipped it, so on those browsers
  the settings tab shows the Downloads workaround instead.
- **Downloads folder** — fallback; writes to a subfolder inside Downloads.
- **Separate subfolder per conversation** — optional, groups by chat id.

Filenames: `2026-09-07_6a9ba80e_01.png`. Existing files are never overwritten
(`-1`, `-2` suffixes).

### If the toolbar icon shows a red `!`
Chrome revokes folder access when the browser restarts. Images are still saved
(they fall back to Downloads) — open the popup and click **Choose folder…**
again to reconnect. Picking the same folder re-grants it in one click.

## Install (Chrome / Brave / Edge)
1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder
3. Reload your chatgpt.com tab, then set the folder from the toolbar icon

## Notes
- Only images ChatGPT **generated** are picked up. Reference images you uploaded
  live in user turns and are ignored, as are avatars and icons (<150px).
- Batch downloads are spaced 250ms apart so Chrome doesn't throttle them.
- `saveAs: false` is set explicitly, which overrides Chrome's global
  "Ask where to save each file" setting.

## Image queue
The **Image queue** panel sits on the right of every conversation. One row per image:

| Row | What it does |
|-----|--------------|
| `1` | prompt text — type or paste it |
| 📎  | reference image for *that* prompt only (click, or drag an image onto the row) |
| ×   | delete the row |

**Reference for all prompts** (the dashed slot above the rows) is attached to
every prompt in the run — the usual case for character-lock work. A
row's own 📎 overrides it for that row. The shared reference is remembered
between sessions (under 4MB).

Set **File name** once (e.g. `frame`) — the rows save as `frame-1`, `frame-2`, …
`frame-n`. The destination folder is shown at the top; **change** opens the
folder picker.

**Import .md** loads a whole prompt file at once — point it at an
`image-prompts.md` and every `frame-N` becomes a row, in order. Dropping the
`.md` anywhere on the panel does the same. Recognised layouts:

```
**frame-1** — *"caption"*        prompt on the next line
<prompt>

**frame-1:** <prompt>            prompt on the same line
**frame-1 HOOK (3.9s):** <prompt>
```

`frame` / `image` / `shot` / `scene` / `prompt` all work as the keyword, and the
File name field is set from it automatically. Captions, tables, headings and
rule paragraphs are skipped.

Each row holds exactly one prompt — paste freely, multi-line prompts stay in
their row. Use **+ Add prompt** for the next one.

A failed prompt is **re-sent automatically** up to 3 times (8s apart), logged as
`↻ frame-3: … — retrying (2/3)`. Between prompts the runner waits for the reply
to finish completely, then pauses 4s. Only after all 3 tries does a row go red.

**Continue** — if a row fails or you press Stop, the primary button becomes
**Continue (n)**. It runs only the rows that have no image yet, keeps the ones
already produced, and the zip at the end contains all of them together. Row
numbers stay tied to the badge, so a retried row 3 is still `frame-3`.
**↺** clears the results (keeping the prompts) so Start runs everything again.

Press **Start**. It attaches the reference image (if any), sends the prompt,
waits for the image to finish, then moves to the next row. Nothing downloads
mid-run: when the last row is done the whole batch is zipped and saved in one
go, so you get at most one save prompt per batch. Rows turn
green when saved, red when they fail. **Stop** halts after the current row.

Timeout is 300s per image and there's a 3s gap between prompts — both fixed, no
knobs to set. Keep the tab open and don't type in the composer during a run.

Image detection has three layers, tried in order:

1. **Network capture** — the background worker watches image requests in the
   tab (`webRequest`), so the result is found regardless of ChatGPT's markup.
   Only trusted after generation has started and finished, and only if the URL
   loads at 256px or more.
2. **DOM, newest turn first** — `<img>` and CSS `background-image`.
3. **Page-wide diff** — anything that wasn't present when the prompt was sent.

If all three come up empty, the console prints a table of every image on the
page with its size and why it was rejected, plus the captured request list.

## Copy diagnostics
The link under the log copies a full, timestamped trace of the last run: every
boundary the runner crossed (idle wait, attach, which method typed the prompt,
which one sent it, turn counts, every poll where the state changed, captured
request counts, and the exact failure), followed by the extension's view of
every image on the page and the raw list of image requests the background
worker saw. Paste that when a run stalls — it says *which stage* stopped, which
the visible symptom never does.

Sending is resilient: the prompt goes in via execCommand, then a paste event,
then direct ProseMirror nodes; sending tries the send button, then a real Enter
keypress. Each step is verified before moving on, so a ChatGPT UI change fails
with a specific message rather than silently doing nothing.

## "Extension context invalidated"
Seen after reloading the extension while a ChatGPT tab was already open: the old
content script is still in the page but its link to the extension is gone.
**Refresh the ChatGPT tab.** The extension now detects this and shows a red
"refresh this page" banner instead of throwing into the console.

Rule of thumb: every time you reload at `chrome://extensions`, refresh open
ChatGPT tabs too.

**Reset** clears the panel for a fresh batch: all prompt rows emptied, the last
run's results and log dropped, the ZIP button hidden. The reference image and
file name are kept (clear the reference with its own ×).

## ZIP
- **Download ZIP (n)** appears in the queue panel when a run finishes — bundles
  exactly that run's images, named `frame-1.png … frame-n.png`.
- **ZIP** next to "Download generated images" bundles every generated image on
  the page — including ones from earlier in an old conversation. For just the
  latest batch, use the panel's button.

In folder mode the archive is written straight into your folder; otherwise it
downloads as `<subfolder>/<name>-YYYY-MM-DD.zip`. Files are stored uncompressed
(PNG/JPEG are already compressed), so zipping is fast and lossless.
