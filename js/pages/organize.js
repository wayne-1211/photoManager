// js/pages/organize.js — 整理分類: 左邊大圖、右邊縮圖側欄, 鍵盤一路標記下去。
//
// 標記只是存在記憶體與 localStorage 裡的一個 catId；真正動到硬碟上的檔案
// 只有按下「套用整理」那一刻（folder 模式）, 或打包成 zip（相容模式）。

import { escapeHtml, paintRange } from "../utils/utils.js";
import { confirmDialog, alertDialog } from "../app/dialog.js";
import {
  state, fmtBytes, saveMarks, Marks, onLibraryChange, attachThumb, renderPagination,
} from "../app/state.js";
import { showProgress, hideProgress } from "../app/source.js";
import { createViewer } from "./organize-viewer.js";

const $ = (id) => document.getElementById(id);

/** 照片資訊那一塊是開是合。預設收起來, 展開之後換照片也維持展開。 */
let infoOpen = false;
/** 左右對照時, 右邊那一格是哪一張。null = 只看一張。 */
let compareId = null;
/** 大圖檢視器。整頁重畫時會沿用同一個, 平移縮放才不會每次歸零。 */
let viewer = null;
/** 正在偷看下一張時的還原資料。 */
let peek = null;
/** 縮圖側欄目前畫的是第幾頁。換選取但還在同一頁的話就不必整片重畫。 */
let renderedPage = -1;

function photoById(id) {
  return id ? PMLibrary.photos.find((p) => p.id === id) || null : null;
}

function exitCompare(keepId) {
  compareId = null;
  if (keepId) selectManagedPhoto(keepId);
  updateSelection();
}

function setCompare(id) {
  const photo = photoById(id);
  if (!photo || photo.id === state.selectedId) return;
  compareId = photo.id;
  updateSelection();
}

function manageList() {
  return state.hideDone ? PMLibrary.photos.filter((p) => !p.catId) : PMLibrary.photos;
}

function selectedIndexIn(list) {
  const i = list.findIndex((p) => p.id === state.selectedId);
  return i < 0 ? 0 : i;
}

function currentPhotoId() {
  const list = manageList();
  const p = list[selectedIndexIn(list)];
  return p ? p.id : null;
}

/** 整理頁主動換照片時，編輯工具的共用照片也切回資料庫選取。 */
function selectManagedPhoto(id) {
  state.selectedId = id || null;
  state.editorPhoto = null;
}

/* ============================================================
   分類圖例
   ============================================================ */
function renderCatLegend() {
  const wrap = $("catLegend");
  if (!wrap) return;
  wrap.innerHTML = "";
  const cats = PMCategories.all();
  if (!cats.length) {
    wrap.innerHTML = '<span class="dim">尚無分類</span>';
    return;
  }
  const counts = new Map();
  PMLibrary.photos.forEach((p) => { if (p.catId) counts.set(p.catId, (counts.get(p.catId) || 0) + 1); });

  cats.forEach((cat) => {
    const item = document.createElement("button");
    item.className = "legend-item";
    item.title = cat.name;
    item.innerHTML = `
      <span class="legend-key" style="background:${cat.color}">${escapeHtml(cat.key || "·")}</span>
      <span class="legend-name">${escapeHtml(cat.name)}</span>
      <span class="legend-count">${counts.get(cat.id) || 0}</span>
      <span class="legend-action">${escapeHtml(PMCategories.actionLabel(cat.action))}</span>`;
    item.onclick = () => markCurrent(cat);
    wrap.appendChild(item);
  });

  const clearItem = document.createElement("button");
  clearItem.className = "legend-item ghost";
  clearItem.innerHTML = '<span class="legend-key plain">⌫</span><span class="legend-name">清除</span>';
  clearItem.onclick = () => clearCurrentMark();
  wrap.appendChild(clearItem);
}

/* ============================================================
   標記
   ============================================================ */
function markCurrent(cat) {
  const list = manageList();
  const i = selectedIndexIn(list);
  const photo = list[i];
  if (!photo || photo.organized) return;   // 已經搬過的就不再改
  photo.catId = photo.catId === cat.id ? null : cat.id;
  saveMarks();

  const after = manageList();
  const nextIdx = state.hideDone ? Math.min(i, after.length - 1) : Math.min(i + 1, after.length - 1);
  selectManagedPhoto(after[nextIdx] ? after[nextIdx].id : null);
  // 「只看未分類」開著的時候這一標就會讓清單變短, 那只能整片重畫; 其他時候
  // 只有這一張的角標變了, 換掉它就好。
  if (state.hideDone) renderManage();
  else { paintCardBadge(photo); updateSelection(); }
  renderCatLegend();
  renderApplyHint();
}

function clearCurrentMark() {
  const list = manageList();
  const photo = list[selectedIndexIn(list)];
  if (!photo) return;
  photo.catId = null;
  saveMarks();
  if (state.hideDone) renderManage();
  else { paintCardBadge(photo); updateSelection(); }
  renderCatLegend();
  renderApplyHint();
}

function moveSelection(delta) {
  const list = manageList();
  if (!list.length) return;
  const i = selectedIndexIn(list);
  const next = Math.min(Math.max(i + delta, 0), list.length - 1);
  selectManagedPhoto(list[next].id);
  updateSelection();
}

/* ============================================================
   大圖預覽
   ============================================================ */
/** 照片資訊那一塊（收合在照片底部）。每次重畫就依目前這張照片重填。 */
function buildInfoPanel(photo) {
  const info = document.createElement("details");
  info.className = "preview-info";
  info.open = infoOpen;
  info.addEventListener("toggle", () => { infoOpen = info.open; });

  const summary = document.createElement("summary");
  const summaryName = document.createElement("span");
  summaryName.className = "preview-summary-name";
  summaryName.textContent = photo.name;
  summary.appendChild(summaryName);
  info.appendChild(summary);

  const infoBody = document.createElement("div");
  infoBody.className = "preview-info-body";
  info.appendChild(infoBody);

  const meta = document.createElement("div");
  meta.className = "preview-meta";
  meta.textContent = fmtBytes(photo.size || 0);
  infoBody.appendChild(meta);

  if (photo.organized) {
    const done = document.createElement("div");
    done.className = "preview-cat-badge done";
    done.textContent = `✓ 已${photo.organized.action === "copy" ? "複製" : "移動"}到 ${photo.organized.folder}`;
    infoBody.appendChild(done);
  } else if (photo.catId) {
    const cat = PMCategories.byId(photo.catId);
    if (cat) {
      const badge = document.createElement("div");
      badge.className = "preview-cat-badge";
      badge.style.background = cat.color;
      badge.textContent = `${cat.name} → ${cat.action === "keep" ? "不移動" : cat.folder}`;
      infoBody.appendChild(badge);
    }
  }

  const exifWrap = document.createElement("div");
  exifWrap.className = "preview-exif";
  infoBody.appendChild(exifWrap);

  const sideFields = [
    ["dateTimeOriginal", "拍攝時間"], ["model", "相機型號"], ["lensModel", "鏡頭"],
    ["focalLength", "焦段"], ["fNumber", "光圈"], ["exposureTime", "快門"], ["iso", "ISO"],
    ["creativeStyle", "創意風格"],
  ];
  const fill = () => {
    exifWrap.innerHTML = "";
    let any = false;
    if (photo.info) {
      sideFields.forEach(([k, label]) => {
        const val = photo.info[k];
        if (val === null || val === undefined) return;
        any = true;
        const row = document.createElement("div");
        row.className = "row";
        row.innerHTML = `<span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(val)}</span>`;
        exifWrap.appendChild(row);
      });
    }
    if (!any) {
      exifWrap.innerHTML = `<p class="exif-empty">${photo.infoState === "idle" ? "讀取中…" : "無 EXIF"}</p>`;
    }
  };
  fill();
  info.refresh = fill;
  return info;
}

/**
 * 先在畫面外把圖解好, 再換到看得見的那個 <img> 上。
 * 直接指定 src 的話解碼會發生在下一次繪製, 那一幀就掉了 —— 兩千萬畫素的原圖
 * 解一次要好幾十毫秒, 一路點下去就是一路頓。
 */
async function swapImage(img, url) {
  const pre = new Image();
  pre.src = url;
  // decode() 在背景分頁裡可能永遠不會回來（瀏覽器把繪製整個停掉了）,
  // 所以同時等 load 事件, 再壓一個上限 —— 不管哪一個先到, 都要把圖換上去。
  await Promise.race([
    pre.decode().catch(() => {}),
    new Promise((done) => { pre.addEventListener("load", done, { once: true }); }),
    new Promise((done) => { pre.addEventListener("error", done, { once: true }); }),
    new Promise((done) => setTimeout(done, 400)),
  ]);
  img.src = url;
}

/** 把照片真的塞進某一格。縮圖先頂著, 原圖載完再換。 */
function fillPane(pane, onInfo) {
  const photo = pane.photo;
  if (pane.img.dataset.photoId === photo.id) return;
  pane.img.dataset.photoId = photo.id;

  if (photo.thumbUrl) pane.img.src = photo.thumbUrl;
  PMExif.applyOrientation(pane.img, photo.info ? photo.info.orientation : null, true);

  PMLibrary.ensureThumb(photo).then(() => onInfo?.());
  PMLibrary.fullUrl(photo).then(async (url) => {
    if (!url || !pane.img.isConnected || pane.img.dataset.photoId !== photo.id) return;
    await swapImage(pane.img, url);
    // 等的時候可能又換照片了。
    if (pane.img.dataset.photoId !== photo.id) return;
    PMExif.applyOrientation(pane.img, photo.info ? photo.info.orientation : null, true);
    // 換成原圖後尺寸才是最終的, 這時候重量一次可以拖多遠。
    pane.remeasure();
  }).catch((err) => console.warn("讀取原圖失敗: ", photo.name, err));
}

function renderPreview() {
  const wrap = $("previewWrap");
  if (!wrap) return;

  const list = manageList();
  const photo = list[selectedIndexIn(list)];
  if (!photo) {
    endPeek();
    viewer = null;
    compareId = null;
    wrap.innerHTML = '<p class="stat-empty">—</p>';
    return;
  }

  // 檢視器只建一次: 重建的話平移縮放會跟著沒了。
  if (!viewer || !wrap.contains(viewer.node)) {
    viewer = createViewer({
      onDropPhoto: setCompare,
      onExitCompare: () => exitCompare(),
    });
    bindPeekButton(viewer.peekButton);
    wrap.replaceChildren(viewer.node);
  }

  const other = compareId === photo.id ? null : photoById(compareId);
  if (compareId && !other) compareId = null;

  const panes = viewer.render(photo, other);
  // 正在畫面上的（含等一下要偷看的下一張）不能被原圖快取淘汰掉, 不然會變破圖。
  PMLibrary.pinFull([photo.id, other && other.id, nextPhoto() && nextPhoto().id]);
  const info = buildInfoPanel(photo);
  viewer.setInfo(info);
  panes.forEach((pane) => fillPane(pane, () => info.refresh()));

  preloadSoon(photo);
}

/**
 * 預先解好前後幾張原圖（偷看下一張才會是即時的）。
 * 但一張要解一次原圖, 連點的時候會排一長串在主執行緒上 —— 所以等手停下來才做。
 */
let preloadTimer = null;
function preloadSoon(photo) {
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    PMLibrary.preloadAround(PMLibrary.photos.indexOf(photo), 4, 2);
  }, 180);
}

/* ============================================================
   偷看下一張
   ------------------------------------------------------------
   按住 space（或這顆按鈕）就把左邊那一格換成下一張, 放開換回來。
   換的只有 <img> 的 src —— 平移縮放寫在外面那層,
   所以畫面位置完全不變, 只有內容閃一下。
   ============================================================ */
function nextPhoto() {
  const list = manageList();
  return list[selectedIndexIn(list) + 1] || null;
}

function startPeek() {
  if (peek || !viewer || !viewer.panes.length) return;
  const next = nextPhoto();
  if (!next) return;
  const pane = viewer.panes[0];
  const token = {};
  peek = {
    token, pane,
    src: pane.img.src,
    orientation: pane.photo.info ? pane.photo.info.orientation : null,
    name: pane.name.textContent,
  };
  pane.pane.classList.add("is-peek");
  PMLibrary.fullUrl(next).then(async (url) => {
    if (!peek || peek.token !== token || !url) return;
    await swapImage(pane.img, url);
    if (!peek || peek.token !== token) return;
    PMExif.applyOrientation(pane.img, next.info ? next.info.orientation : null, true);
    pane.name.textContent = next.name;
  }).catch(() => { /* 讀不到就維持原圖 */ });
}

function endPeek() {
  if (!peek) return;
  const { pane, src, orientation, name } = peek;
  peek = null;
  pane.img.src = src;
  PMExif.applyOrientation(pane.img, orientation, true);
  pane.name.textContent = name;
  pane.pane.classList.remove("is-peek");
}

/** 觸控裝置沒有 space, 所以那顆按鈕也是「按住才看得到」。 */
function bindPeekButton(btn) {
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startPeek();
    // 手指滑出按鈕也要能收到放開的事件; 抓不到就算了, pointerleave 會補。
    try { btn.setPointerCapture(e.pointerId); } catch { /* 沒這個指標就跳過 */ }
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => {
    btn.addEventListener(type, endPeek);
  });
}

/* ============================================================
   縮圖側欄
   ============================================================ */
/** 某一張的分類角標變了, 只換那一張 —— 不必把整頁縮圖重掛一次。 */
function paintCardBadge(photo) {
  const grid = $("manageGrid");
  const card = grid && grid.querySelector(`[data-photo-id="${photo.id}"]`);
  if (!card) return;
  card.querySelector(".cat-badge")?.remove();
  card.classList.toggle("organized", !!photo.organized);

  if (photo.organized) {
    const badge = document.createElement("div");
    badge.className = "cat-badge done";
    badge.textContent = "\u2713 " + photo.organized.folder;
    card.appendChild(badge);
    return;
  }
  const cat = photo.catId ? PMCategories.byId(photo.catId) : null;
  if (!cat) return;
  const badge = document.createElement("div");
  badge.className = "cat-badge";
  badge.style.background = cat.color;
  badge.textContent = cat.name;
  card.appendChild(badge);
}

/**
 * 只換選取。
 * 整片重畫要把幾十張縮圖重新掛回 DOM（瀏覽器得再解一次碼）, 點一張就跑一次的話
 * 會頓在手指底下。同一頁之內換選取其實只有兩個 class 變了, 換掉就好;
 * 真的換頁了才退回整片重畫。
 */
function updateSelection({ scroll = true } = {}) {
  const grid = $("manageGrid");
  const list = manageList();
  if (!grid || !list.length) { renderManage(); return; }

  const selIdx = selectedIndexIn(list);
  if (Math.floor(selIdx / state.pageSize) !== renderedPage) { renderManage(); return; }

  const selectedId = list[selIdx] ? list[selIdx].id : null;
  let selectedEl = null;
  for (const card of grid.children) {
    const id = card.dataset.photoId;
    const on = id === selectedId;
    card.classList.toggle("selected", on);
    card.classList.toggle("compare", id === compareId);
    if (on) selectedEl = card;
  }

  renderPreview();
  // 用滑鼠點的那一張本來就在畫面上, 不必再捲（scrollIntoView 也是一次強制重排）。
  if (scroll && selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

function renderManage() {
  const grid = $("manageGrid");
  if (!grid) return;
  const empty = $("manageEmpty");
  const list = manageList();
  const all = PMLibrary.stats();
  grid.innerHTML = "";

  $("mgmtPhotoCount").textContent = all.total
    ? `${all.total} · 標記 ${all.marked} · 整理 ${all.organized}`
    : "—";

  if (!list.length) {
    empty.style.display = "block";
    empty.querySelector("p").textContent = all.total ? "沒有符合的照片" : "尚未載入照片";
    renderPagination($("managePagination"), 0, 0, () => {});
    renderedPage = -1;
    renderPreview();
    return;
  }
  empty.style.display = "none";

  if (!state.selectedId || !list.some((p) => p.id === state.selectedId)) selectManagedPhoto(list[0].id);
  const selIdx = selectedIndexIn(list);

  const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
  const page = Math.floor(selIdx / state.pageSize);
  const start = page * state.pageSize;
  renderedPage = page;

  list.slice(start, start + state.pageSize).forEach((p, localIdx) => {
    const i = start + localIdx;
    const isMain = i === selIdx;
    const isCompare = p.id === compareId;
    const card = document.createElement("div");
    card.className = "thumb-card"
      + (isMain ? " selected" : "")
      + (isCompare ? " compare" : "")
      + (p.organized ? " organized" : "");
    card.dataset.photoId = p.id;
    // 拖到左邊的大圖上就變成左右對照。用自訂型別, 不會跟檔案拖放搞混。
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-pm-photo", p.id);
      e.dataTransfer.effectAllowed = "copy";
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));

    const img = document.createElement("img");
    img.alt = p.name;
    card.appendChild(img);

    const fnameTag = document.createElement("div");
    fnameTag.className = "fname-tag";
    fnameTag.textContent = p.name;
    card.appendChild(fnameTag);

    if (p.organized) {
      const badge = document.createElement("div");
      badge.className = "cat-badge done";
      badge.textContent = "✓ " + p.organized.folder;
      card.appendChild(badge);
    } else if (p.catId) {
      const cat = PMCategories.byId(p.catId);
      if (cat) {
        const badge = document.createElement("div");
        badge.className = "cat-badge";
        badge.style.background = cat.color;
        badge.textContent = cat.name;
        card.appendChild(badge);
      }
    }

    card.addEventListener("click", () => {
      // 對照中再點兩張裡的任一張, 就收回成單張 —— 點到的那張留下來。
      if (compareId && (p.id === state.selectedId || p.id === compareId)) {
        exitCompare(p.id);
        return;
      }
      selectManagedPhoto(p.id);
      updateSelection({ scroll: false });
    });

    grid.appendChild(card);
    attachThumb(img, p);
  });

  renderPagination($("managePagination"), page, totalPages, (newPage) => {
    const idx = Math.min(Math.max(newPage * state.pageSize, 0), list.length - 1);
    selectManagedPhoto(list[idx].id);
    renderManage();
  });

  renderPreview();
  renderApplyHint();

  const selectedEl = grid.querySelector(".thumb-card.selected");
  if (selectedEl) selectedEl.scrollIntoView({ block: "nearest" });
}

/* ============================================================
   套用整理 / ZIP 打包
   ============================================================ */
function renderApplyHint() {
  const hint = $("applyHint");
  if (!hint) return;
  const applyBtn = $("applyBtn");
  const exportBtn = $("exportBtn");

  if (PMLibrary.mode === "files") {
    applyBtn.hidden = true;
    exportBtn.hidden = false;
    const marked = PMLibrary.photos
      .filter((p) => p.catId && (PMCategories.byId(p.catId) || {}).action !== "keep").length;
    hint.innerHTML = `可打包 <b>${marked}</b> 張`;
    exportBtn.disabled = marked === 0;
    return;
  }

  applyBtn.hidden = false;
  exportBtn.hidden = true;

  if (PMLibrary.mode !== "folder") {
    hint.textContent = "尚未選擇資料夾";
    applyBtn.disabled = true;
    return;
  }

  const p = PMOrganize.plan(PMLibrary.photos);
  applyBtn.disabled = p.total === 0;
  if (p.total === 0) {
    hint.textContent = "沒有待整理的照片";
    return;
  }
  const lines = p.byFolder
    .sort((a, b) => b.count - a.count)
    .map((b) => `<span class="plan-row"><b>${b.count}</b> 張 → <code>${escapeHtml(b.folder)}/</code> <span class="dim">${PMCategories.actionLabel(b.action)}</span></span>`)
    .join("");
  hint.innerHTML = `<b>${p.total}</b> 張 → <code>${escapeHtml(PMLibrary.rootName)}</code>${lines}`;
}

async function applyOrganize() {
  const plan = PMOrganize.plan(PMLibrary.photos);
  if (!plan.total) return;

  const summary = plan.byFolder
    .map((b) => `  ${b.folder}/  ${b.count} 張（${PMCategories.actionLabel(b.action)}）`).join("\n");
  const ok = await confirmDialog({
    title: `整理 ${plan.total} 張照片？`,
    message: `即將在資料夾「${PMLibrary.rootName}」內整理:\n\n${summary}\n\n「移動」會真的改變檔案在硬碟上的位置（不會經過資源回收筒）。`,
    tone: "danger", confirm: true, confirmText: "開始整理",
  });
  if (!ok) return;

  const btn = $("applyBtn");
  btn.disabled = true;
  const original = btn.textContent;
  try {
    const result = await PMOrganize.run(plan.items, (done, total) => {
      showProgress(done, total, "整理中");
      btn.textContent = `整理中… ${done}/${total}`;
    });
    hideProgress();
    Marks.write();

    const box = $("applyResult");
    box.hidden = false;
    box.className = "apply-result" + (result.failed.length ? " has-error" : " ok");
    box.innerHTML = `移動 <b>${result.moved}</b> · 複製 <b>${result.copied}</b>`
      + (result.failed.length
        ? `<br>失敗 <b>${result.failed.length}</b>:<br>` + result.failed.slice(0, 8)
          .map((f) => `<code>${escapeHtml(f.name)}</code> — ${escapeHtml(f.message)}`).join("<br>")
        : "");
  } catch (err) {
    hideProgress();
    await alertDialog({ title: "整理失敗", message: err?.message || String(err), tone: "danger" });
  } finally {
    btn.textContent = original;
    renderCatLegend();
    renderManage();
  }
}

/** 相容模式: 把標記好的照片打包成 zip。JSZip 用到才載。 */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("載入 " + src + " 失敗"));
    document.head.appendChild(s);
  });
}

async function exportZip() {
  const btn = $("exportBtn");
  const groups = new Map();
  PMLibrary.photos.forEach((p) => {
    if (!p.catId) return;
    const cat = PMCategories.byId(p.catId);
    if (!cat || cat.action === "keep") return;
    const arr = groups.get(cat.folder) || [];
    arr.push(p);
    groups.set(cat.folder, arr);
  });
  let count = 0;
  groups.forEach((arr) => { count += arr.length; });
  if (!count) {
    await alertDialog({ title: "沒有可打包的照片", message: "先標記需要移動或複製的分類。" });
    return;
  }

  btn.disabled = true;
  const original = btn.textContent;
  try {
    if (typeof JSZip === "undefined") {
      btn.textContent = "載入打包工具…";
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
    }
    const zip = new JSZip();
    const used = new Set();
    groups.forEach((arr, folder) => {
      arr.forEach((p) => {
        let name = p.name;
        let key = folder + "/" + name;
        let n = 1;
        while (used.has(key)) {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? p.name.slice(0, dot) : p.name;
          const ext = dot > 0 ? p.name.slice(dot) : "";
          name = `${base}_${n++}${ext}`;
          key = folder + "/" + name;
        }
        used.add(key);
        zip.folder(folder).file(name, p.file);
      });
    });

    btn.textContent = "打包中…";
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) => {
      btn.textContent = `打包中… ${Math.round(meta.percent)}%`;
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Photo_Manager_Export.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.error(err);
    await alertDialog({ title: "打包失敗", message: err?.message || String(err), tone: "danger" });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ============================================================
   掛載
   ============================================================ */
/**
 * 讓整理頁自己填滿視窗: 版面的高度 = 視窗高度減掉它上面那些東西。
 * 這樣捲動只會發生在右邊的縮圖欄裡, 左邊的大圖一直留在原地 ——
 * 標記照片的時候, 大圖不該跟著捲走。
 */
function fitLayoutHeight() {
  const layout = $("manageLayout");
  if (!layout) return;
  // 窄螢幕是上下疊的單欄, 這時候就讓它照一般的方式捲。
  if (window.innerWidth <= 900) { layout.style.height = ""; return; }
  const top = layout.getBoundingClientRect().top + window.scrollY;
  // 主內容區自己還有一段下內距, 不扣掉的話整頁還是會多出那一小段可以捲。
  const main = document.querySelector(".main");
  const bottom = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
  layout.style.height = `max(320px, calc(100dvh - ${Math.round(top + bottom + 4)}px))`;
}

export function mountPage() {
  // 每次進入整理分類頁都從收合狀態開始；同一次操作中換照片則保留使用者選擇。
  infoOpen = false;
  compareId = null;
  viewer = null;
  peek = null;
  renderedPage = -1;
  // 同步方向以整理分類為準；進入本頁後，下一個編輯工具會採用這裡的目前照片。
  state.editorPhoto = null;
  const grid = $("manageGrid");
  const slider = $("mgmtColSlider");
  slider.value = String(state.manageColumns);
  paintRange(slider);
  $("mgmtColCount").textContent = String(state.manageColumns);
  grid.style.gridTemplateColumns = `repeat(${state.manageColumns},1fr)`;
  slider.addEventListener("input", (e) => {
    state.manageColumns = parseInt(e.target.value, 10) || 3;
    paintRange(slider);
    $("mgmtColCount").textContent = e.target.value;
    grid.style.gridTemplateColumns = `repeat(${state.manageColumns},1fr)`;
  });

  const hideDone = $("hideDoneChk");
  hideDone.checked = state.hideDone;
  hideDone.addEventListener("change", (e) => {
    state.hideDone = e.target.checked;
    renderManage();
  });

  $("applyBtn").addEventListener("click", applyOrganize);
  $("exportBtn").addEventListener("click", exportZip);

  /* 鍵盤: 這一頁才綁, 離開就解掉 */
  const onKey = (e) => {
    const tag = document.activeElement ? document.activeElement.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector(".modal-overlay.open")) return;
    if (!PMLibrary.photos.length) return;

    if (e.code === "Space") {
      // 預設會捲動整頁, 一定要擋掉。
      e.preventDefault();
      if (!e.repeat) startPeek();
      return;
    }

    const cols = state.manageColumns;
    switch (e.key) {
      case "ArrowRight": e.preventDefault(); moveSelection(1); return;
      case "ArrowLeft": e.preventDefault(); moveSelection(-1); return;
      case "ArrowDown": e.preventDefault(); moveSelection(cols); return;
      case "ArrowUp": e.preventDefault(); moveSelection(-cols); return;
      case "Backspace":
      case "Delete": e.preventDefault(); clearCurrentMark(); return;
      default: break;
    }
    const cat = PMCategories.byKey(e.key);
    if (cat) {
      e.preventDefault();
      markCurrent(cat);
    }
  };
  const onKeyUp = (e) => { if (e.code === "Space") endPeek(); };
  // 切到別的視窗時鍵盤放開的事件收不到, 會卡在偷看狀態。
  const onBlur = () => endPeek();
  document.addEventListener("keydown", onKey);
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  renderCatLegend();
  renderManage();
  fitLayoutHeight();

  const onResize = () => { fitLayoutHeight(); viewer?.resize(); };
  window.addEventListener("resize", onResize);
  const off = onLibraryChange(() => {
    renderCatLegend();
    renderManage();
    // 圖例可能換行, 版面的起點會跟著變。
    fitLayoutHeight();
  });
  return () => {
    endPeek();
    PMLibrary.pinFull([]);
    clearTimeout(preloadTimer);
    viewer = null;
    compareId = null;
    renderedPage = -1;
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onResize);
    off();
  };
}
