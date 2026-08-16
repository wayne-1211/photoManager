/* ============================================================
   app.js — UI 與流程
   ============================================================ */

/* ---------- 卡片上可顯示的 EXIF 欄位 ---------- */
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

const state = {
    fields: new Map(FIELD_DEFS.map(f => [f.key, f.on])),
    pageSize: 50,
    photosPage: 0,
    hideDone: false,
};

let selectedId = null;

const $ = (id) => document.getElementById(id);

/* ============================================================
   工具
   ============================================================ */
function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function debounce(fn, ms) {
    let t = null;
    return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), ms);
    };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 進度列 ---------- */
function showProgress(done, total, label) {
    $('progressWrap').classList.add('active');
    const pct = total ? Math.round(done / total * 100) : 0;
    $('progressFill').style.width = pct + '%';
    $('progressLabel').textContent = `${label || '處理中'}… ${done} / ${total}（${pct}%）`;
}
function showProgressText(text) {
    $('progressWrap').classList.add('active');
    $('progressFill').style.width = '100%';
    $('progressLabel').textContent = text;
}
function hideProgress() {
    $('progressWrap').classList.remove('active');
    $('progressFill').style.width = '0%';
}

/* ---------- 分類標記的本機記憶 ---------- */
const Marks = {
    key() { return 'pm.marks.' + (PMLibrary.rootName || '__none__'); },
    load() {
        try { return JSON.parse(localStorage.getItem(this.key()) || '{}'); }
        catch (e) { return {}; }
    },
    write() {
        if (!PMLibrary.rootName) return;
        const map = {};
        PMLibrary.photos.forEach(p => { if (p.catId && !p.organized) map[p.relPath] = p.catId; });
        try {
            if (Object.keys(map).length) localStorage.setItem(this.key(), JSON.stringify(map));
            else localStorage.removeItem(this.key());
        } catch (e) { /* 空間不足就算了，不影響主要功能 */ }
    },
    restore() {
        const map = this.load();
        let n = 0;
        PMLibrary.photos.forEach(p => {
            const id = map[p.relPath];
            if (id && PMCategories.byId(id)) { p.catId = id; n++; }
        });
        return n;
    },
};
const saveMarks = debounce(() => Marks.write(), 250);

/* ============================================================
   來源：資料夾 / 檔案
   ============================================================ */
/** 換來源前先把畫面上的 <img> 清掉，否則舊的 objectURL 被回收後瀏覽器會去撈已失效的 blob */
function detachImages() {
    $('grid').innerHTML = '';
    $('manageGrid').innerHTML = '';
    $('previewWrap').innerHTML = '';
}

async function openFolder() {
    try {
        detachImages();
        showProgressText('掃描資料夾中…');
        const skip = new Set(PMCategories.all().map(c => c.folder));
        await PMLibrary.pickFolder({
            recursive: $('recursiveChk').checked,
            skipFolders: $('recursiveChk').checked ? skip : new Set(),
            onProgress: (n) => showProgressText(`掃描資料夾中… 已找到 ${n} 張照片`),
        });
        afterSourceChanged();
    } catch (err) {
        if (err && err.name === 'AbortError') { hideProgress(); return; }
        hideProgress();
        alert('開啟資料夾失敗：' + (err && err.message ? err.message : err));
    }
}

async function rescanFolder() {
    if (PMLibrary.mode !== 'folder') return;
    try {
        detachImages();
        showProgressText('重新掃描中…');
        const skip = new Set(PMCategories.all().map(c => c.folder));
        await PMLibrary.rescan({
            skipFolders: $('recursiveChk').checked ? skip : new Set(),
            onProgress: (n) => showProgressText(`重新掃描中… 已找到 ${n} 張照片`),
        });
        afterSourceChanged();
    } catch (err) {
        hideProgress();
        alert('重新掃描失敗：' + (err && err.message ? err.message : err));
    }
}

function afterSourceChanged() {
    const restored = Marks.restore();
    selectedId = PMLibrary.photos.length ? PMLibrary.photos[0].id : null;
    state.photosPage = 0;
    hideProgress();
    renderAll();
    if (restored) {
        console.info(`已還原 ${restored} 張照片先前的分類標記。`);
    }
}

function handleFiles(files) {
    if (PMLibrary.mode !== 'files') detachImages();   // 從資料夾模式切過來時會清空舊來源
    const added = PMLibrary.addFiles(files);
    if (!added.length) return;
    if (!selectedId) selectedId = PMLibrary.photos[0].id;
    renderAll();
}

function renderSourceInfo() {
    const s = PMLibrary.stats();
    const el = $('sourceInfo');
    if (!PMLibrary.mode) {
        el.textContent = '尚未選擇來源';
        el.classList.remove('ok');
    } else if (PMLibrary.mode === 'folder') {
        el.innerHTML = `📁 <b>${escapeHtml(PMLibrary.rootName)}</b> · ${s.total} 張 · ${fmtBytes(s.bytes)}${s.bytes ? '＋' : ''}`;
        el.classList.add('ok');
    } else {
        el.innerHTML = `📄 相容模式 · ${s.total} 張 · ${fmtBytes(s.bytes)}`;
        el.classList.add('ok');
    }
    $('rescanBtn').hidden = PMLibrary.mode !== 'folder';
}

/* ============================================================
   照片檢視
   ============================================================ */
function initChips() {
    const row = $('chipRow');
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

function fillExifList(photo, listEl) {
    listEl.innerHTML = '';
    let any = false;
    if (photo.info) {
        FIELD_DEFS.forEach(f => {
            if (!state.fields.get(f.key)) return;
            const val = photo.info[f.key];
            if (val === null || val === undefined) return;
            any = true;
            const row = document.createElement('div');
            row.className = 'row';
            row.innerHTML = `<span class="k">${escapeHtml(f.label)}</span><span class="v">${escapeHtml(val)}</span>`;
            listEl.appendChild(row);
        });
    }
    if (!any) {
        const e = document.createElement('div');
        e.className = 'exif-empty';
        e.textContent = photo.infoState === 'idle' ? '讀取中…'
            : (photo.info ? '無選取欄位的資料' : '此照片無法解出 EXIF 資訊');
        listEl.appendChild(e);
    }
}

/** 縮圖延遲載入：只有真的排到這一頁才會去讀檔案 */
function attachThumb(img, photo, onMeta) {
    if (photo.thumbUrl) {
        img.src = photo.thumbUrl;
        PMExif.applyOrientation(img, photo.info ? photo.info.orientation : null, false);
        if (onMeta) onMeta();
        return;
    }
    img.classList.add('thumb-loading');
    PMLibrary.ensureThumb(photo).then(url => {
        img.classList.remove('thumb-loading');
        if (!img.isConnected) return;
        if (url) img.src = url;
        PMExif.applyOrientation(img, photo.info ? photo.info.orientation : null, false);
        if (onMeta) onMeta();
    }).catch(() => img.classList.remove('thumb-loading'));
}

function renderPagination(containerId, page, totalPages, onChange) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = '';
    if (totalPages <= 1) return;

    const prev = document.createElement('button');
    prev.className = 'page-btn';
    prev.textContent = '← 上一頁';
    prev.disabled = page <= 0;
    prev.onclick = () => onChange(page - 1);

    const info = document.createElement('span');
    info.className = 'page-info';
    info.textContent = `第 ${page + 1} / ${totalPages} 頁`;

    const next = document.createElement('button');
    next.className = 'page-btn';
    next.textContent = '下一頁 →';
    next.disabled = page >= totalPages - 1;
    next.onclick = () => onChange(page + 1);

    el.append(prev, info, next);
}

function renderGrid() {
    const grid = $('grid');
    const empty = $('emptyState');
    const photos = PMLibrary.photos;
    grid.innerHTML = '';

    if (photos.length === 0) {
        empty.style.display = 'block';
        $('photoCount').textContent = '尚未載入照片';
        renderPagination('photosPagination', 0, 0, () => { });
        return;
    }
    empty.style.display = 'none';
    $('photoCount').textContent = photos.length + ' 張照片';

    const totalPages = Math.max(1, Math.ceil(photos.length / state.pageSize));
    state.photosPage = Math.min(Math.max(state.photosPage, 0), totalPages - 1);
    const start = state.photosPage * state.pageSize;
    const pagePhotos = photos.slice(start, start + state.pageSize);

    pagePhotos.forEach(p => {
        const card = document.createElement('div');
        card.className = 'card';

        const thumbWrap = document.createElement('div');
        thumbWrap.className = 'thumb-wrap';
        const img = document.createElement('img');
        img.alt = p.name;
        thumbWrap.appendChild(img);

        if (p.catId) {
            const cat = PMCategories.byId(p.catId);
            if (cat) {
                const dot = document.createElement('span');
                dot.className = 'card-cat-dot';
                dot.style.background = cat.color;
                dot.title = cat.name;
                dot.textContent = cat.key;
                thumbWrap.appendChild(dot);
            }
        }
        card.appendChild(thumbWrap);

        const body = document.createElement('div');
        body.className = 'card-body';
        const fname = document.createElement('div');
        fname.className = 'card-fname';
        fname.textContent = p.relPath;
        fname.title = p.relPath;
        body.appendChild(fname);

        const list = document.createElement('div');
        list.className = 'exif-list';
        body.appendChild(list);
        card.appendChild(body);
        grid.appendChild(card);

        fillExifList(p, list);
        attachThumb(img, p, () => fillExifList(p, list));
    });

    renderPagination('photosPagination', state.photosPage, totalPages, (newPage) => {
        state.photosPage = newPage;
        renderGrid();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

/* ============================================================
   統計
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
    h.innerHTML = `${escapeHtml(title)} <span class="sub">${escapeHtml(sub)}</span>`;
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
      <div class="bar-label">${escapeHtml(label)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(count / max * 100).toFixed(1)}%"></div></div>
      <div class="bar-count">${count}</div>`;
        wrap.appendChild(row);
    });
    return wrap;
}

function renderStats() {
    const container = $('statsGrid');
    container.innerHTML = '';
    const s = PMLibrary.stats();
    $('statsProgress').textContent = s.total
        ? `已分析 ${s.analysed} / ${s.total} 張（統計只計入已分析的照片）`
        : '尚未載入照片';
    $('scanAllBtn').disabled = !s.total || s.analysed >= s.total;

    const infos = PMLibrary.photos.map(p => p.info).filter(Boolean);

    const focal = bucketCount(infos.map(i => i.focalLengthRaw), v => {
        const lower = Math.floor(v / 10) * 10;
        return lower + '-' + (lower + 9) + 'mm';
    });
    focal.sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
    const aperture = bucketCount(infos.map(i => i.fNumber ? parseFloat(i.fNumber.replace('f/', '')) : null), v => 'f/' + v);
    const shutter = bucketCount(infos.map(i => i.exposureTimeRaw), v => PMExif.fmtShutter(v));
    const iso = bucketCount(infos.map(i => i.iso), v => 'ISO ' + v);
    const wb = bucketCount(infos.map(i => i.whiteBalanceRaw), v => (PMExif.WHITE_BALANCE_STD[v] ?? ('代碼 ' + v)));
    const cameras = bucketCount(infos.map(i => i.model), v => v);
    const lenses = bucketCount(infos.map(i => i.lensModel), v => v);
    const styles = bucketCount(infos.map(i => i.creativeStyle), v => v);

    container.appendChild(renderStatCard('焦段使用', 'focal length, 10mm 一個級距', focal, 20));
    container.appendChild(renderStatCard('光圈使用', 'aperture (f-number)', aperture));
    container.appendChild(renderStatCard('快門速度', 'shutter speed', shutter));
    container.appendChild(renderStatCard('ISO 感光度', 'ISO', iso));
    container.appendChild(renderStatCard('白平衡（色溫模式）', '標準 EXIF WhiteBalance', wb));
    container.appendChild(renderStatCard('相機型號', 'camera model', cameras));
    container.appendChild(renderStatCard('鏡頭', 'lens model', lenses));
    container.appendChild(renderStatCard('創意風格 (Sony)', 'creative style', styles));
}

let scanTask = null;
$('scanAllBtn').addEventListener('click', async () => {
    if (!PMLibrary.photos.length || scanTask) return;
    const btn = $('scanAllBtn');
    btn.disabled = true;
    scanTask = PMLibrary.scanAllInfo((done, total) => {
        showProgress(done, total, '分析 EXIF');
        $('statsProgress').textContent = `已分析 ${done} / ${total} 張`;
    });
    await scanTask.promise;
    scanTask = null;
    hideProgress();
    renderStats();
});

/* ============================================================
   整理分類
   ============================================================ */
function manageList() {
    return state.hideDone ? PMLibrary.photos.filter(p => !p.catId) : PMLibrary.photos;
}
function selectedIndexIn(list) {
    const i = list.findIndex(p => p.id === selectedId);
    return i < 0 ? 0 : i;
}

function renderCatLegend() {
    const wrap = $('catLegend');
    wrap.innerHTML = '';
    const cats = PMCategories.all();
    if (!cats.length) {
        wrap.innerHTML = '<span class="dim">還沒有任何分類，請到「分類設定」新增。</span>';
        return;
    }
    const counts = new Map();
    PMLibrary.photos.forEach(p => { if (p.catId) counts.set(p.catId, (counts.get(p.catId) || 0) + 1); });

    cats.forEach(cat => {
        const item = document.createElement('button');
        item.className = 'legend-item';
        item.title = `按 ${cat.key} 標記為「${cat.name}」（${PMCategories.actionLabel(cat.action)}）`;
        item.innerHTML = `
      <span class="legend-key" style="background:${cat.color}">${escapeHtml(cat.key || '·')}</span>
      <span class="legend-name">${escapeHtml(cat.name)}</span>
      <span class="legend-count">${counts.get(cat.id) || 0}</span>
      <span class="legend-action">${escapeHtml(PMCategories.actionLabel(cat.action))}</span>`;
        item.onclick = () => markCurrent(cat);
        wrap.appendChild(item);
    });

    const clearItem = document.createElement('button');
    clearItem.className = 'legend-item ghost';
    clearItem.innerHTML = `<span class="legend-key plain">⌫</span><span class="legend-name">清除標記</span>`;
    clearItem.onclick = () => clearCurrentMark();
    wrap.appendChild(clearItem);
}

function markCurrent(cat) {
    const list = manageList();
    const i = selectedIndexIn(list);
    const photo = list[i];
    if (!photo) return;
    if (photo.organized) return; // 已經搬過的就不再改
    photo.catId = photo.catId === cat.id ? null : cat.id;
    saveMarks();

    const after = manageList();
    const nextIdx = state.hideDone ? Math.min(i, after.length - 1) : Math.min(i + 1, after.length - 1);
    selectedId = after[nextIdx] ? after[nextIdx].id : null;
    renderManage();
    renderCatLegend();
    renderApplyHint();
}

function clearCurrentMark() {
    const list = manageList();
    const photo = list[selectedIndexIn(list)];
    if (!photo) return;
    photo.catId = null;
    saveMarks();
    renderManage();
    renderCatLegend();
    renderApplyHint();
}

function moveSelection(delta) {
    const list = manageList();
    if (!list.length) return;
    const i = selectedIndexIn(list);
    const next = Math.min(Math.max(i + delta, 0), list.length - 1);
    selectedId = list[next].id;
    renderManage();
}

async function renderPreview() {
    const wrap = $('previewWrap');
    const oldImg = wrap.querySelector('.preview-image-box img');
    if (oldImg && oldImg._ro) oldImg._ro.disconnect();
    wrap.innerHTML = '';

    const list = manageList();
    const photo = list[selectedIndexIn(list)];
    if (!photo) {
        wrap.innerHTML = '<p class="stat-empty">尚無選取的照片</p>';
        return;
    }

    const box = document.createElement('div');
    box.className = 'preview-image-box';
    const img = document.createElement('img');
    if (photo.thumbUrl) img.src = photo.thumbUrl;   // 先用縮圖頂著，原圖載完再換
    box.appendChild(img);
    wrap.appendChild(box);

    const fname = document.createElement('div');
    fname.className = 'preview-fname';
    fname.textContent = photo.relPath;
    wrap.appendChild(fname);

    const meta = document.createElement('div');
    meta.className = 'preview-meta';
    meta.textContent = `${fmtBytes(photo.size || 0)}`;
    wrap.appendChild(meta);

    if (photo.organized) {
        const done = document.createElement('div');
        done.className = 'preview-cat-badge done';
        done.textContent = `✓ 已${photo.organized.action === 'copy' ? '複製' : '移動'}到 ${photo.organized.folder}`;
        wrap.appendChild(done);
    } else if (photo.catId) {
        const cat = PMCategories.byId(photo.catId);
        if (cat) {
            const badge = document.createElement('div');
            badge.className = 'preview-cat-badge';
            badge.style.background = cat.color;
            badge.textContent = `${cat.name} → ${cat.action === 'keep' ? '不移動' : cat.folder}`;
            wrap.appendChild(badge);
        }
    }

    const exifWrap = document.createElement('div');
    exifWrap.className = 'preview-exif';
    wrap.appendChild(exifWrap);

    const sideFields = [
        ['dateTimeOriginal', '拍攝時間'], ['model', '相機型號'], ['lensModel', '鏡頭'],
        ['focalLength', '焦段'], ['fNumber', '光圈'], ['exposureTime', '快門'], ['iso', 'ISO'],
        ['creativeStyle', '創意風格'],
    ];
    const fillSide = () => {
        exifWrap.innerHTML = '';
        let any = false;
        if (photo.info) {
            sideFields.forEach(([k, label]) => {
                const val = photo.info[k];
                if (val === null || val === undefined) return;
                any = true;
                const row = document.createElement('div');
                row.className = 'row';
                row.innerHTML = `<span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(val)}</span>`;
                exifWrap.appendChild(row);
            });
        }
        if (!any) exifWrap.innerHTML = `<p class="exif-empty">${photo.infoState === 'idle' ? '讀取中…' : '此照片無法解出 EXIF 資訊'}</p>`;
    };
    fillSide();

    const hint = document.createElement('div');
    hint.className = 'kbd-hint';
    const keys = PMCategories.all().filter(c => c.key).map(c => `<kbd>${escapeHtml(c.key)}</kbd>`).join('');
    hint.innerHTML = `方向鍵 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 切換照片　<kbd>⌫</kbd> 清除標記<br>
    ${keys ? '快捷鍵 ' + keys + ' 標記分類並跳到下一張' : '尚未設定快捷鍵，請到「分類設定」指定'}`;
    wrap.appendChild(hint);

    // 原圖與 EXIF（縮圖流程順便把 EXIF 讀好）
    PMLibrary.ensureThumb(photo).then(() => { if (currentPhotoId() === photo.id) fillSide(); });
    PMLibrary.fullUrl(photo).then(url => {
        if (!url || currentPhotoId() !== photo.id || !img.isConnected) return;
        img.src = url;
        PMExif.applyOrientation(img, photo.info ? photo.info.orientation : null, true);
    }).catch(err => console.warn('讀取原圖失敗：', photo.name, err));

    PMExif.applyOrientation(img, photo.info ? photo.info.orientation : null, true);

    const globalIndex = PMLibrary.photos.indexOf(photo);
    PMLibrary.preloadAround(globalIndex, 4, 2);
}

function currentPhotoId() {
    const list = manageList();
    const p = list[selectedIndexIn(list)];
    return p ? p.id : null;
}

function renderManage() {
    const grid = $('manageGrid');
    const empty = $('manageEmpty');
    const list = manageList();
    const all = PMLibrary.stats();
    grid.innerHTML = '';

    $('mgmtPhotoCount').textContent = all.total
        ? `${all.total} 張 · 已標記 ${all.marked} · 已整理 ${all.organized}`
        : '尚未載入照片';

    if (!list.length) {
        empty.style.display = 'block';
        empty.querySelector('p').textContent = all.total ? '這個篩選條件下沒有照片。' : '還沒有照片可以分類。';
        renderPagination('managePagination', 0, 0, () => { });
        renderPreview();
        return;
    }
    empty.style.display = 'none';

    if (!selectedId || !list.some(p => p.id === selectedId)) selectedId = list[0].id;
    const selIdx = selectedIndexIn(list);

    const totalPages = Math.max(1, Math.ceil(list.length / state.pageSize));
    const page = Math.floor(selIdx / state.pageSize);
    const start = page * state.pageSize;

    list.slice(start, start + state.pageSize).forEach((p, localIdx) => {
        const i = start + localIdx;
        const card = document.createElement('div');
        card.className = 'thumb-card' + (i === selIdx ? ' selected' : '') + (p.organized ? ' organized' : '');

        const img = document.createElement('img');
        img.alt = p.name;
        card.appendChild(img);

        const fnameTag = document.createElement('div');
        fnameTag.className = 'fname-tag';
        fnameTag.textContent = p.name;
        card.appendChild(fnameTag);

        if (p.organized) {
            const badge = document.createElement('div');
            badge.className = 'cat-badge done';
            badge.textContent = '✓ ' + p.organized.folder;
            card.appendChild(badge);
        } else if (p.catId) {
            const cat = PMCategories.byId(p.catId);
            if (cat) {
                const badge = document.createElement('div');
                badge.className = 'cat-badge';
                badge.style.background = cat.color;
                badge.textContent = cat.name;
                card.appendChild(badge);
            }
        }

        card.addEventListener('click', () => {
            selectedId = p.id;
            renderManage();
        });

        grid.appendChild(card);
        attachThumb(img, p);
    });

    renderPagination('managePagination', page, totalPages, (newPage) => {
        const idx = Math.min(Math.max(newPage * state.pageSize, 0), list.length - 1);
        selectedId = list[idx].id;
        renderManage();
    });

    renderPreview();
    renderApplyHint();

    const selectedEl = grid.querySelector('.thumb-card.selected');
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
}

/* ---------- 鍵盤 ---------- */
function isManageViewActive() { return $('manageView').classList.contains('active'); }

document.addEventListener('keydown', (e) => {
    if (!isManageViewActive()) return;
    const tag = document.activeElement ? document.activeElement.tagName : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!PMLibrary.photos.length) return;

    const cols = parseInt($('mgmtColSlider').value, 10) || 3;

    switch (e.key) {
        case 'ArrowRight': e.preventDefault(); moveSelection(1); return;
        case 'ArrowLeft': e.preventDefault(); moveSelection(-1); return;
        case 'ArrowDown': e.preventDefault(); moveSelection(cols); return;
        case 'ArrowUp': e.preventDefault(); moveSelection(-cols); return;
        case 'Backspace':
        case 'Delete': e.preventDefault(); clearCurrentMark(); return;
    }

    const cat = PMCategories.byKey(e.key);
    if (cat) {
        e.preventDefault();
        markCurrent(cat);
    }
});

/* ============================================================
   套用整理（folder 模式）／ZIP 打包（相容模式）
   ============================================================ */
function renderApplyHint() {
    const hint = $('applyHint');
    const applyBtn = $('applyBtn');
    const exportBtn = $('exportBtn');

    if (PMLibrary.mode === 'files') {
        applyBtn.hidden = true;
        exportBtn.hidden = false;
        const marked = PMLibrary.photos.filter(p => p.catId && (PMCategories.byId(p.catId) || {}).action !== 'keep').length;
        hint.innerHTML = `相容模式無法直接動你電腦上的檔案，只能打包成 zip 下載。<br>目前有 <b>${marked}</b> 張可打包。`
            + `<br><span class="dim">想要直接移動檔案，請用 Chrome / Edge 並改用「開啟照片資料夾」。</span>`;
        exportBtn.disabled = marked === 0;
        return;
    }

    applyBtn.hidden = false;
    exportBtn.hidden = true;

    if (PMLibrary.mode !== 'folder') {
        hint.textContent = '尚未選擇來源資料夾。';
        applyBtn.disabled = true;
        return;
    }

    const p = PMOrganize.plan(PMLibrary.photos);
    applyBtn.disabled = p.total === 0;
    if (p.total === 0) {
        hint.textContent = '目前沒有待整理的照片（標記後才會出現在這裡）。';
        return;
    }
    const lines = p.byFolder
        .sort((a, b) => b.count - a.count)
        .map(b => `<span class="plan-row"><b>${b.count}</b> 張 → <code>${escapeHtml(b.folder)}/</code> <span class="dim">${PMCategories.actionLabel(b.action)}</span></span>`)
        .join('');
    hint.innerHTML = `即將整理 <b>${p.total}</b> 張，在 <code>${escapeHtml(PMLibrary.rootName)}</code> 底下：${lines}`;
}

$('applyBtn').addEventListener('click', async () => {
    const plan = PMOrganize.plan(PMLibrary.photos);
    if (!plan.total) return;

    const summary = plan.byFolder.map(b => `  ${b.folder}/  ${b.count} 張（${PMCategories.actionLabel(b.action)}）`).join('\n');
    const ok = confirm(
        `即將在資料夾「${PMLibrary.rootName}」內整理 ${plan.total} 張照片：\n\n${summary}\n\n`
        + `「移動」會真的改變檔案在硬碟上的位置（不會經過資源回收筒）。確定要執行嗎？`
    );
    if (!ok) return;

    const btn = $('applyBtn');
    btn.disabled = true;
    const original = btn.textContent;
    try {
        const result = await PMOrganize.run(plan.items, (done, total, label) => {
            showProgress(done, total, '整理中');
            btn.textContent = `整理中… ${done}/${total}`;
        });
        hideProgress();
        Marks.write();

        const box = $('applyResult');
        box.hidden = false;
        box.className = 'apply-result' + (result.failed.length ? ' has-error' : ' ok');
        box.innerHTML = `完成：移動 <b>${result.moved}</b> 張、複製 <b>${result.copied}</b> 張。`
            + (result.failed.length
                ? `<br>失敗 <b>${result.failed.length}</b> 張：<br>` + result.failed.slice(0, 8).map(f => `<code>${escapeHtml(f.name)}</code> — ${escapeHtml(f.message)}`).join('<br>')
                : '');
    } catch (err) {
        hideProgress();
        alert('整理失敗：' + (err && err.message ? err.message : err));
    } finally {
        btn.textContent = original;
        renderAll();
    }
});

/* ---------- 相容模式：ZIP 打包 ---------- */
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error('載入 ' + src + ' 失敗'));
        document.head.appendChild(s);
    });
}

$('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    const groups = new Map();
    PMLibrary.photos.forEach(p => {
        if (!p.catId) return;
        const cat = PMCategories.byId(p.catId);
        if (!cat || cat.action === 'keep') return;
        const arr = groups.get(cat.folder) || [];
        arr.push(p);
        groups.set(cat.folder, arr);
    });
    let count = 0;
    groups.forEach(arr => count += arr.length);
    if (!count) { alert('目前沒有可打包的照片。'); return; }

    btn.disabled = true;
    const original = btn.textContent;
    try {
        if (typeof JSZip === 'undefined') {
            btn.textContent = '載入打包工具…';
            await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        }
        const zip = new JSZip();
        const used = new Set();
        groups.forEach((arr, folder) => {
            arr.forEach(p => {
                let name = p.name;
                let key = folder + '/' + name;
                let n = 1;
                while (used.has(key)) {
                    const dot = name.lastIndexOf('.');
                    const base = dot > 0 ? p.name.slice(0, dot) : p.name;
                    const ext = dot > 0 ? p.name.slice(dot) : '';
                    name = `${base}_${n++}${ext}`;
                    key = folder + '/' + name;
                }
                used.add(key);
                zip.folder(folder).file(name, p.file);
            });
        });

        btn.textContent = '打包中…';
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
            btn.textContent = `打包中… ${Math.round(meta.percent)}%`;
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Photo_Manager_Export.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
        console.error(err);
        alert('打包失敗：' + (err && err.message ? err.message : err));
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
});

/* ============================================================
   分類設定
   ============================================================ */
function renderCatTable() {
    const wrap = $('catTable');
    wrap.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'cat-row head';
    head.innerHTML = `<div>快捷鍵</div><div>分類名稱</div><div>目標資料夾</div><div>顏色</div><div>動作</div><div></div>`;
    wrap.appendChild(head);

    const cats = PMCategories.all();
    if (!cats.length) {
        const e = document.createElement('div');
        e.className = 'stat-empty';
        e.textContent = '還沒有任何分類，按「＋ 新增分類」開始。';
        wrap.appendChild(e);
        return;
    }

    cats.forEach((cat, idx) => {
        const row = document.createElement('div');
        row.className = 'cat-row';

        const keyInput = document.createElement('input');
        keyInput.className = 'key-input';
        keyInput.type = 'text';
        keyInput.maxLength = 1;
        keyInput.value = cat.key;
        keyInput.style.borderColor = cat.color;
        keyInput.addEventListener('change', () => {
            PMCategories.update(cat.id, { key: keyInput.value });
            renderCatTable();
        });

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = cat.name;
        nameInput.addEventListener('input', debounce(() => {
            PMCategories.update(cat.id, { name: nameInput.value });
        }, 300));

        const folderInput = document.createElement('input');
        folderInput.type = 'text';
        folderInput.value = cat.folder;
        folderInput.placeholder = '資料夾名稱';
        folderInput.addEventListener('change', () => {
            PMCategories.update(cat.id, { folder: folderInput.value });
            folderInput.value = PMCategories.byId(cat.id).folder;
        });

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = cat.color;
        colorInput.addEventListener('input', debounce(() => {
            PMCategories.update(cat.id, { color: colorInput.value });
            keyInput.style.borderColor = colorInput.value;
        }, 150));

        const actionSelect = document.createElement('select');
        PMCategories.ACTIONS.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = PMCategories.actionLabel(a);
            if (cat.action === a) opt.selected = true;
            actionSelect.appendChild(opt);
        });
        actionSelect.addEventListener('change', () => {
            PMCategories.update(cat.id, { action: actionSelect.value });
        });

        const tools = document.createElement('div');
        tools.className = 'cat-tools';
        const up = document.createElement('button');
        up.className = 'icon-btn'; up.textContent = '↑'; up.title = '往上移';
        up.disabled = idx === 0;
        up.onclick = () => { PMCategories.move(cat.id, -1); renderCatTable(); };
        const down = document.createElement('button');
        down.className = 'icon-btn'; down.textContent = '↓'; down.title = '往下移';
        down.disabled = idx === cats.length - 1;
        down.onclick = () => { PMCategories.move(cat.id, 1); renderCatTable(); };
        const del = document.createElement('button');
        del.className = 'icon-btn danger'; del.textContent = '✕'; del.title = '刪除';
        del.onclick = () => {
            const used = PMLibrary.photos.filter(p => p.catId === cat.id).length;
            if (used && !confirm(`有 ${used} 張照片標記為「${cat.name}」，刪除分類會一併清掉這些標記。確定嗎？`)) return;
            PMLibrary.photos.forEach(p => { if (p.catId === cat.id) p.catId = null; });
            PMCategories.remove(cat.id);
            saveMarks();
            renderCatTable();
        };
        tools.append(up, down, del);

        row.append(keyInput, nameInput, folderInput, colorInput, actionSelect, tools);
        wrap.appendChild(row);
    });
}

$('addCatBtn').addEventListener('click', () => { PMCategories.add(); renderCatTable(); });

$('exportCatBtn').addEventListener('click', () => {
    const blob = new Blob([PMCategories.toJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'categories.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
});

$('importCatInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        PMCategories.importJSON(await file.text());
        alert('匯入成功。');
    } catch (err) {
        alert('匯入失敗：' + err.message);
    }
});

$('resetCatBtn').addEventListener('click', async () => {
    if (!confirm('要把分類重設成 categories.json 的預設內容嗎？現有的自訂分類會消失。')) return;
    await PMCategories.reset();
});

PMCategories.onChange(() => {
    // 匯入或重設之後，指向已不存在分類的標記要清掉，否則會變成數得到卻整理不到的幽靈標記
    let dropped = 0;
    PMLibrary.photos.forEach(p => {
        if (p.catId && !PMCategories.byId(p.catId)) { p.catId = null; dropped++; }
    });
    if (dropped) saveMarks();

    renderCatTable();
    renderCatLegend();
    renderApplyHint();
    if (isManageViewActive()) renderManage();
});

/* ============================================================
   全域事件
   ============================================================ */
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        btn.classList.add('active');
        $(btn.dataset.view).classList.add('active');
        if (btn.dataset.view === 'statsView') renderStats();
        if (btn.dataset.view === 'manageView') renderManage();
        if (btn.dataset.view === 'settingsView') renderCatTable();
    });
});

$('pickFolderBtn').addEventListener('click', openFolder);
$('rescanBtn').addEventListener('click', rescanFolder);

$('fileInput').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = '';
});

$('clearBtn').addEventListener('click', () => {
    if (!PMLibrary.photos.length) return;
    if (!confirm(`確定要清除目前載入的 ${PMLibrary.photos.length} 張照片嗎？（只是把畫面清空，不會刪除你電腦上的檔案）`)) return;
    PMLibrary.clear();
    selectedId = null;
    state.photosPage = 0;
    renderAll();
});

$('colSlider').addEventListener('input', (e) => {
    $('colCount').textContent = e.target.value;
    $('grid').style.gridTemplateColumns = `repeat(${e.target.value},1fr)`;
});

$('mgmtColSlider').addEventListener('input', (e) => {
    $('mgmtColCount').textContent = e.target.value;
    $('manageGrid').style.gridTemplateColumns = `repeat(${e.target.value},1fr)`;
});

$('pageSizeSelect').addEventListener('change', (e) => {
    state.pageSize = parseInt(e.target.value, 10) || 50;
    state.photosPage = 0;
    renderGrid();
});

$('hideDoneChk').addEventListener('change', (e) => {
    state.hideDone = e.target.checked;
    renderManage();
});

/* ---------- 拖曳：整個視窗都可以放（支援直接拖資料夾） ---------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');

    // DataTransfer 在 handler 結束後就失效，必須先同步取出
    const items = Array.from(e.dataTransfer.items || []);
    const files = Array.from(e.dataTransfer.files || []);
    const handlePromises = (PMLibrary.supportsFolder() && items.length && typeof items[0].getAsFileSystemHandle === 'function')
        ? items.map(it => it.getAsFileSystemHandle())
        : null;

    if (handlePromises) {
        try {
            const handles = await Promise.all(handlePromises);
            const dir = handles.find(h => h && h.kind === 'directory');
            if (dir) {
                showProgressText('掃描資料夾中…');
                await PMLibrary.openFolderHandle(dir, {
                    recursive: $('recursiveChk').checked,
                    skipFolders: new Set(PMCategories.all().map(c => c.folder)),
                    onProgress: (n) => showProgressText(`掃描資料夾中… 已找到 ${n} 張照片`),
                });
                afterSourceChanged();
                return;
            }
        } catch (err) {
            console.warn('拖曳資料夾失敗，改用檔案模式：', err);
            hideProgress();
        }
    }
    if (files.length) handleFiles(files);
});

/* ---------- 主題 ---------- */
const themeBtn = $('themeToggle');
const savedTheme = localStorage.getItem('pm.theme');
if (savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    themeBtn.textContent = '☀ 淺色模式';
}
themeBtn.addEventListener('click', () => {
    const html = document.documentElement;
    const isLight = html.getAttribute('data-theme') === 'light';
    if (isLight) {
        html.removeAttribute('data-theme');
        themeBtn.textContent = '☾ 深色模式';
        localStorage.setItem('pm.theme', 'dark');
    } else {
        html.setAttribute('data-theme', 'light');
        themeBtn.textContent = '☀ 淺色模式';
        localStorage.setItem('pm.theme', 'light');
    }
});

/* ============================================================
   啟動
   ============================================================ */
function renderAll() {
    renderSourceInfo();
    renderGrid();
    renderCatLegend();
    renderManage();
    if ($('statsView').classList.contains('active')) renderStats();
}

(async function boot() {
    if (!PMLibrary.supportsFolder()) {
        $('pickFolderBtn').disabled = true;
        $('recursiveChk').disabled = true;
        const warn = $('fsWarn');
        warn.hidden = false;
        warn.innerHTML = location.protocol === 'file:'
            ? '這個頁面是用 <code>file://</code> 開啟的，瀏覽器不允許直接存取資料夾。'
            + '請改用本機伺服器（例如在資料夾裡執行 <code>python -m http.server</code> 後開 <code>http://localhost:8000</code>），'
            + '或部署到 GitHub Pages，就能使用「直接整理原始資料夾」的功能。目前只能使用「選擇檔案 + 打包下載」的相容模式。'
            : '這個瀏覽器不支援 File System Access API（目前 Chrome / Edge 支援）。'
            + '將改用「選擇檔案 + 打包下載」的相容模式。';
    }

    await PMCategories.init();
    initChips();
    renderCatTable();
    renderAll();
})();
