/* ============================================================
   library.js — 照片來源與延遲載入
   ------------------------------------------------------------
   兩種來源：
     folder 模式：File System Access API，直接讀取本機資料夾裡的檔案控制代碼(handle)，
                  照片留在原地，不會被複製進記憶體，之後可以直接搬移。
     files  模式：<input type=file> / 拖曳檔案，瀏覽器不支援 folder 模式時的相容做法。

   記憶體策略：
     - 一律用 objectURL，不用 dataURL（dataURL 會把 25MB 的 JPEG 變成 ~33MB 的字串常駐）
     - EXIF 與縮圖只在該頁要顯示時才讀，且用 LRU 上限回收 objectURL
   ============================================================ */
const PMLibrary = (function () {

    const IMAGE_RE = /\.(jpe?g|tiff?)$/i;
    const MAX_THUMBS = 900;   // 同時保留的縮圖 objectURL 數量
    const MAX_FULL = 10;      // 同時保留的原圖 objectURL 數量
    const MAX_DEPTH = 6;      // 掃描子資料夾的最大深度
    const CONCURRENCY = 4;

    const lib = {
        mode: null,          // 'folder' | 'files' | null
        rootHandle: null,
        rootName: '',
        photos: [],
        recursive: false,
    };

    let idSeq = 0;
    const thumbLRU = new Map();  // id -> photo
    const fullLRU = new Map();   // id -> {photo, url}

    /* ---------- 併發限制 ---------- */
    let running = 0;
    const waiting = [];
    function runLimited(fn) {
        return new Promise((resolve, reject) => {
            const task = () => {
                running++;
                Promise.resolve().then(fn).then(resolve, reject).finally(() => {
                    running--;
                    const next = waiting.shift();
                    if (next) next();
                });
            };
            if (running < CONCURRENCY) task(); else waiting.push(task);
        });
    }

    /* ---------- 支援度 ---------- */
    // file:// 底下 showDirectoryPicker 雖然存在但一定會丟 SecurityError，直接當作不支援
    function supportsFolder() {
        return typeof window.showDirectoryPicker === 'function'
            && location.protocol !== 'file:'
            && window.isSecureContext !== false;
    }

    async function ensurePermission(handle) {
        const opts = { mode: 'readwrite' };
        if (!handle.queryPermission) return true;
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    }

    /* ---------- 建立照片物件 ---------- */
    function makePhoto(src) {
        idSeq++;
        return {
            id: 'p' + idSeq,
            name: src.name,
            relPath: src.relPath || src.name,
            handle: src.handle || null,
            parent: src.parent || null,
            file: src.file || null,
            size: src.size ?? null,
            lastModified: src.lastModified ?? null,
            info: null,
            infoState: 'idle',     // idle | done | error
            thumbUrl: null,
            thumbState: 'idle',    // idle | loading | done | error
            catId: null,
            organized: null,       // {folder, action} 已實際搬移/複製過
            _p: null,
        };
    }

    /* ---------- 檔名自然排序（DSC_9 排在 DSC_10 前面）---------- */
    const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
    function natCompare(a, b) { return collator.compare(a, b); }

    /* ---------- folder 模式 ---------- */
    async function pickFolder(opts) {
        if (!supportsFolder()) throw new Error('這個瀏覽器不支援資料夾模式');
        const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'pmRoot', startIn: 'pictures' });
        return openFolderHandle(handle, opts);
    }

    async function openFolderHandle(handle, opts) {
        const options = opts || {};
        if (!(await ensurePermission(handle))) throw new Error('沒有取得資料夾的讀寫權限，無法整理照片。');

        clear();
        lib.mode = 'folder';
        lib.rootHandle = handle;
        lib.rootName = handle.name;
        lib.recursive = !!options.recursive;

        const out = [];
        const skip = options.skipFolders instanceof Set ? options.skipFolders : new Set();
        await scanDir(handle, '', out, lib.recursive ? MAX_DEPTH : 0, skip, options.onProgress);
        out.sort((a, b) => natCompare(a.relPath, b.relPath));
        lib.photos = out;
        return out;
    }

    async function scanDir(dir, prefix, out, depthLeft, skip, onProgress) {
        for await (const [name, entry] of dir.entries()) {
            if (entry.kind === 'file') {
                if (!IMAGE_RE.test(name)) continue;
                out.push(makePhoto({ handle: entry, parent: dir, name, relPath: prefix + name }));
                if (onProgress && out.length % 200 === 0) onProgress(out.length);
            } else if (entry.kind === 'directory') {
                if (depthLeft <= 0) continue;
                if (name.startsWith('.') || skip.has(name)) continue;
                await scanDir(entry, prefix + name + '/', out, depthLeft - 1, skip, onProgress);
            }
        }
        if (onProgress) onProgress(out.length);
    }

    async function rescan(opts) {
        if (lib.mode !== 'folder' || !lib.rootHandle) return lib.photos;
        return openFolderHandle(lib.rootHandle, Object.assign({ recursive: lib.recursive }, opts || {}));
    }

    /* ---------- files 模式 ---------- */
    function addFiles(files) {
        const accepted = Array.from(files || []).filter(f => IMAGE_RE.test(f.name) || /image\/(jpeg|tiff)/.test(f.type));
        if (!accepted.length) return [];
        if (lib.mode !== 'files') {
            clear();
            lib.mode = 'files';
            lib.rootName = '已選擇的檔案';
        }
        const added = accepted.map(f => makePhoto({
            file: f,
            name: f.name,
            relPath: f.webkitRelativePath || f.name,
            size: f.size,
            lastModified: f.lastModified,
        }));
        lib.photos = lib.photos.concat(added);
        lib.photos.sort((a, b) => natCompare(a.relPath, b.relPath));
        return added;
    }

    /* ---------- 取得檔案 ---------- */
    async function getFile(photo) {
        if (photo.file) return photo.file;
        if (photo.handle) return photo.handle.getFile();
        throw new Error('照片沒有可用的來源：' + photo.name);
    }

    /* ---------- 縮圖 ---------- */
    async function makeThumbBlob(file) {
        const bmp = await createImageBitmap(file, { imageOrientation: 'none', resizeWidth: 480, resizeQuality: 'medium' });
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
    }

    function rememberThumb(photo) {
        thumbLRU.delete(photo.id);
        thumbLRU.set(photo.id, photo);
        while (thumbLRU.size > MAX_THUMBS) {
            const oldestId = thumbLRU.keys().next().value;
            const old = thumbLRU.get(oldestId);
            thumbLRU.delete(oldestId);
            if (old && old.thumbUrl) {
                URL.revokeObjectURL(old.thumbUrl);
                old.thumbUrl = null;
                old.thumbState = 'idle';
            }
        }
    }

    /** 讀 EXIF + 產生縮圖（同一次檔案讀取完成，之後重複呼叫直接回傳快取） */
    function ensureThumb(photo) {
        if (photo.thumbState === 'done' && photo.thumbUrl) {
            rememberThumb(photo);
            return Promise.resolve(photo.thumbUrl);
        }
        if (photo._p) return photo._p;

        photo.thumbState = 'loading';
        photo._p = runLimited(async () => {
            const file = await getFile(photo);
            photo.size = file.size;
            photo.lastModified = file.lastModified;

            let parsed = null;
            try { parsed = await PMExif.extractExif(file); }
            catch (e) { console.warn('EXIF 解析失敗：', photo.name, e); }

            if (parsed && parsed.info) { photo.info = parsed.info; photo.infoState = 'done'; }
            else if (photo.infoState !== 'done') { photo.infoState = 'error'; }

            // 優先從原圖縮放，畫質比相機內嵌的低解析 EXIF 縮圖好。
            // 所有處理都在瀏覽器本機完成；僅在瀏覽器無法解碼原圖（例如部分 TIFF）時後備使用 EXIF 縮圖。
            let blob = null;
            try { blob = await makeThumbBlob(file); }
            catch (e) { console.warn('無法從原圖產生縮圖，改用 EXIF 縮圖：', photo.name, e); }
            if (!blob && parsed) blob = parsed.thumbBlob;
            if (blob) {
                photo.thumbUrl = URL.createObjectURL(blob);
                photo.thumbState = 'done';
                rememberThumb(photo);
            } else {
                photo.thumbState = 'error';
            }
            return photo.thumbUrl;
        }).finally(() => { photo._p = null; });

        return photo._p;
    }

    /** 只讀 EXIF，不做縮圖（統計頁全庫掃描用，快很多） */
    function ensureInfo(photo) {
        if (photo.infoState === 'done' || photo.infoState === 'error') return Promise.resolve(photo.info);
        if (photo._p) return photo._p.then(() => photo.info);
        return runLimited(async () => {
            try {
                const file = await getFile(photo);
                photo.size = file.size;
                photo.lastModified = file.lastModified;
                const parsed = await PMExif.extractExif(file, { wantThumb: false });
                if (parsed && parsed.info) { photo.info = parsed.info; photo.infoState = 'done'; }
                else photo.infoState = 'error';
            } catch (e) {
                photo.infoState = 'error';
            }
            return photo.info;
        });
    }

    /** 依序把整批照片的 EXIF 讀完，回報進度；回傳一個可中止的控制器 */
    function scanAllInfo(onProgress) {
        const targets = lib.photos;
        let done = 0;
        let aborted = false;
        const promise = (async () => {
            for (let i = 0; i < targets.length; i += CONCURRENCY) {
                if (aborted) break;
                const batch = targets.slice(i, i + CONCURRENCY);
                await Promise.all(batch.map(p => ensureInfo(p)));
                done += batch.length;
                if (onProgress) onProgress(Math.min(done, targets.length), targets.length);
                await new Promise(r => setTimeout(r, 0));
            }
        })();
        return { promise, abort() { aborted = true; } };
    }

    /* ---------- 原圖（大圖預覽） ---------- */
    async function fullUrl(photo) {
        const cached = fullLRU.get(photo.id);
        if (cached) {
            fullLRU.delete(photo.id);
            fullLRU.set(photo.id, cached);
            return cached.url;
        }
        const file = await getFile(photo);
        const url = URL.createObjectURL(file);
        fullLRU.set(photo.id, { photo, url });
        while (fullLRU.size > MAX_FULL) {
            const oldestId = fullLRU.keys().next().value;
            const old = fullLRU.get(oldestId);
            fullLRU.delete(oldestId);
            if (old) URL.revokeObjectURL(old.url);
        }
        return url;
    }

    function preloadAround(index, ahead, behind) {
        const wanted = [];
        for (let d = 1; d <= ahead; d++) wanted.push(index + d);
        for (let d = 1; d <= behind; d++) wanted.push(index - d);
        wanted.forEach(i => {
            const p = lib.photos[i];
            if (!p) return;
            fullUrl(p).then(url => { if (url) { const img = new Image(); img.src = url; } }).catch(() => { });
        });
    }

    /* ---------- 清空 ---------- */
    function clear() {
        lib.photos.forEach(p => {
            if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
            p.thumbUrl = null;
        });
        fullLRU.forEach(v => URL.revokeObjectURL(v.url));
        fullLRU.clear();
        thumbLRU.clear();
        lib.photos = [];
        lib.mode = null;
        lib.rootHandle = null;
        lib.rootName = '';
    }

    /* ---------- 統計 ---------- */
    function stats() {
        const total = lib.photos.length;
        let analysed = 0, marked = 0, organized = 0, bytes = 0;
        lib.photos.forEach(p => {
            if (p.infoState === 'done' || p.infoState === 'error') analysed++;
            if (p.catId) marked++;
            if (p.organized) organized++;
            if (p.size) bytes += p.size;
        });
        return { total, analysed, marked, organized, bytes };
    }

    return {
        lib,
        supportsFolder, pickFolder, openFolderHandle, rescan, addFiles,
        getFile, ensureThumb, ensureInfo, scanAllInfo, fullUrl, preloadAround,
        clear, stats, natCompare,
        get photos() { return lib.photos; },
        get mode() { return lib.mode; },
        get rootName() { return lib.rootName; },
        get rootHandle() { return lib.rootHandle; },
    };
})();
