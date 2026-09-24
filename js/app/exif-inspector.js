// js/app/exif-inspector.js — 一張照片的完整資訊。
//
// 平常卡片上只放幾個欄位, 這裡放全部: 檔案、相機、鏡頭、曝光、色彩、GPS,
// 最後再附一份沒有整理過的 Raw EXIF（連相機的私有欄位都列出來）。
//
// Raw EXIF 是開這個視窗的時候才重新讀一次檔案的 —— 一張照片幾百個欄位,
// 整批掃的時候就留著會讓幾千張的資料夾白白吃掉記憶體。

import { el } from "../utils/utils.js";
import { openModal } from "../ui/modal.js";
import { fmtBytes } from "./state.js";

/** 分頁。每一頁就是一組「標題 + 幾列」, 沒有資料的整組不畫。 */
const TABS = [
  { key: "basic", label: "Basic" },
  { key: "exposure", label: "Exposure" },
  { key: "camera", label: "Camera" },
  { key: "lens", label: "Lens" },
  { key: "color", label: "Color" },
  { key: "gps", label: "GPS" },
  { key: "raw", label: "Raw EXIF" },
];

const px = (n) => (n == null ? null : `${n}`);

/** 6000 × 4000 → 24.0 MP。 */
function megapixels(w, h) {
  if (!w || !h) return null;
  return (w * h / 1e6).toFixed(1) + " MP";
}

/** EXIF 的 "2026:09:23 17:42:18" 不是標準格式, 自己換成好讀的樣子。 */
function fmtExifDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return String(value);
  return `${m[1]}/${m[2]}/${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

function fmtCoord(value, ref) {
  if (value == null) return null;
  return `${Math.abs(value).toFixed(4)}° ${ref}`;
}

function extOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : null;
}

/* ============================================================
   把 photo.info 整理成一頁一頁的資料
   ============================================================ */
function groupsFor(photo) {
  const i = photo.info || {};
  const gps = i.gps || null;

  return {
    basic: [
      ["檔名", photo.name],
      ["路徑", photo.relPath !== photo.name ? photo.relPath : null],
      ["格式", extOf(photo.name)],
      ["尺寸", i.width && i.height ? `${i.width} × ${i.height}` : null],
      ["像素", megapixels(i.width, i.height)],
      ["檔案大小", photo.size ? fmtBytes(photo.size) : null],
      ["拍攝時間", fmtExifDate(i.dateTimeOriginal)],
      ["修改時間", photo.lastModified ? new Date(photo.lastModified).toLocaleString("zh-TW") : null],
      ["方向", px(i.orientation)],
      ["容器", i.container === "heif" ? "HEIF / HEIC" : i.container === "jpeg" ? "JPEG" : null],
    ],
    exposure: [
      ["焦段", i.focalLength],
      ["35mm 等效", i.focalLength35mm],
      ["光圈", i.fNumber],
      ["快門", i.exposureTime],
      ["ISO", px(i.iso)],
      ["曝光補償", i.exposureBias],
      ["曝光模式", i.exposureProgram],
      ["測光模式", i.meteringMode],
      ["閃光燈", i.flash],
      ["場景類型", i.sceneCaptureType],
    ],
    camera: [
      ["製造商", i.make],
      ["型號", i.model],
      ["韌體 / 軟體", i.software],
      ["相機時間", fmtExifDate(i.dateTime)],
    ],
    lens: [
      ["鏡頭", i.lensModel],
      ["焦段", i.focalLength],
      ["最大光圈", i.fNumber],
    ],
    color: [
      ["色域", i.colorSpace],
      ["白平衡", i.whiteBalance],
      ["創意風格", i.creativeStyle],
    ],
    gps: gps ? [
      ["緯度", fmtCoord(gps.latitude, gps.latitudeRef)],
      ["經度", fmtCoord(gps.longitude, gps.longitudeRef)],
      ["海拔", gps.altitude == null ? null : `${gps.altitude.toFixed(1)} m`],
    ] : [],
  };
}

/* ============================================================
   畫面
   ============================================================ */
function rowsNode(rows) {
  const kept = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!kept.length) return el("p", { class: "ins-empty" }, "—");
  return el("dl", { class: "ins-rows" },
    ...kept.flatMap(([k, v]) => [
      el("dt", {}, k),
      el("dd", {}, String(v)),
    ]));
}

function rawNode(raw) {
  if (!raw) return el("p", { class: "ins-empty" }, "讀取中…");
  const sections = [
    ["IFD0", raw.ifd0],
    ["Exif", raw.exif],
    ["GPS", raw.gps],
  ].filter(([, list]) => list && list.length);

  if (!sections.length) return el("p", { class: "ins-empty" }, "—");

  return el("div", { class: "ins-raw" },
    ...sections.flatMap(([title, list]) => [
      el("h4", { class: "ins-raw-head" }, title),
      el("table", { class: "ins-table" },
        el("tbody", {}, ...list.map((t) => el("tr", {},
          el("td", { class: "ins-tag" }, t.tag),
          el("td", { class: "ins-name" }, t.name || "—"),
          el("td", { class: "ins-val", title: t.value }, t.value),
        )))),
    ]));
}

/** 開啟「完整資訊」。 */
export function openInspector(photo) {
  let groups = groupsFor(photo);
  const body = el("div", { class: "ins-body" });
  const tabsRow = el("div", { class: "ins-tabs", role: "tablist" });

  // Raw EXIF 是開窗之後才去讀的, 先放個位子。
  let raw = photo.info && photo.info.raw ? photo.info.raw : null;
  let active = "basic";

  const paint = () => {
    body.replaceChildren(active === "raw" ? rawNode(raw) : rowsNode(groups[active] || []));
    [...tabsRow.children].forEach((btn) => {
      const on = btn.dataset.key === active;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
  };

  TABS.forEach((tab) => {
    // 這張照片沒有 GPS 就不要放一個永遠空的分頁。
    if (tab.key === "gps" && !groups.gps.length) return;
    const btn = el("button", {
      type: "button", class: "ins-tab", role: "tab",
      dataset: { key: tab.key },
      onclick: () => { active = tab.key; paint(); },
    }, tab.label);
    tabsRow.appendChild(btn);
  });

  paint();

  openModal({
    title: "照片資訊",
    className: "modal-fixed",
    maxWidth: "620px",
    body: el("div", { class: "ins" }, tabsRow, body),
    footer: el("div", { class: "modal-actions" },
      el("span", { class: "ins-foot" }, photo.name),
      el("button", {
        type: "button", class: "btn btn-ghost",
        onclick: (e) => {
          const btn = e.currentTarget;
          const text = Object.entries(groups)
            .flatMap(([, rows]) => rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}\t${v}`))
            .join("\n");
          navigator.clipboard?.writeText(text);
          btn.textContent = "已複製";
          setTimeout(() => { btn.textContent = "複製"; }, 1200);
        },
      }, "複製"),
    ),
  });

  // Raw EXIF（以及還沒掃到的那幾張的一般欄位）現在才去讀。
  if (!raw) {
    PMLibrary.getFile(photo)
      .then(async (file) => {
        const parsed = await PMExif.extractExif(file, { wantThumb: false, wantRaw: true });
        const info = parsed && parsed.info;
        raw = info ? info.raw : { ifd0: [], exif: [], gps: [] };
        // 這一頁才第一次讀到 EXIF 的話（整批還沒掃完）, 順手補進這張照片。
        if (info && !photo.info) { photo.info = info; photo.infoState = "done"; }
        else if (photo.info && raw) photo.info.raw = raw;

        // 有些檔案沒寫 PixelXDimension, 那就真的把圖解出來量一次。
        // 只有缺的時候才做 —— 解一張原圖不便宜。
        const cur = photo.info;
        if (cur && (!cur.width || !cur.height)) {
          try {
            const bitmap = await PMImage.decodeBitmap(file);
            cur.width = bitmap.width;
            cur.height = bitmap.height;
            bitmap.close?.();
          } catch { /* 解不開就不顯示尺寸 */ }
        }
        groups = groupsFor(photo);
        paint();
      })
      .catch(() => { raw = { ifd0: [], exif: [], gps: [] }; paint(); });
  }
}

/** 給工具清單用的一列。 */
export const INSPECTOR_ENTRY = {
  icon: "info",
  label: "完整資訊",
  run: openInspector,
};
