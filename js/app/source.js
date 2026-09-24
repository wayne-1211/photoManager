// js/app/source.js — 照片來源列（外殼的一部分）。
//
// 選資料夾、選檔案、拖曳、清除、進度列都在這裡。來源是跨頁共用的狀態,
// 所以這一整塊只在啟動時綁一次, 換頁不會重來；頁面則透過 onLibraryChange()
// 知道照片換了要重畫。

import { escapeHtml } from "../utils/utils.js";
import { notify } from "../ui/notifications.js";
import { confirmDialog, alertDialog } from "./dialog.js";
import { state, Marks, fmtBytes, emitLibraryChange } from "./state.js";
import { rememberFolder, loadLastFolder, ensureAccess } from "./recent-folder.js";

const $ = (id) => document.getElementById(id);

/* ---------- 進度列 ---------- */
export function showProgress(done, total, label) {
  $("progressWrap").classList.add("active");
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("progressFill").style.width = pct + "%";
  $("progressLabel").textContent = `${label || "處理中"}… ${done} / ${total}（${pct}%）`;
}

export function showProgressText(text) {
  $("progressWrap").classList.add("active");
  $("progressFill").style.width = "100%";
  $("progressLabel").textContent = text;
}

export function hideProgress() {
  $("progressWrap").classList.remove("active");
  $("progressFill").style.width = "0%";
}

/** 換來源前先把畫面上的 <img> 清掉, 否則舊的 objectURL 被回收後瀏覽器會去撈已失效的 blob。 */
function detachImages() {
  for (const sel of ["#grid", "#manageGrid", "#previewWrap"]) {
    const node = document.querySelector(sel);
    if (node) node.innerHTML = "";
  }
}

/* ---------- 來源資訊 ---------- */
/** 一格數字。原本這幾格在首頁, 首頁拿掉之後就住在來源列裡。 */
function statCell(label, value) {
  return `<div class="source-stat"><span class="source-stat-value">${escapeHtml(value)}</span>`
    + `<span class="source-stat-label">${escapeHtml(label)}</span></div>`;
}

export function renderSourceInfo() {
  const stats = $("sourceStats");
  if (!stats) return;
  const s = PMLibrary.stats();

  if (!PMLibrary.mode) {
    stats.innerHTML = statCell("來源", "尚未選擇");
  } else {
    const where = PMLibrary.mode === "folder" ? PMLibrary.rootName : "選擇的檔案";
    stats.innerHTML = [
      statCell("來源", where),
      statCell("張數", `${s.total}`),
      statCell("EXIF", `${s.analysed} / ${s.total}`),
      statCell("已標記", `${s.marked}`),
      statCell("已整理", `${s.organized}`),
      statCell("容量", s.bytes ? fmtBytes(s.bytes) : "—"),
    ].join("");
  }
  stats.classList.toggle("is-loaded", !!PMLibrary.mode);
  $("rescanBtn").hidden = PMLibrary.mode !== "folder";
  $("clearBtn").hidden = !PMLibrary.mode;
}

function afterSourceChanged() {
  const restored = Marks.restore();
  state.selectedId = PMLibrary.photos.length ? PMLibrary.photos[0].id : null;
  state.editorPhoto = null;
  state.photosPage = 0;
  hideProgress();
  renderSourceInfo();
  emitLibraryChange();
  if (restored) notify.info(`已還原 ${restored} 張標記`);
}

async function openFolder() {
  try {
    detachImages();
    showProgressText("掃描中…");
    const skip = new Set(PMCategories.all().map((c) => c.folder));
    await PMLibrary.pickFolder({
      recursive: $("recursiveChk").checked,
      skipFolders: $("recursiveChk").checked ? skip : new Set(),
      onProgress: (n) => showProgressText(`掃描中… ${n} 張`),
    });
    rememberFolder(PMLibrary.rootHandle);
    afterSourceChanged();
  } catch (err) {
    hideProgress();
    if (err && err.name === "AbortError") return;
    await alertDialog({ title: "無法開啟資料夾", message: err?.message || String(err), tone: "danger" });
  }
}

async function rescanFolder() {
  if (PMLibrary.mode !== "folder") return;
  try {
    detachImages();
    showProgressText("掃描中…");
    const skip = new Set(PMCategories.all().map((c) => c.folder));
    await PMLibrary.rescan({
      skipFolders: $("recursiveChk").checked ? skip : new Set(),
      onProgress: (n) => showProgressText(`掃描中… ${n} 張`),
    });
    afterSourceChanged();
  } catch (err) {
    hideProgress();
    await alertDialog({ title: "重新掃描失敗", message: err?.message || String(err), tone: "danger" });
  }
}

function handleFiles(files) {
  if (PMLibrary.mode !== "files") detachImages();   // 從資料夾模式切過來時會清空舊來源
  const added = PMLibrary.addFiles(files);
  if (!added.length) return;
  if (!state.selectedId) {
    state.selectedId = PMLibrary.photos[0].id;
    state.editorPhoto = null;
  }
  renderSourceInfo();
  emitLibraryChange();
}

/* ---------- 綁定（只做一次） ---------- */
/**
 * 上一次開過的資料夾。
 *
 * 權限在重新整理之後通常會掉回 prompt, 而權限詢問只有在使用者的點擊裡才會過,
 * 所以這裡分兩種: 還有權限就直接開; 沒有就在來源列上放一顆按鈕, 按了再問。
 */
async function initRecentFolder() {
  const btn = $("recentBtn");
  if (!btn || !PMLibrary.supportsFolder()) return;
  const saved = await loadLastFolder();
  if (!saved) return;

  const open = async () => {
    btn.disabled = true;
    try {
      if (!await ensureAccess(saved.handle, true)) { btn.disabled = false; return; }
      detachImages();
      showProgressText("掃描中…");
      await PMLibrary.openFolderHandle(saved.handle, {
        recursive: $("recursiveChk").checked,
        skipFolders: new Set(PMCategories.all().map((c) => c.folder)),
        onProgress: (n) => showProgressText(`掃描中… ${n} 張`),
      });
      btn.hidden = true;
      afterSourceChanged();
    } catch (err) {
      hideProgress();
      btn.disabled = false;
      notify.warning(`開不了上次的資料夾: ${err.message}`);
    }
  };

  if (await ensureAccess(saved.handle, false)) {
    // 權限還在, 直接接上去 —— 使用者回來就看到上次那批照片。
    open();
    return;
  }
  btn.hidden = false;
  btn.textContent = `↻ ${saved.name}`;
  btn.title = `重新開啟上次的資料夾: ${saved.name}`;
  btn.addEventListener("click", open);
}

export function initSourceBar() {
  $("pickFolderBtn").addEventListener("click", openFolder);
  $("rescanBtn").addEventListener("click", rescanFolder);

  $("fileInput").addEventListener("change", (e) => {
    handleFiles(e.target.files);
    e.target.value = "";
  });

  $("clearBtn").addEventListener("click", async () => {
    if (!PMLibrary.photos.length) return;
    const ok = await confirmDialog({
      title: `清除 ${PMLibrary.photos.length} 張照片？`,
      message: "只清畫面與標記, 不會刪檔案。",
      tone: "danger", confirm: true, confirmText: "清除畫面",
    });
    if (!ok) return;
    detachImages();
    PMLibrary.clear();
    state.selectedId = null;
    state.editorPhoto = null;
    state.photosPage = 0;
    renderSourceInfo();
    emitLibraryChange();
  });

  /* 不支援 File System Access API 時的說明 */
  if (!PMLibrary.supportsFolder()) {
    $("pickFolderBtn").disabled = true;
    $("recursiveChk").disabled = true;
    const warn = $("fsWarn");
    warn.dataset.message = "1";
    // 這一句是功能受限的提示, 不是說明 —— 沒有它會變成「按了沒反應」。
    warn.textContent = location.protocol === "file:"
      ? "file:// 無法讀取資料夾, 請用本機伺服器開啟。"
      : "這個瀏覽器不支援資料夾模式（需要 Chrome / Edge）。";
  }

  renderSourceInfo();
  initRecentFolder();
}
