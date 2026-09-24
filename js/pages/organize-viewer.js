// js/pages/organize-viewer.js — 整理分類頁左邊那張大圖的檢視器。
//
// 三件事:
//   拖曳平移 + 滾輪縮放   縮到底就是「剛好放進框裡」, 不會比原本更小
//   左右對照              把右邊的縮圖拖進來就分成兩格, 連動開關打開後一起動
//   偷看下一張            按住 space（或那顆按鈕）換成下一張, 放開就回來
//
// 方向修正（PMExif.applyOrientation）寫的是 <img> 自己的 transform, 所以平移與
// 縮放不能也寫在同一個元素上 —— 中間隔一層 .vw-stage 專門吃平移縮放, 兩者才不會打架。

import { el, icon } from "../utils/utils.js";

const MIN_ZOOM = 1;      // 1 = 剛好放進框裡。題目要求縮到最小就停在這裡。
const MAX_ZOOM = 8;
const WHEEL_SPEED = 0.0016;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* ============================================================
   單一格: 一張照片 + 它自己的平移縮放
   ============================================================ */
function createPane(photo, { onTransform, onRemove, showClose }) {
  const img = el("img", { alt: photo.name, draggable: "false" });
  const stage = el("div", { class: "vw-stage" }, img);
  const name = el("div", { class: "vw-name" }, photo.name);
  const pane = el("div", { class: "vw-pane" }, stage, name);

  if (showClose) {
    pane.appendChild(el("button", {
      type: "button", class: "vw-pane-x", title: "結束對照", "aria-label": "結束對照",
      onclick: (e) => { e.stopPropagation(); onRemove?.(); },
      html: icon("x", { size: "13px" }),
    }));
  }

  /** 目前的平移與縮放。z 是相對於「剛好放進框裡」的倍率。 */
  const view = { x: 0, y: 0, z: 1 };
  /** 沒有縮放時照片實際佔的像素大小, 用來算可以拖多遠。量一次就好, 換照片或改框才重量。 */
  let base = null;

  function measure() {
    const prev = stage.style.transform;
    stage.style.transform = "none";
    const r = img.getBoundingClientRect();
    stage.style.transform = prev;
    base = { w: r.width, h: r.height };
  }

  /**
   * 拖出框外沒有意義, 所以把平移夾在「照片還蓋得住框」的範圍裡。
   * 沒放大的時候根本不能平移, 這時就不要去量 —— 量一次是一次強制重排,
   * 而換一張照片就會經過這裡, 一路點下去就是一路重排。
   */
  function limit() {
    if (view.z <= 1.001) { view.x = 0; view.y = 0; return; }
    if (!base) measure();
    const r = pane.getBoundingClientRect();
    const maxX = Math.max(0, (base.w * view.z - r.width) / 2);
    const maxY = Math.max(0, (base.h * view.z - r.height) / 2);
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function apply() {
    limit();
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
    pane.classList.toggle("is-zoomed", view.z > 1.001);
  }

  const api = {
    photo, pane, img, name,
    get view() { return view; },
    remeasure() { base = null; apply(); },
    reset() { view.x = 0; view.y = 0; view.z = 1; base = null; apply(); },
    set({ x, y, z }) {
      view.z = clamp(z, MIN_ZOOM, MAX_ZOOM);
      view.x = x; view.y = y;
      apply();
    },
    panBy(dx, dy) {
      if (view.z <= 1.001) return;
      view.x += dx; view.y += dy;
      apply();
    },
    /**
     * 以某一點為圓心縮放。
     * 座標原點在框的正中間, 內容點 p 在畫面上的位置是 p*z + t;
     * 要讓游標底下那一點不動, 新的位移就是 t' = c - (c - t) * z'/z。
     */
    zoomAt(factor, cx, cy) {
      const before = view.z;
      const after = clamp(before * factor, MIN_ZOOM, MAX_ZOOM);
      if (after === before) return;
      const r = pane.getBoundingClientRect();
      const ox = (cx ?? r.left + r.width / 2) - (r.left + r.width / 2);
      const oy = (cy ?? r.top + r.height / 2) - (r.top + r.height / 2);
      const k = after / before;
      view.z = after;
      view.x = ox - (ox - view.x) * k;
      view.y = oy - (oy - view.y) * k;
      apply();
    },
  };

  /* ---------------- 滾輪縮放 ---------------- */
  pane.addEventListener("wheel", (e) => {
    e.preventDefault();
    api.zoomAt(Math.exp(-e.deltaY * WHEEL_SPEED), e.clientX, e.clientY);
    onTransform?.(api);
  }, { passive: false });

  /* ---------------- 拖曳平移 ---------------- */
  let drag = null;
  pane.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || view.z <= 1.001) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    // 指標已經不在了（放開得比事件還快）就算了, 沒抓到照樣能拖。
    try { pane.setPointerCapture(e.pointerId); } catch { /* 沒這個指標 */ }
    pane.classList.add("is-panning");
  });
  pane.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    api.panBy(dx, dy);
    onTransform?.(api);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    pane.classList.remove("is-panning");
  };
  pane.addEventListener("pointerup", endDrag);
  pane.addEventListener("pointercancel", endDrag);
  // 連點兩下在「放到最大」與「還原」之間切換, 比滾很多圈快。
  pane.addEventListener("dblclick", (e) => {
    if (view.z > 1.001) api.reset();
    else api.zoomAt(2.5, e.clientX, e.clientY);
    onTransform?.(api);
  });

  apply();
  return api;
}

/* ============================================================
   檢視器
   ============================================================ */
/**
 * @param {{onDropPhoto:(id:string)=>void, onExitCompare:()=>void}} cfg
 */
export function createViewer({ onDropPhoto, onExitCompare } = {}) {
  let panes = [];
  let linked = true;
  let syncing = false;

  const board = el("div", { class: "vw-board" });

  const linkBtn = el("button", {
    type: "button", class: "vw-btn is-on", title: "兩張一起縮放平移",
    "aria-pressed": "true", hidden: true,
    onclick: () => { linked = !linked; paintLink(); },
  }, el("span", { class: "vw-btn-ico", html: icon("link", { size: "14px" }) }));

  const peekBtn = el("button", {
    type: "button", class: "vw-btn", title: "按住看下一張",
    html: icon("play", { size: "14px" }),
  });

  const resetBtn = el("button", {
    type: "button", class: "vw-btn", title: "回到原始大小",
    onclick: () => { panes.forEach((p) => p.reset()); },
    html: icon("reset", { size: "14px" }),
  });

  const zoomTag = el("span", { class: "vw-zoom" }, "100%");
  const bar = el("div", { class: "vw-bar" }, peekBtn, linkBtn, resetBtn, zoomTag);
  const root = el("div", { class: "vw" }, board, bar);

  function paintLink() {
    linkBtn.classList.toggle("is-on", linked);
    linkBtn.setAttribute("aria-pressed", String(linked));
  }

  function paintZoom() {
    zoomTag.textContent = Math.round((panes[0]?.view.z || 1) * 100) + "%";
  }

  /** 連動打開時, 一格動另一格就跟著動。 */
  function onTransform(source) {
    paintZoom();
    if (!linked || syncing || panes.length < 2) return;
    syncing = true;
    panes.forEach((p) => { if (p !== source) p.set({ ...source.view }); });
    syncing = false;
  }

  /* ---------------- 把右邊的縮圖拖進來就變成對照 ---------------- */
  board.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("application/x-pm-photo")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    board.classList.add("is-drop");
  });
  board.addEventListener("dragleave", (e) => {
    if (e.target === board || !board.contains(e.relatedTarget)) board.classList.remove("is-drop");
  });
  board.addEventListener("drop", (e) => {
    const id = e.dataTransfer?.getData("application/x-pm-photo");
    board.classList.remove("is-drop");
    if (!id) return;
    e.preventDefault();
    onDropPhoto?.(id);
  });

  const api = {
    node: root,
    get panes() { return panes; },

    /**
     * 重畫。第二張是 null 就是單張檢視。
     * 照片沒換的話保留原本的平移縮放 —— 標記完跳下一張時, 視角不該自己歸位…
     * 但換照片就要歸位, 不然新照片會停在上一張的角落。
     */
    render(main, compare) {
      const keep = new Map(panes.map((p) => [p.photo.id, p]));
      const wanted = [main, compare].filter(Boolean);
      const next = wanted.map((photo, i) => keep.get(photo.id) || createPane(photo, {
        onTransform,
        showClose: i === 1,
        onRemove: () => onExitCompare?.(),
      }));
      panes = next;
      board.replaceChildren(...panes.map((p) => p.pane));
      board.classList.toggle("is-compare", panes.length > 1);
      linkBtn.hidden = panes.length < 2;
      // 分成兩格之後每格都變窄了, 原本量到的大小不能再用。
      panes.forEach((p) => p.remeasure());
      paintZoom();
      return panes;
    },

    /** 照片資訊那一塊疊在照片底部, 收合時只佔一條。 */
    setInfo(node) {
      board.querySelector(".preview-info")?.remove();
      if (node) board.appendChild(node);
    },

    resize() { panes.forEach((p) => p.remeasure()); },
    peekButton: peekBtn,
    get linked() { return linked; },
  };

  paintLink();
  return api;
}
