// js/pages/photos.js — 照片檢視: 縮圖牆 + 每張卡片下面的 EXIF 欄位。
//
// 卡片點下去可以直接把這張送進任何一個編輯工具（清單是從路由長出來的,
// 以後多一個工具這裡就自動多一個）。篩選與 EXIF 欄位都開在對話框裡,
// 對話框的高度是固定的, 增減條件不會讓它忽大忽小。

import { escapeHtml, paintRange, icon, el } from "../utils/utils.js";
import { routeTo, ROUTES } from "../core/router.js";
import { notify } from "../ui/notifications.js";
import { openModal, closeModal } from "../ui/modal.js";
import {
  state, FIELD_DEFS, onLibraryChange, attachThumb, renderPagination,
} from "../app/state.js";
import { showProgress, hideProgress, renderSourceInfo } from "../app/source.js";
import {
  FILTER_FIELDS, optionsFor, applyFilters, activeCount,
} from "../app/photo-filter.js";
import { openInspector } from "../app/exif-inspector.js";

const $ = (id) => document.getElementById(id);

/*
 * 縮圖牆重畫一次就是幾十張圖重新掛回 DOM（瀏覽器要重新解碼一次）。
 * 在對話框裡每按一下就跑一次的話, 開窗與每一次點擊都會頓一下, 所以對話框
 * 開著的時候只記下「有變」, 數字照樣即時更新（頁尾那行 x / y 張）,
 * 真正的重畫等關窗再做一次。
 */
let gridDirty = false;
function markGridDirty() { gridDirty = true; }
function flushGrid() {
  if (!gridDirty) return;
  gridDirty = false;
  renderGrid();
}

/** 編輯工具的清單直接從路由來, 之後新增工具不必再回來改這裡。 */
function editTargets() {
  return Object.entries(ROUTES)
    .filter(([, r]) => r.nav && r.group === "照片編輯")
    .map(([name, r]) => ({ route: name, icon: r.icon, label: r.label }));
}

/**
 * 把這張照片設成「目前編輯中的照片」, 然後換到那個工具。
 * 工具掛載時會自己還原這張（photo-picker 的 restoreCurrent）, 所以這裡不必再傳一次。
 */
async function openIn(route, photo) {
  try {
    const file = await PMLibrary.getFile(photo);
    state.selectedId = photo.id;
    state.editorPhoto = { file, photoId: photo.id };
    routeTo(route);
  } catch (err) {
    console.error(err);
    notify.danger(`讀取失敗: ${err.message}`);
  }
}

/** 按縮圖上那顆工具鈕 → 選一個工具。工具多了就是多一列, 版面不會擠。 */
function openToolMenu(photo) {
  const list = el("div", { class: "tool-menu" },
    ...editTargets().map((t) => el("button", {
      type: "button",
      class: "tool-menu-item",
      onclick: () => { closeModal(); openIn(t.route, photo); },
    },
    el("span", { class: "tool-menu-ico", html: icon(t.icon, { size: "18px" }) }),
    el("span", { class: "tool-menu-label" }, t.label),
    el("span", { class: "tool-menu-go", html: icon("arrow-right", { size: "14px" }) }),
    )),
  );
  openModal({ title: photo.name, maxWidth: "380px", body: list });
}

function fillExifList(photo, listEl) {
  listEl.innerHTML = "";
  let any = false;
  if (photo.info) {
    FIELD_DEFS.forEach((f) => {
      if (!state.fields.get(f.key)) return;
      const val = photo.info[f.key];
      if (val === null || val === undefined) return;
      any = true;
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="k">${escapeHtml(f.label)}</span><span class="v">${escapeHtml(val)}</span>`;
      listEl.appendChild(row);
    });
  }
  if (!any) {
    const e = document.createElement("div");
    e.className = "exif-empty";
    e.textContent = photo.infoState === "idle" ? "讀取中…" : "無 EXIF";
    listEl.appendChild(e);
  }
}

/* ============================================================
   EXIF 欄位（對話框）
   ============================================================ */
function openFieldModal() {
  const body = el("div", { class: "chip-row" });
  FIELD_DEFS.forEach((f) => {
    const chip = el("button", { type: "button" });
    const paint = () => {
      const on = !!state.fields.get(f.key);
      chip.className = "chip" + (on ? " on" : "");
      chip.setAttribute("aria-pressed", String(on));
    };
    chip.textContent = f.label;
    chip.addEventListener("click", () => {
      state.fields.set(f.key, !state.fields.get(f.key));
      paint();
      paintToolbarCounts();
      markGridDirty();
    });
    paint();
    body.appendChild(chip);
  });

  openModal({
    title: "EXIF 欄位",
    className: "modal-fixed",
    maxWidth: "520px",
    onClose: flushGrid,
    body,
    footer: el("div", { class: "modal-actions" },
      el("button", {
        type: "button", class: "btn btn-ghost",
        onclick: () => {
          FIELD_DEFS.forEach((f) => state.fields.set(f.key, false));
          body.querySelectorAll(".chip").forEach((c) => {
            c.className = "chip";
            c.setAttribute("aria-pressed", "false");
          });
          paintToolbarCounts();
          markGridDirty();
        },
      }, "全部關閉"),
      el("button", { type: "button", class: "btn btn-primary", onclick: () => closeModal() }, "完成"),
    ),
  });
}

/* ============================================================
   篩選（對話框）
   ============================================================ */
/** 條件都是即時生效的, 所以這裡只要重畫清單與計數。 */
function openFilterModal() {
  const rows = el("div", { class: "filter-rows" });
  const summary = el("div", { class: "filter-summary" });

  const refresh = () => {
    paintToolbarCounts();
    const shown = applyFilters(PMLibrary.photos, state.filters).length;
    summary.textContent = `${shown} / ${PMLibrary.photos.length} 張`;
    markGridDirty();
  };

  const buildRow = (filter) => {
    const row = el("div", { class: "filter-row" });

    const fieldSelect = el("select", { class: "tool-input" },
      el("option", { value: "" }, "選擇欄位"),
      ...FILTER_FIELDS.map((f) => el("option", { value: f.key }, f.label)));
    fieldSelect.value = filter.field || "";

    const valueSelect = el("select", { class: "tool-input" });
    const fillValues = () => {
      const options = filter.field ? optionsFor(filter.field, PMLibrary.photos) : [];
      valueSelect.replaceChildren(
        el("option", { value: "" }, options.length ? "選擇值" : "沒有可選的值"),
        ...options.map((o) => el("option", { value: o.value }, `${o.value}（${o.count}）`)),
      );
      valueSelect.value = filter.value || "";
      valueSelect.disabled = !options.length;
    };
    fillValues();

    fieldSelect.addEventListener("change", () => {
      filter.field = fieldSelect.value;
      filter.value = "";
      fillValues();
      refresh();
    });
    valueSelect.addEventListener("change", () => {
      filter.value = valueSelect.value;
      refresh();
    });

    const mode = el("div", { class: "tool-segmented filter-mode", role: "tablist" });
    const modeButtons = [["include", "包含"], ["exclude", "不包含"]].map(([value, label]) => {
      const btn = el("button", {
        type: "button", class: "tool-seg", role: "tab",
        onclick: () => {
          filter.mode = value;
          modeButtons.forEach((b) => {
            const on = b.dataset.mode === value;
            b.classList.toggle("is-active", on);
            b.setAttribute("aria-selected", String(on));
          });
          refresh();
        },
      }, label);
      btn.dataset.mode = value;
      const on = (filter.mode || "include") === value;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
      mode.appendChild(btn);
      return btn;
    });

    const remove = el("button", {
      type: "button", class: "filter-remove", title: "移除這個條件", "aria-label": "移除這個條件",
      onclick: () => {
        state.filters = state.filters.filter((f) => f !== filter);
        row.remove();
        refresh();
      },
    }, el("span", { class: "svg-icon icon-x", style: "width:14px;height:14px" }));

    row.append(fieldSelect, valueSelect, mode, remove);
    return row;
  };

  const paintRows = () => {
    rows.replaceChildren(...state.filters.map(buildRow));
  };
  paintRows();

  const addBtn = el("button", {
    type: "button", class: "btn btn-ghost filter-add",
    onclick: () => {
      const filter = { field: "", value: "", mode: "include" };
      state.filters.push(filter);
      rows.appendChild(buildRow(filter));
      refresh();
    },
  }, el("span", { class: "btn-ico", html: icon("plus", { size: "14px" }) }), "新增條件");

  refresh();

  openModal({
    title: "篩選照片",
    className: "modal-fixed",
    maxWidth: "620px",
    onClose: () => { flushGrid(); renderSourceInfo(); },
    body: el("div", { class: "filter-body" }, rows, addBtn),
    footer: el("div", { class: "modal-actions" },
      summary,
      el("button", {
        type: "button", class: "btn btn-ghost",
        onclick: () => { state.filters = []; paintRows(); refresh(); },
      }, "清除全部"),
      el("button", { type: "button", class: "btn btn-primary", onclick: () => closeModal() }, "完成"),
    ),
  });

  // 值的清單是從已讀到的 EXIF 長出來的, 所以還沒分析完就先補掃一遍。
  ensureAnalysed(() => {
    rows.querySelectorAll("select").forEach(() => {});
    paintRows();
    refresh();
  });
}

/** 還沒解析完 EXIF 的話, 背景掃一次再把選項補齊。 */
let scanTask = null;
function ensureAnalysed(done) {
  const s = PMLibrary.stats();
  if (!s.total || s.analysed >= s.total || scanTask) { done?.(); return; }
  scanTask = PMLibrary.scanAllInfo((a, b) => { showProgress(a, b, "分析 EXIF"); renderSourceInfo(); });
  scanTask.promise.then(() => {
    scanTask = null;
    hideProgress();
    renderSourceInfo();
    done?.();
  });
}

/* ============================================================
   格線
   ============================================================ */
function visiblePhotos() {
  return applyFilters(PMLibrary.photos, state.filters);
}

function paintToolbarCounts() {
  const fields = $("fieldCount");
  if (fields) {
    const on = FIELD_DEFS.filter((f) => state.fields.get(f.key)).length;
    fields.textContent = `${on} / ${FIELD_DEFS.length}`;
  }
  const filters = $("filterCount");
  if (filters) {
    const n = activeCount(state.filters);
    filters.textContent = n ? String(n) : "";
    filters.hidden = !n;
  }
}

function renderGrid() {
  const grid = $("grid");
  if (!grid) return;
  gridDirty = false;
  const empty = $("emptyState");
  const photos = visiblePhotos();
  const total = PMLibrary.photos.length;
  grid.innerHTML = "";

  if (photos.length === 0) {
    empty.style.display = "block";
    empty.querySelector("p").textContent = total ? "沒有符合條件的照片" : "尚未載入照片";
    $("photoCount").textContent = total ? `0 / ${total} 張` : "—";
    renderPagination($("photosPagination"), 0, 0, () => {});
    return;
  }
  empty.style.display = "none";
  $("photoCount").textContent = photos.length === total
    ? `${total} 張`
    : `${photos.length} / ${total} 張`;

  const totalPages = Math.max(1, Math.ceil(photos.length / state.pageSize));
  state.photosPage = Math.min(Math.max(state.photosPage, 0), totalPages - 1);
  const start = state.photosPage * state.pageSize;

  photos.slice(start, start + state.pageSize).forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";
    const img = document.createElement("img");
    img.alt = p.name;
    thumbWrap.appendChild(img);

    // 縮圖上的快捷只有一顆, 而且只做一件事: 挑編輯工具。
    // 以後工具再多也只是清單多一列, 不會把縮圖蓋滿。
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "card-open";
    openBtn.title = "用編輯工具開啟";
    openBtn.setAttribute("aria-label", `用編輯工具開啟 ${p.name}`);
    openBtn.innerHTML = icon("tool", { size: "16px" });
    openBtn.addEventListener("click", (e) => { e.stopPropagation(); openToolMenu(p); });
    thumbWrap.appendChild(openBtn);

    // 點照片本身就是「我想看清楚這張是什麼」—— 直接開完整資訊。
    thumbWrap.addEventListener("click", () => openInspector(p));

    if (p.catId) {
      const cat = PMCategories.byId(p.catId);
      if (cat) {
        const dot = document.createElement("span");
        dot.className = "card-cat-dot";
        dot.style.background = cat.color;
        dot.title = cat.name;
        dot.textContent = cat.key;
        thumbWrap.appendChild(dot);
      }
    }
    card.appendChild(thumbWrap);

    const body = document.createElement("div");
    body.className = "card-body";
    const fname = document.createElement("div");
    fname.className = "card-fname";
    fname.textContent = p.relPath;
    fname.title = p.relPath;
    body.appendChild(fname);

    const list = document.createElement("div");
    list.className = "exif-list";
    body.appendChild(list);
    card.appendChild(body);
    grid.appendChild(card);

    fillExifList(p, list);
    attachThumb(img, p, () => fillExifList(p, list));
  });

  renderPagination($("photosPagination"), state.photosPage, totalPages, (newPage) => {
    state.photosPage = newPage;
    renderGrid();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

export function mountPage() {
  const colSlider = $("colSlider");
  const grid = $("grid");
  colSlider.value = String(state.columns);
  paintRange(colSlider);
  $("colCount").textContent = String(state.columns);
  grid.style.gridTemplateColumns = `repeat(${state.columns},1fr)`;
  colSlider.addEventListener("input", (e) => {
    state.columns = parseInt(e.target.value, 10) || 4;
    paintRange(colSlider);
    $("colCount").textContent = e.target.value;
    grid.style.gridTemplateColumns = `repeat(${state.columns},1fr)`;
  });

  const pageSize = $("pageSizeSelect");
  pageSize.value = String(state.pageSize);
  pageSize.addEventListener("change", (e) => {
    state.pageSize = parseInt(e.target.value, 10) || 50;
    state.photosPage = 0;
    renderGrid();
  });

  $("filterBtn").addEventListener("click", openFilterModal);
  $("fieldBtn").addEventListener("click", openFieldModal);

  paintToolbarCounts();
  renderGrid();
  return onLibraryChange(() => { paintToolbarCounts(); renderGrid(); });
}
