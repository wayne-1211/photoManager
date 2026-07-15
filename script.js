/* ============================================================
   1. 二進位/TIFF 基礎工具
   ============================================================ */
function readString(dv, offset, length) {
    let s = "";
    for (let i = 0; i < length; i++) {
        const c = dv.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

const IFD_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readIFDValue(dv, type, count, valueOffsetPos, tiffStart, little) {
    const size = (IFD_TYPE_SIZE[type] || 1) * count;
    let dataPos = valueOffsetPos;
    if (size > 4) {
        dataPos = tiffStart + dv.getUint32(valueOffsetPos, little);
    }
    const readOne = (i) => {
        switch (type) {
            case 1: case 6: return dv.getUint8(dataPos + i);
            case 2: return null; // handled as string separately
            case 3: return dv.getUint16(dataPos + i * 2, little);
            case 8: return dv.getInt16(dataPos + i * 2, little);
            case 4: return dv.getUint32(dataPos + i * 4, little);
            case 9: return dv.getInt32(dataPos + i * 4, little);
            case 5: {
                const num = dv.getUint32(dataPos + i * 8, little);
                const den = dv.getUint32(dataPos + i * 8 + 4, little);
                return den === 0 ? 0 : num / den;
            }
            case 10: {
                const num = dv.getInt32(dataPos + i * 8, little);
                const den = dv.getInt32(dataPos + i * 8 + 4, little);
                return den === 0 ? 0 : num / den;
            }
            default: return dv.getUint8(dataPos + i);
        }
    };
    if (type === 2) { // ASCII
        return readString(dv, dataPos, count);
    }
    if (type === 7) { // UNDEFINED - return raw bytes
        const bytes = [];
        for (let i = 0; i < count; i++) bytes.push(dv.getUint8(dataPos + i));
        return { raw: bytes, offset: dataPos };
    }
    if (count === 1) return readOne(0);
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(readOne(i));
    return arr;
}

// 讀取一個 IFD，回傳 {tags:Map(tagId->{type,count,value,valueOffsetPos}), next}
function readIFD(dv, offset, tiffStart, little) {
    const tags = new Map();
    const numEntries = dv.getUint16(offset, little);
    let pos = offset + 2;
    for (let i = 0; i < numEntries; i++) {
        const tagId = dv.getUint16(pos, little);
        const type = dv.getUint16(pos + 2, little);
        const count = dv.getUint32(pos + 4, little);
        const valueOffsetPos = pos + 8;
        let value = null;
        try { value = readIFDValue(dv, type, count, valueOffsetPos, tiffStart, little); } catch (e) { value = null; }
        tags.set(tagId, { type, count, value, valueOffsetPos });
        pos += 12;
    }
    const next = dv.getUint32(pos, little);
    return { tags, next };
}

/* ============================================================
   2. 標準 EXIF 判讀 (IFD0 + ExifIFD)
   ============================================================ */
const EXPOSURE_PROGRAM = { 0: "未定義", 1: "手動", 2: "程式自動", 3: "光圈優先", 4: "快門優先", 5: "創意程式", 6: "動作程式", 7: "人像模式", 8: "風景模式" };
const METERING_MODE = { 0: "未知", 1: "平均測光", 2: "中央重點", 3: "點測光", 4: "多點測光", 5: "權衡測光", 6: "部分測光", 255: "其他" };
const WHITE_BALANCE_STD = { 0: "自動", 1: "手動" };
const COLOR_SPACE = { 1: "sRGB", 65535: "未校正" };
const SCENE_CAPTURE = { 0: "標準", 1: "風景", 2: "人像", 3: "夜景" };

function fmtShutter(sec) {
    if (sec == null) return null;
    if (sec >= 1) return sec.toFixed(sec % 1 === 0 ? 0 : 1) + " s";
    const denom = Math.round(1 / sec);
    return "1/" + denom + " s";
}
function fmtRational(v, digits) { return v == null ? null : (Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits)); }

function parseStandardExif(dv, tiffStart, little) {
    const ifd0 = readIFD(dv, tiffStart + dv.getUint32(tiffStart + 4, little), tiffStart, little);
    const info = { make: null, model: null, software: null, dateTime: null };
    const get = (map, id) => map.tags.has(id) ? map.tags.get(id).value : null;

    info.make = get(ifd0, 0x010F);
    info.model = get(ifd0, 0x0110);
    info.software = get(ifd0, 0x0131);
    info.dateTime = get(ifd0, 0x0132);
    info.orientation = get(ifd0, 0x0112); // 1-8，用來判斷是否需要旋轉顯示

    let exifIfd = null, makerNoteEntry = null;
    if (ifd0.tags.has(0x8769)) {
        const exifOffset = tiffStart + dv.getUint32(ifd0.tags.get(0x8769).valueOffsetPos, little);
        exifIfd = readIFD(dv, exifOffset, tiffStart, little);
    }

    if (exifIfd) {
        const g = (id) => exifIfd.tags.has(id) ? exifIfd.tags.get(id).value : null;
        info.exposureTime = fmtShutter(g(0x829A));
        info.exposureTimeRaw = g(0x829A);
        info.fNumber = g(0x829D) != null ? "f/" + fmtRational(g(0x829D), 1) : null;
        info.exposureProgram = EXPOSURE_PROGRAM[g(0x8822)] ?? null;
        const iso = g(0x8827);
        info.iso = Array.isArray(iso) ? iso[0] : iso;
        info.dateTimeOriginal = g(0x9003);
        info.exposureBias = g(0x9204) != null ? (g(0x9204) >= 0 ? "+" : "") + fmtRational(g(0x9204), 2) + " EV" : null;
        info.meteringMode = METERING_MODE[g(0x9207)] ?? null;
        const flash = g(0x9209);
        info.flash = flash != null ? ((flash & 0x1) ? "已擊發" : "未擊發") + " (0x" + flash.toString(16) + ")" : null;
        info.focalLength = g(0x920A) != null ? fmtRational(g(0x920A), 1) + " mm" : null;
        info.focalLengthRaw = g(0x920A);
        info.focalLength35mm = g(0xA405) != null ? g(0xA405) + " mm" : null;
        info.colorSpace = COLOR_SPACE[g(0xA001)] ?? null;
        info.whiteBalance = WHITE_BALANCE_STD[g(0xA403)] ?? null;
        info.whiteBalanceRaw = g(0xA403);
        info.sceneCaptureType = SCENE_CAPTURE[g(0xA406)] ?? null;
        info.lensModel = g(0xA434);

        if (exifIfd.tags.has(0x927C)) {
            makerNoteEntry = exifIfd.tags.get(0x927C);
        }
    }
    return { info, makerNoteEntry, exifIfd, ifd0Next: ifd0.next };
}

/* ============================================================
   3. Sony MakerNote 解碼 — 僅解析 Creative Style
   ============================================================ */
const SONY_CREATIVE_STYLE_TAG = 0xb020;

function parseSonyCreativeStyle(dv, mnAbsOffset, tiffStart, little) {
    let header = "";
    try { header = readString(dv, mnAbsOffset, 12); } catch (e) { }
    let ifdStart = mnAbsOffset;
    if (header.indexOf("SONY") === 0) {
        ifdStart = mnAbsOffset + 12;
    }
    let ifd;
    try { ifd = readIFD(dv, ifdStart, tiffStart, little); } catch (e) { return null; }
    if (!ifd.tags.has(SONY_CREATIVE_STYLE_TAG)) return null;
    const entry = ifd.tags.get(SONY_CREATIVE_STYLE_TAG);
    if (typeof entry.value !== 'string') return null;
    const style = entry.value.trim();
    return style || null;
}

/* ============================================================
   4. 檔案解析入口 (效能優化版)
   ============================================================ */
const HEADER_READ_BYTES = 262144; // 256KB

/* ============================================================
   4.5 EXIF Orientation → CSS transform 修復邏輯
   ------------------------------------------------------------
   使用 ResizeObserver 動態取得外部容器(preview-image-box)的絕對大小。
   若圖片需要旋轉 90 或 270 度，就將圖片的 width 限制為容器的 height，
   將 height 限制為容器的 width。這樣旋轉後就 100% 不會突破邊界。
   針對縮圖區（不需要完美邊界），則加入了 scale(1.35) 避免旋轉後產生黑邊。
   ============================================================ */
const ORIENTATION_TRANSFORM = {
    1: '', 2: 'scaleX(-1)', 3: 'rotate(180deg)', 4: 'scaleX(-1) rotate(180deg)',
    5: 'scaleX(-1) rotate(270deg)', 6: 'rotate(90deg)', 7: 'scaleX(-1) rotate(90deg)', 8: 'rotate(270deg)'
};
const ORIENTATION_SWAPS_AXES = new Set([5, 6, 7, 8]);

function applyOrientation(img, orientation, isPreview) {
    const o = orientation || 1;
    const needsAxisSwap = ORIENTATION_SWAPS_AXES.has(o);

    if (isPreview) {
        img.style.transform = ORIENTATION_TRANSFORM[o] || '';
        if (needsAxisSwap) {
            // 核心修復：取消預設的 max-width 限制，交由 Observer 強制管理絕對長寬
            img.style.maxWidth = 'none';
            img.style.maxHeight = 'none';

            const ro = new ResizeObserver(entries => {
                for (let entry of entries) {
                    // 完美邊界反轉：將圖片物理寬度綁定容器高度；圖片物理高度綁定容器寬度
                    img.style.width = entry.contentRect.height + 'px';
                    img.style.height = entry.contentRect.width + 'px';
                }
            });
            const parent = img.parentElement;
            if (parent) ro.observe(parent);
            img._ro = ro; // 暫存起來，切換下一張時負責清除
        } else {
            img.style.width = 'auto';
            img.style.height = 'auto';
            img.style.maxWidth = '100%';
            img.style.maxHeight = '64vh';
        }
    } else {
        // 針對右側 / 總覽的縮圖，因為是在方形內，直接旋轉並微微放大填滿黑邊
        img.style.transform = (ORIENTATION_TRANSFORM[o] || '') + (needsAxisSwap ? ' scale(1.35)' : '');
    }
}

async function extractExif(file) {
    const headerBuf = await file.slice(0, HEADER_READ_BYTES).arrayBuffer();
    const dv = new DataView(headerBuf);
    if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return { info: null, thumbUrl: null };

    let offset = 2;
    let app1Offset = null;
    while (offset < dv.byteLength - 4) {
        const marker = dv.getUint16(offset);
        if ((marker & 0xFF00) !== 0xFF00) break;
        const size = dv.getUint16(offset + 2);
        if (marker === 0xFFE1) {
            const tag = readString(dv, offset + 4, 6);
            if (tag.indexOf("Exif") === 0) { app1Offset = offset + 4; break; }
        }
        if (marker === 0xFFDA) break;
        offset += 2 + size;
    }
    if (app1Offset === null) return { info: null, thumbUrl: null };

    const tiffStart = app1Offset + 6;
    const byteOrder = dv.getUint16(tiffStart);
    const little = byteOrder === 0x4949;

    const { info, makerNoteEntry, ifd0Next } = parseStandardExif(dv, tiffStart, little);

    if (makerNoteEntry && info.make && info.make.toUpperCase().indexOf("SONY") !== -1) {
        const size = makerNoteEntry.count;
        let mnAbsOffset;
        if (size > 4) {
            mnAbsOffset = tiffStart + dv.getUint32(makerNoteEntry.valueOffsetPos, little);
        } else {
            mnAbsOffset = makerNoteEntry.valueOffsetPos;
        }
        try { info.creativeStyle = parseSonyCreativeStyle(dv, mnAbsOffset, tiffStart, little); } catch (e) { info.creativeStyle = null; }
    }

    // ---- 嘗試取得 IFD1 中內建的縮圖 ----
    let thumbUrl = null;
    if (ifd0Next) {
        try {
            const ifd1 = readIFD(dv, tiffStart + ifd0Next, tiffStart, little);
            const offEntry = ifd1.tags.get(0x0201);
            const lenEntry = ifd1.tags.get(0x0202);
            if (offEntry && lenEntry && typeof offEntry.value === 'number' && typeof lenEntry.value === 'number' && lenEntry.value > 0) {
                const thumbAbsOffset = tiffStart + offEntry.value;
                const thumbLength = lenEntry.value;
                const thumbBuf = await file.slice(thumbAbsOffset, thumbAbsOffset + thumbLength).arrayBuffer();
                if (thumbBuf.byteLength >= 2) {
                    const tdv = new DataView(thumbBuf);
                    if (tdv.getUint16(0) === 0xFFD8) {
                        const blob = new Blob([thumbBuf], { type: 'image/jpeg' });
                        thumbUrl = await blobToDataURL(blob);
                    }
                }
            }
        } catch (e) { thumbUrl = null; }
    }

    return { info, thumbUrl };
}

/* ============================================================
   5. UI 狀態與渲染
   ============================================================ */
const FIELD_DEFS = [
    { key: 'model', label: '相機型號', on: true },
    { key: 'lensModel', label: '鏡頭', on: true },
    { key: 'focalLength', label: '焦段', on: true },
    { key: 'fNumber', label: '光圈', on: true },
    { key: 'exposureTime', label: '快門', on: true },
    { key: 'iso', label: 'ISO', on: true },
    { key: 'exposureBias', label: '曝光補償', on: false },
    { key: 'exposureProgram', label: '曝光模式', on: false },
    { key: 'meteringMode', label: '測光模式', on: false },
    { key: 'whiteBalance', label: '白平衡', on: false },
    { key: 'flash', label: '閃光燈', on: false },
    { key: 'colorSpace', label: '色域', on: false },
    { key: 'focalLength35mm', label: '35mm等效焦段', on: false },
    { key: 'sceneCaptureType', label: '場景類型', on: false },
    { key: 'dateTimeOriginal', label: '拍攝時間', on: false },
    { key: 'make', label: '製造商', on: false },
    { key: 'creativeStyle', label: '創意風格 (Sony)', on: true },
];
const state = { photos: [], fields: new Map(FIELD_DEFS.map(f => [f.key, f.on])), pageSize: 50, photosPage: 0 };

function renderPagination(containerId, page, totalPages, onChange) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    if (totalPages <= 1) return;
    const prevBtn = document.createElement('button');
    prevBtn.className = 'page-btn';
    prevBtn.textContent = '← 上一頁';
    prevBtn.disabled = page <= 0;
    prevBtn.onclick = () => onChange(page - 1);

    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `第 ${page + 1} / ${totalPages} 頁`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'page-btn';
    nextBtn.textContent = '下一頁 →';
    nextBtn.disabled = page >= totalPages - 1;
    nextBtn.onclick = () => onChange(page + 1);

    el.appendChild(prevBtn);
    el.appendChild(info);
    el.appendChild(nextBtn);
}

function initChips() {
    const row = document.getElementById('chipRow');
    row.innerHTML = '';
    FIELD_DEFS.forEach(f => {
        const chip = document.createElement('button');
        chip.className = 'chip' + (state.fields.get(f.key) ? ' on' : '');
        chip.textContent = f.label;
        chip.onclick = () => {
            state.fields.set(f.key, !state.fields.get(f.key));
            chip.classList.toggle('on');
            renderGrid();
        };
        row.appendChild(chip);
    });
}

function renderGrid() {
    const grid = document.getElementById('grid');
    const empty = document.getElementById('emptyState');
    grid.innerHTML = '';
    if (state.photos.length === 0) {
        empty.style.display = 'block';
        document.getElementById('photoCount').textContent = '尚未上傳照片';
        renderPagination('photosPagination', 0, 0, () => { });
        return;
    }
    empty.style.display = 'none';
    document.getElementById('photoCount').textContent = state.photos.length + ' 張照片';

    const totalPages = Math.max(1, Math.ceil(state.photos.length / state.pageSize));
    if (state.photosPage >= totalPages) state.photosPage = totalPages - 1;
    if (state.photosPage < 0) state.photosPage = 0;
    const start = state.photosPage * state.pageSize;
    const end = Math.min(start + state.pageSize, state.photos.length);
    const pagePhotos = state.photos.slice(start, end);

    pagePhotos.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'thumb-wrap';
        const img = document.createElement('img');
        if (p.url) img.src = p.url;
        img.loading = 'lazy';
        applyOrientation(img, p.info ? p.info.orientation : null, false);
        thumbWrap.appendChild(img);
        card.appendChild(thumbWrap);

        const body = document.createElement('div');
        body.className = 'card-body';
        const fname = document.createElement('div');
        fname.className = 'card-fname';
        fname.textContent = p.name;
        fname.title = p.name;
        body.appendChild(fname);

        const list = document.createElement('div');
        list.className = 'exif-list';
        let any = false;
        if (p.info) {
            FIELD_DEFS.forEach(f => {
                if (!state.fields.get(f.key)) return;
                const val = p.info[f.key];
                if (val === null || val === undefined) return;
                any = true;
                const row = document.createElement('div');
                row.className = 'row';
                row.innerHTML = `<span class="k">${f.label}</span><span class="v">${val}</span>`;
                list.appendChild(row);
            });
        }
        if (!any) {
            const e = document.createElement('div');
            e.className = 'exif-empty';
            e.textContent = p.info ? '無選取欄位的資料' : '此照片無法解出 EXIF 資訊';
            list.appendChild(e);
        }
        body.appendChild(list);

        card.appendChild(body);
        grid.appendChild(card);
    });

    renderPagination('photosPagination', state.photosPage, totalPages, (newPage) => {
        state.photosPage = newPage;
        renderGrid();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

/* ============================================================
   6. 統計頁
   ============================================================ */
function bucketCount(values, formatter) {
    const map = new Map();
    values.forEach(v => {
        if (v === null || v === undefined || Number.isNaN(v)) return;
        const key = formatter(v);
        map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function renderStatCard(title, sub, entries, maxBars = 10) {
    const wrap = document.createElement('div');
    wrap.className = 'stat-card';
    const h = document.createElement('div');
    h.className = 'stat-title';
    h.innerHTML = `${title} <span class="sub">${sub}</span>`;
    wrap.appendChild(h);
    if (entries.length === 0) {
        const e = document.createElement('div');
        e.className = 'stat-empty';
        e.textContent = '尚無資料';
        wrap.appendChild(e);
        return wrap;
    }
    const max = Math.max(...entries.map(e => e[1]));
    entries.slice(0, maxBars).forEach(([label, count]) => {
        const row = document.createElement('div');
        row.className = 'bar-row';
        row.innerHTML = `
      <div class="bar-label">${label}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count / max * 100).toFixed(1)}%"></div></div>
      <div class="bar-count">${count}</div>
    `;
        wrap.appendChild(row);
    });
    return wrap;
}

function renderStats() {
    const container = document.getElementById('statsGrid');
    container.innerHTML = '';
    const infos = state.photos.map(p => p.info).filter(Boolean);

    const focal = bucketCount(infos.map(i => i.focalLengthRaw), v => {
        const lower = Math.floor(v / 10) * 10;
        return lower + '-' + (lower + 9) + 'mm';
    });
    focal.sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
    const aperture = bucketCount(infos.map(i => i.fNumber ? parseFloat(i.fNumber.replace('f/', '')) : null), v => "f/" + v);
    const shutter = bucketCount(infos.map(i => i.exposureTimeRaw), v => fmtShutter(v));
    const iso = bucketCount(infos.map(i => i.iso), v => "ISO " + v);
    const wb = bucketCount(infos.map(i => i.whiteBalanceRaw), v => (WHITE_BALANCE_STD[v] ?? ("代碼 " + v)));
    const cameras = bucketCount(infos.map(i => i.model), v => v);

    container.appendChild(renderStatCard('焦段使用', 'focal length, 10mm 一個級距', focal, 20));
    container.appendChild(renderStatCard('光圈使用', 'aperture (f-number)', aperture));
    container.appendChild(renderStatCard('快門速度', 'shutter speed', shutter));
    container.appendChild(renderStatCard('ISO 感光度', 'ISO', iso));
    container.appendChild(renderStatCard('白平衡（色溫模式）', '標準 EXIF WhiteBalance', wb));
    container.appendChild(renderStatCard('相機型號', 'camera model', cameras));
}

/* ============================================================
   7. 照片管理 — 快捷鍵分類 + ZIP 匯出
   ============================================================ */
const categories = [
    { key: '1', name: '機器人特寫', exportable: true },
    { key: '2', name: '賽場動態', exportable: true },
    { key: '3', name: '團隊合照', exportable: true },
    { key: '4', name: '廢片/不匯出', exportable: false },
];
let selectedIndex = 0;

function getCategory(key) { return categories.find(c => c.key === key); }

function renderCategoryEditor() {
    const wrap = document.getElementById('catEditor');
    wrap.innerHTML = '';
    categories.forEach((cat, i) => {
        const slot = document.createElement('div');
        slot.className = 'cat-slot';

        const keyEl = document.createElement('span');
        keyEl.className = 'cat-key';
        keyEl.style.background = `var(--cat-${i + 1 <= 4 ? i + 1 : 4})`;
        keyEl.textContent = cat.key;
        slot.appendChild(keyEl);

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = cat.name;
        nameInput.addEventListener('input', () => {
            cat.name = nameInput.value;
            renderManageGrid();
        });
        slot.appendChild(nameInput);

        const exportLabel = document.createElement('label');
        exportLabel.className = 'export-toggle';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = cat.exportable;
        cb.addEventListener('change', () => { cat.exportable = cb.checked; });
        exportLabel.appendChild(cb);
        exportLabel.appendChild(document.createTextNode('匯出'));
        slot.appendChild(exportLabel);

        wrap.appendChild(slot);
    });
}

function catColorVar(key) {
    const idx = categories.findIndex(c => c.key === key);
    const n = idx >= 0 ? (idx + 1 <= 4 ? idx + 1 : 4) : 4;
    return `var(--cat-${n})`;
}

async function getFullUrl(photo) {
    if (!photo.fullUrlCache && photo.file) {
        try {
            photo.fullUrlCache = await blobToDataURL(photo.file);
        } catch (err) {
            console.error('讀取原始影像失敗:', photo.name, err);
            photo.fullUrlCache = null;
        }
    }
    return photo.fullUrlCache;
}

const PRELOAD_AHEAD = 5;  // N+1 ~ N+5
const PRELOAD_BEHIND = 3; // N-1 ~ N-3
const preloadedImages = new Map();

function preloadNearbyPhotos(centerIndex) {
    const wanted = new Set();
    for (let d = 1; d <= PRELOAD_AHEAD; d++) wanted.add(centerIndex + d);
    for (let d = 1; d <= PRELOAD_BEHIND; d++) wanted.add(centerIndex - d);

    wanted.forEach(idx => {
        if (preloadedImages.has(idx)) return;
        const photo = state.photos[idx];
        if (!photo || !photo.file) return;
        preloadedImages.set(idx, true);
        getFullUrl(photo).then(url => {
            if (!url) return;
            const img = new Image();
            img.src = url;
            preloadedImages.set(idx, img);
        });
    });

    for (const idx of Array.from(preloadedImages.keys())) {
        if (idx !== centerIndex && !wanted.has(idx)) {
            preloadedImages.delete(idx);
        }
    }
}

async function renderPreviewPanel() {
    const wrap = document.getElementById('previewWrap');

    // 清除上一個 ResizeObserver，避免記憶體洩漏
    const oldImg = wrap.querySelector('.preview-image-box img');
    if (oldImg && oldImg._ro) oldImg._ro.disconnect();

    wrap.innerHTML = '';
    const p = state.photos[selectedIndex];
    if (!p) {
        wrap.innerHTML = '<p class="stat-empty">尚無選取的照片</p>';
        return;
    }

    const preview = document.createElement('div');
    preview.className = 'preview-image-box';
    const img = document.createElement('img');
    if (p.url) img.src = p.url;

    // 必須先加入 DOM，讓圖片有實際的容器大小可以測量
    preview.appendChild(img);
    wrap.appendChild(preview);

    // 測量與套用方位
    applyOrientation(img, p.info ? p.info.orientation : null, true);

    const fname = document.createElement('div');
    fname.className = 'preview-fname';
    fname.textContent = p.name;
    wrap.appendChild(fname);

    if (p.category) {
        const cat = getCategory(p.category);
        if (cat) {
            const badge = document.createElement('div');
            badge.className = 'preview-cat-badge';
            badge.style.background = catColorVar(p.category);
            badge.textContent = cat.name;
            wrap.appendChild(badge);
        }
    }

    const exifWrap = document.createElement('div');
    exifWrap.className = 'preview-exif';
    const sideFields = [
        ['dateTimeOriginal', '拍攝時間'], ['model', '相機型號'], ['lensModel', '鏡頭'],
        ['focalLength', '焦段'], ['fNumber', '光圈'], ['exposureTime', '快門'], ['iso', 'ISO'],
        ['creativeStyle', '創意風格'],
    ];
    let any = false;
    if (p.info) {
        sideFields.forEach(([k, label]) => {
            const val = p.info[k];
            if (val === null || val === undefined) return;
            any = true;
            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML = `<span class="k">${label}</span><span class="v">${val}</span>`;
            exifWrap.appendChild(row);
        });
    }
    if (!any) {
        exifWrap.innerHTML = '<p class="exif-empty">此照片無法解出 EXIF 資訊</p>';
    }
    wrap.appendChild(exifWrap);

    const hint = document.createElement('div');
    hint.className = 'kbd-hint';
    hint.innerHTML = `方向鍵 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 切換照片<br>
    數字鍵 ${categories.map(c => '<kbd>' + c.key + '</kbd>').join('')} 標記分類並跳到下一張`;
    wrap.appendChild(hint);

    getFullUrl(p).then(fullUrl => {
        if (!fullUrl) return;
        if (state.photos[selectedIndex] !== p) return;
        img.src = fullUrl;
    });

    preloadNearbyPhotos(selectedIndex);
}

function renderManageGrid() {
    const grid = document.getElementById('manageGrid');
    const empty = document.getElementById('manageEmpty');
    grid.innerHTML = '';
    document.getElementById('mgmtPhotoCount').textContent = state.photos.length
        ? state.photos.length + ' 張照片（已分類 ' + state.photos.filter(p => p.category).length + ' 張）'
        : '尚未上傳照片';

    if (state.photos.length === 0) {
        empty.style.display = 'block';
        renderPagination('managePagination', 0, 0, () => { });
        renderPreviewPanel();
        return;
    }
    empty.style.display = 'none';
    if (selectedIndex >= state.photos.length) selectedIndex = state.photos.length - 1;
    if (selectedIndex < 0) selectedIndex = 0;

    const totalPages = Math.max(1, Math.ceil(state.photos.length / state.pageSize));
    const page = Math.floor(selectedIndex / state.pageSize);
    const start = page * state.pageSize;
    const end = Math.min(start + state.pageSize, state.photos.length);

    state.photos.slice(start, end).forEach((p, localIdx) => {
        const i = start + localIdx;
        const card = document.createElement('div');
        card.className = 'thumb-card' + (i === selectedIndex ? ' selected' : '');
        card.dataset.index = i;

        const img = document.createElement('img');
        if (p.url) img.src = p.url;
        img.alt = p.name;
        img.loading = 'lazy';
        applyOrientation(img, p.info ? p.info.orientation : null, false);
        card.appendChild(img);

        const fnameTag = document.createElement('div');
        fnameTag.className = 'fname-tag';
        fnameTag.textContent = p.name;
        card.appendChild(fnameTag);

        if (p.category) {
            const cat = getCategory(p.category);
            if (cat) {
                const badge = document.createElement('div');
                badge.className = 'cat-badge';
                badge.style.background = catColorVar(p.category);
                badge.textContent = cat.name;
                card.appendChild(badge);
            }
        }

        card.addEventListener('click', () => {
            selectedIndex = i;
            renderManageGrid();
        });

        grid.appendChild(card);
    });

    renderPagination('managePagination', page, totalPages, (newPage) => {
        selectedIndex = Math.min(Math.max(newPage * state.pageSize, 0), state.photos.length - 1);
        renderManageGrid();
    });

    renderPreviewPanel();

    const selectedEl = grid.querySelector('.thumb-card.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function isManageViewActive() {
    return document.getElementById('manageView').classList.contains('active');
}

document.addEventListener('keydown', (e) => {
    if (!isManageViewActive()) return;
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (state.photos.length === 0) return;

    const cols = parseInt(document.getElementById('mgmtColSlider').value, 10);

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + 1, state.photos.length - 1);
        renderManageGrid();
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - 1, 0);
        renderManageGrid();
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIndex = Math.min(selectedIndex + cols, state.photos.length - 1);
        renderManageGrid();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIndex = Math.max(selectedIndex - cols, 0);
        renderManageGrid();
    } else {
        const cat = getCategory(e.key);
        if (cat) {
            e.preventDefault();
            state.photos[selectedIndex].category = cat.key;
            selectedIndex = Math.min(selectedIndex + 1, state.photos.length - 1);
            renderManageGrid();
        }
    }
});

document.getElementById('mgmtColSlider').addEventListener('input', (e) => {
    const n = e.target.value;
    document.getElementById('mgmtColCount').textContent = n;
    document.getElementById('manageGrid').style.gridTemplateColumns = `repeat(${n}, 1fr)`;
});

const SPLIT_THRESHOLD_BYTES = 500 * 1024 * 1024;
const SPLIT_CHUNK_SIZE = 500 * 1024 * 1024;
const EXPORT_FILENAME = 'Photo_Manager_Export.zip';

document.getElementById('exportBtn').addEventListener('click', async () => {
    const btn = document.getElementById('exportBtn');
    const exportableCats = categories.filter(c => c.exportable);

    const usedNames = {};
    const zip = new JSZip();
    let itemCount = 0;
    exportableCats.forEach(cat => {
        const photosInCat = state.photos.filter(p => p.category === cat.key);
        photosInCat.forEach(p => {
            let name = p.name;
            const nameKey = cat.key + '/' + name;
            if (usedNames[nameKey]) {
                usedNames[nameKey]++;
                const dot = name.lastIndexOf('.');
                name = dot > -1 ? name.slice(0, dot) + '_' + usedNames[nameKey] + name.slice(dot) : name + '_' + usedNames[nameKey];
            } else {
                usedNames[nameKey] = 1;
            }
            zip.folder(cat.name || cat.key).file(name, p.file);
            itemCount++;
        });
    });

    if (itemCount === 0) {
        alert('目前沒有已標記且設定為「匯出」的照片可以打包。');
        return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;

    try {
        btn.textContent = '打包中…';
        const blob = await zip.generateAsync({ type: 'blob' }, (meta) => {
            btn.textContent = `打包中… (${Math.round(meta.percent)}%)`;
        });

        if (blob.size <= SPLIT_THRESHOLD_BYTES) {
            saveAs(blob, EXPORT_FILENAME);
        } else {
            const totalParts = Math.ceil(blob.size / SPLIT_CHUNK_SIZE);
            for (let i = 0; i < totalParts; i++) {
                const start = i * SPLIT_CHUNK_SIZE;
                const end = Math.min(start + SPLIT_CHUNK_SIZE, blob.size);
                const chunk = blob.slice(start, end);
                const partNum = String(i + 1).padStart(3, '0');
                btn.textContent = `下載分割檔 ${i + 1}/${totalParts}…`;
                saveAs(chunk, `${EXPORT_FILENAME}.${partNum}`);
                if (i < totalParts - 1) {
                    await new Promise(resolve => setTimeout(resolve, 400));
                }
            }
            alert(`壓縮檔超過 ${Math.round(SPLIT_THRESHOLD_BYTES / 1024 / 1024)}MB，已切割成 ${totalParts} 個檔案下載`
                + `（${EXPORT_FILENAME}.001 ~ ${EXPORT_FILENAME}.${String(totalParts).padStart(3, '0')}）。\n`
                + `請將所有分割檔放在同一個資料夾，用 7-Zip 等工具的「合併檔案」功能接回單一 .zip 後再解壓縮。`
                + `若瀏覽器詢問是否允許多個下載，請選擇允許。`);
        }
    } catch (err) {
        console.error('打包失敗:', err);
        alert('打包過程發生錯誤，請查看主控台訊息。');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
});

/* ---- 拖曳上傳 (照片管理分頁) ---- */
const dropZone = document.getElementById('dropZone');
['dragenter', 'dragover'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add('drag-over');
    });
});
['dragleave', 'drop'].forEach(evt => {
    dropZone.addEventListener(evt, (e) => {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });
});
dropZone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => /image\/(jpeg|jpg|tiff)/.test(f.type));
    if (files.length) addFiles(files);
});
document.getElementById('manageFileInput').addEventListener('change', (e) => {
    addFiles(Array.from(e.target.files));
    e.target.value = '';
});

/* ============================================================
   8. 事件綁定
   ============================================================ */
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.view).classList.add('active');
        if (btn.dataset.view === 'statsView') renderStats();
        if (btn.dataset.view === 'manageView') renderManageGrid();
    });
});

document.getElementById('colSlider').addEventListener('input', (e) => {
    const n = e.target.value;
    document.getElementById('colCount').textContent = n;
    document.getElementById('grid').style.gridTemplateColumns = `repeat(${n}, 1fr)`;
});

document.getElementById('clearBtn').addEventListener('click', () => {
    if (state.photos.length === 0) return;
    const ok = confirm('確定要清除目前上傳的 ' + state.photos.length + ' 張照片嗎？此動作無法復原。');
    if (!ok) return;
    state.photos = [];
    selectedIndex = 0;
    state.photosPage = 0;
    preloadedImages.clear();
    renderGrid();
    renderManageGrid();
});

/* ============================================================
   9. 分塊非同步上傳處理
   ============================================================ */
const UPLOAD_CHUNK_SIZE = 15;

const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

function showUploadProgress(done, total) {
    progressWrap.classList.add('active');
    const pct = total ? Math.round(done / total * 100) : 0;
    progressFill.style.width = pct + '%';
    progressLabel.textContent = `處理照片中… ${done} / ${total}（${pct}%）`;
}
function hideUploadProgress() {
    progressWrap.classList.remove('active');
}

async function processOneFile(file) {
    let parsed = null;
    try { parsed = await extractExif(file); } catch (err) { console.error('EXIF 解析失敗:', file.name, err); }

    let url = null;
    if (parsed && parsed.thumbUrl) {
        url = parsed.thumbUrl;
    } else {
        try { url = await blobToDataURL(file); } catch (err) { console.error('讀取原圖失敗:', file.name, err); }
    }

    return {
        name: file.name,
        url,
        file,
        info: parsed && parsed.info ? parsed.info : null,
        category: null,
    };
}

async function addFiles(files) {
    if (!files || files.length === 0) return;
    const total = files.length;
    let done = 0;
    showUploadProgress(0, total);

    for (let i = 0; i < files.length; i += UPLOAD_CHUNK_SIZE) {
        const chunk = files.slice(i, i + UPLOAD_CHUNK_SIZE);
        const results = await Promise.all(chunk.map(f => processOneFile(f)));
        results.forEach(r => { if (r) state.photos.push(r); });
        done += chunk.length;
        showUploadProgress(done, total);
        renderGrid();
        renderManageGrid();
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }

    hideUploadProgress();
}

document.getElementById('fileInput').addEventListener('change', async (e) => {
    await addFiles(Array.from(e.target.files));
    e.target.value = '';
});

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/* ============================================================
   10. 主題切換 (預設暗黑模式)
   ============================================================ */
const themeBtn = document.getElementById('themeToggle');
themeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
        html.removeAttribute('data-theme');
        themeBtn.textContent = '☾ 深色模式';
    } else {
        html.setAttribute('data-theme', 'light');
        themeBtn.textContent = '☀ 淺色模式';
    }
});

initChips();
renderGrid();
renderCategoryEditor();
renderManageGrid();
