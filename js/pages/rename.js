// js/pages/rename.js — 批次改名。
//
// 一條命名樣式 + 幾個 token, 下面即時列出「原本 → 之後」。按下去才真的動到硬碟。
//
// 為什麼要預覽: 改名是不可逆的（檔案系統沒有復原）, 所以在按下去之前
// 每一個新檔名都必須先看得到, 撞名也要先標出來。

import { escapeHtml, debounce } from "../utils/utils.js";
import { confirmDialog, alertDialog } from "../app/dialog.js";
import { state, onLibraryChange, renderPagination } from "../app/state.js";
import { showProgress, hideProgress, renderSourceInfo } from "../app/source.js";

const $ = (id) => document.getElementById(id);

/** 可以用的 token。說明就是它自己的例子 —— 看一眼就知道會變成什麼。 */
const TOKENS = [
  { key: "date", hint: "20260923" },
  { key: "time", hint: "174218" },
  { key: "camera", hint: "ILCE-6400" },
  { key: "lens", hint: "E 18-135mm" },
  { key: "focal", hint: "35mm" },
  { key: "iso", hint: "ISO100" },
  { key: "fnumber", hint: "f5.6" },
  { key: "shutter", hint: "1-250s" },
  { key: "folder", hint: "DCIM" },
  { key: "original", hint: "DSC01234" },
  { key: "index", hint: "001" },
];

let page = 0;

/* ============================================================
   Token → 值
   ============================================================ */
function baseName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** 檔名不能有這些字, 換成底線比整個失敗好。 */
function sanitize(value) {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/** EXIF 的 "2026:09:23 17:42:18"。沒有就退回檔案的修改時間。 */
function shotDate(photo) {
  const raw = photo.info && photo.info.dateTimeOriginal;
  const m = raw && String(raw).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return { date: m[1] + m[2] + m[3], time: m[4] + m[5] + m[6] };
  if (photo.lastModified) {
    const d = new Date(photo.lastModified);
    const p = (n) => String(n).padStart(2, "0");
    return {
      date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
      time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    };
  }
  return { date: "", time: "" };
}

function tokenValues(photo, index, pad) {
  const i = photo.info || {};
  const { date, time } = shotDate(photo);
  const slash = photo.relPath.lastIndexOf("/");
  const folder = slash > 0 ? photo.relPath.slice(0, slash).split("/").pop() : (PMLibrary.rootName || "");

  return {
    date,
    time,
    camera: sanitize(i.model || ""),
    lens: sanitize(i.lensModel || ""),
    focal: i.focalLength ? String(i.focalLength).replace(/\s+/g, "") : "",
    iso: i.iso ? "ISO" + i.iso : "",
    fnumber: i.fNumber ? String(i.fNumber).replace("/", "") : "",
    // 檔名裡不能有斜線, 1/250 s 只好寫成 1-250s。
    shutter: i.exposureTime ? String(i.exposureTime).replace(/\//g, "-").replace(/\s+/g, "") : "",
    folder: sanitize(folder),
    original: baseName(photo.name),
    index: String(index).padStart(pad, "0"),
  };
}

/* ============================================================
   樣式 → 檔名
   ============================================================ */
/** "/DSC_(\d+)/i" 或直接一段樣式。解不開就回 null, 上面會顯示紅字。 */
function parseRegex(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const m = raw.match(/^\/(.*)\/([gimsuy]*)$/);
  try {
    return m ? new RegExp(m[1], m[2] || "g") : new RegExp(raw, "g");
  } catch {
    return false;   // false = 寫錯了, null = 沒填
  }
}

function buildName(photo, index, opts) {
  const values = tokenValues(photo, index, opts.pad);
  let name = String(opts.pattern || "")
    .replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole));

  if (opts.regex) name = name.replace(opts.regex, opts.replace);

  // 連續或落單的分隔符號多半是某個 token 沒有值造成的, 收一收。
  name = sanitize(name).replace(/[_\-.]{2,}/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "");
  if (!name) name = baseName(photo.name);

  let ext = extName(photo.name);
  if (opts.extCase === "lower") ext = ext.toLowerCase();
  else if (opts.extCase === "upper") ext = ext.toUpperCase();
  return ext ? `${name}.${ext}` : name;
}

/** 算出整批的新名字, 並標出重複的。 */
function buildPlan(photos, opts) {
  const seen = new Map();
  return photos.map((photo, i) => {
    const name = buildName(photo, opts.start + i, opts);
    const key = name.toLowerCase();
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    return { photo, name, duplicate: count > 1, changed: name !== photo.name };
  });
}

/* ============================================================
   畫面
   ============================================================ */
function currentOpts() {
  const regex = parseRegex($("rnFind").value);
  return {
    pattern: $("rnPattern").value,
    start: parseInt($("rnStart").value, 10) || 0,
    pad: Math.min(Math.max(parseInt($("rnPad").value, 10) || 1, 1), 8),
    extCase: $("rnCase").value,
    markedOnly: $("rnMarkedOnly").checked,
    regex: regex || null,
    regexBad: regex === false,
    replace: $("rnReplace").value,
  };
}

function targetPhotos(opts) {
  return opts.markedOnly ? PMLibrary.photos.filter((p) => p.catId) : PMLibrary.photos;
}

function render() {
  const host = $("rnPreview");
  if (!host) return;
  const opts = currentOpts();

  $("rnRegexNote").textContent = opts.regexBad ? "這段正則寫錯了" : "";
  $("rnRegexNote").classList.toggle("is-bad", opts.regexBad);

  const photos = targetPhotos(opts);
  const empty = $("rnEmpty");
  const plan = buildPlan(photos, opts);
  const changed = plan.filter((r) => r.changed).length;
  const dup = plan.filter((r) => r.duplicate).length;

  $("rnSummary").innerHTML = photos.length
    ? `<b>${changed}</b> / ${photos.length} 張會改名` + (dup ? ` · <span class="rn-warn">${dup} 個撞名</span>` : "")
    : "—";
  $("rnApplyBtn").disabled = !changed || PMLibrary.mode !== "folder";

  if (!photos.length) {
    host.replaceChildren();
    empty.style.display = "block";
    empty.querySelector("p").textContent = PMLibrary.photos.length ? "沒有符合的照片" : "尚未載入照片";
    renderPagination($("rnPagination"), 0, 0, () => {});
    return;
  }
  empty.style.display = "none";

  const totalPages = Math.max(1, Math.ceil(plan.length / state.pageSize));
  page = Math.min(Math.max(page, 0), totalPages - 1);
  const start = page * state.pageSize;

  const rows = plan.slice(start, start + state.pageSize).map((r) => `
    <div class="rn-row${r.duplicate ? " is-dup" : ""}${r.changed ? "" : " is-same"}">
      <span class="rn-old" title="${escapeHtml(r.photo.relPath)}">${escapeHtml(r.photo.name)}</span>
      <span class="rn-arrow">→</span>
      <span class="rn-new" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
    </div>`).join("");
  host.innerHTML = rows;

  renderPagination($("rnPagination"), page, totalPages, (next) => {
    page = next;
    render();
  });
}

const renderSoon = debounce(render, 120);

/* ============================================================
   套用
   ============================================================ */
async function applyRename() {
  const opts = currentOpts();
  const plan = buildPlan(targetPhotos(opts), opts).filter((r) => r.changed);
  if (!plan.length) return;

  const sample = plan.slice(0, 5).map((r) => `  ${r.photo.name}  →  ${r.name}`).join("\n");
  const ok = await confirmDialog({
    title: `改名 ${plan.length} 個檔案？`,
    message: `${sample}${plan.length > 5 ? `\n  …還有 ${plan.length - 5} 個` : ""}`
      + "\n\n檔案會直接在硬碟上改名（不會經過資源回收筒）。",
    tone: "danger", confirm: true, confirmText: "開始改名",
  });
  if (!ok) return;

  const btn = $("rnApplyBtn");
  const original = btn.textContent;
  btn.disabled = true;
  try {
    const result = await PMOrganize.rename(plan, (done, total) => {
      showProgress(done, total, "改名中");
      btn.textContent = `改名中… ${done}/${total}`;
    });
    hideProgress();

    const box = $("rnResult");
    box.hidden = false;
    box.className = "apply-result" + (result.failed.length ? " has-error" : " ok");
    box.innerHTML = `已改名 <b>${result.renamed}</b>`
      + (result.failed.length
        ? `<br>失敗 <b>${result.failed.length}</b>:<br>` + result.failed.slice(0, 8)
          .map((f) => `<code>${escapeHtml(f.name)}</code> — ${escapeHtml(f.message)}`).join("<br>")
        : "");
  } catch (err) {
    hideProgress();
    await alertDialog({ title: "改名失敗", message: err?.message || String(err), tone: "danger" });
  } finally {
    btn.textContent = original;
    renderSourceInfo();
    render();
  }
}

/* ============================================================
   掛載
   ============================================================ */
/**
 * 樣式裡的 {camera} / {date} 都來自 EXIF, 沒掃過就全是空的 ——
 * 一進這一頁就先補掃一遍, 預覽才是真的。
 */
let scanTask = null;
function ensureAnalysed() {
  const s = PMLibrary.stats();
  if (!s.total || s.analysed >= s.total || scanTask) return;
  scanTask = PMLibrary.scanAllInfo((done, total) => {
    showProgress(done, total, "分析 EXIF");
    renderSourceInfo();
  });
  scanTask.promise.then(() => {
    scanTask = null;
    hideProgress();
    renderSourceInfo();
    render();
  });
}

export function mountPage() {
  page = 0;

  // Token 按一下就插到游標的位置 —— 比自己打括號快, 也不會拼錯。
  const tokens = $("rnTokens");
  const pattern = $("rnPattern");
  TOKENS.forEach((t) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "rn-token";
    chip.innerHTML = `<code>{${t.key}}</code><span>${escapeHtml(t.hint)}</span>`;
    chip.addEventListener("click", () => {
      const at = pattern.selectionStart ?? pattern.value.length;
      const text = `{${t.key}}`;
      pattern.value = pattern.value.slice(0, at) + text + pattern.value.slice(pattern.selectionEnd ?? at);
      pattern.focus();
      pattern.setSelectionRange(at + text.length, at + text.length);
      render();
    });
    tokens.appendChild(chip);
  });

  ["rnPattern", "rnFind", "rnReplace"].forEach((id) => {
    $(id).addEventListener("input", renderSoon);
  });
  ["rnStart", "rnPad", "rnCase", "rnMarkedOnly"].forEach((id) => {
    $(id).addEventListener("input", render);
    $(id).addEventListener("change", render);
  });
  $("rnApplyBtn").addEventListener("click", applyRename);

  render();
  ensureAnalysed();
  const off = onLibraryChange(() => { render(); ensureAnalysed(); });
  return () => {
    // 離開就不用再掃下去了, 掃到一半的結果已經留在各張照片上。
    scanTask?.abort();
    scanTask = null;
    hideProgress();
    off();
  };
}
