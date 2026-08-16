/* ============================================================
   organize.js — 直接在本機資料夾裡搬移／複製照片
   ------------------------------------------------------------
   不打包、不下載。每張照片依它的分類，移動或複製到來源資料夾底下
   對應的子資料夾（分類的 folder 欄位）。
   優先用 FileSystemFileHandle.move()（瞬間完成，不搬資料），
   沒有這個 API 時退回「串流複製 + 刪除原檔」。
   ============================================================ */
const PMOrganize = (function () {

    /* ---------- 目的資料夾 ---------- */
    async function getDestDir(root, folderName, cache) {
        if (cache.has(folderName)) return cache.get(folderName);
        const dir = await root.getDirectoryHandle(folderName, { create: true });
        cache.set(folderName, dir);
        return dir;
    }

    async function exists(dir, name) {
        try { await dir.getFileHandle(name); return true; }
        catch (e) { return false; }
    }

    /** 目的地已經有同名檔案時，補上 _1 / _2 … */
    async function uniqueName(dir, name) {
        if (!(await exists(dir, name))) return name;
        const dot = name.lastIndexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : '';
        for (let i = 1; i < 1000; i++) {
            const candidate = `${base}_${i}${ext}`;
            if (!(await exists(dir, candidate))) return candidate;
        }
        return `${base}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    }

    async function copyFile(photo, destDir, targetName) {
        const file = await PMLibrary.getFile(photo);
        const fh = await destDir.getFileHandle(targetName, { create: true });
        const writable = await fh.createWritable();
        try {
            await writable.write(file);   // Blob 會以串流寫入，不會整份進記憶體
            await writable.close();
        } catch (e) {
            try { await writable.abort(); } catch (_) { }
            throw e;
        }
        return fh;
    }

    async function moveOne(photo, destDir) {
        const targetName = await uniqueName(destDir, photo.name);

        if (typeof photo.handle?.move === 'function') {
            try {
                await photo.handle.move(destDir, targetName);
                photo.parent = destDir;
                photo.name = targetName;
                return targetName;
            } catch (e) {
                console.warn('handle.move() 失敗，改用複製後刪除：', photo.name, e);
            }
        }

        await copyFile(photo, destDir, targetName);
        if (photo.parent) await photo.parent.removeEntry(photo.name);
        photo.parent = destDir;
        photo.name = targetName;
        photo.handle = await destDir.getFileHandle(targetName);
        return targetName;
    }

    async function copyOne(photo, destDir) {
        const targetName = await uniqueName(destDir, photo.name);
        await copyFile(photo, destDir, targetName);
        return targetName;
    }

    /**
     * 計畫摘要：整理前先讓使用者看清楚會發生什麼事。
     * @returns {{items:Array, byFolder:Array, total:number}}
     */
    function plan(photos) {
        const byFolder = new Map();
        const items = [];
        photos.forEach(photo => {
            if (!photo.catId || photo.organized) return;
            const cat = PMCategories.byId(photo.catId);
            if (!cat || cat.action === 'keep') return;
            const folder = cat.folder || cat.name;
            // 已經在目標資料夾裡就不用動
            const currentFolder = photo.relPath.includes('/') ? photo.relPath.slice(0, photo.relPath.lastIndexOf('/')) : '';
            if (currentFolder === folder) return;
            items.push({ photo, cat, folder });
            const bucket = byFolder.get(folder) || { folder, action: cat.action, count: 0 };
            bucket.count++;
            byFolder.set(folder, bucket);
        });
        return { items, byFolder: [...byFolder.values()], total: items.length };
    }

    /**
     * 執行整理。
     * @param {Array} items plan().items
     * @param {(done:number,total:number,label:string)=>void} onProgress
     */
    async function run(items, onProgress) {
        const root = PMLibrary.rootHandle;
        if (!root) throw new Error('目前不是資料夾模式，無法直接整理檔案。');

        const cache = new Map();
        const result = { moved: 0, copied: 0, failed: [] };

        for (let i = 0; i < items.length; i++) {
            const { photo, cat, folder } = items[i];
            if (onProgress) onProgress(i, items.length, photo.name);
            try {
                const destDir = await getDestDir(root, folder, cache);
                if (cat.action === 'copy') {
                    await copyOne(photo, destDir);
                    photo.organized = { folder, action: 'copy' };
                    result.copied++;
                } else {
                    const newName = await moveOne(photo, destDir);
                    photo.relPath = folder + '/' + newName;
                    photo.organized = { folder, action: 'move' };
                    result.moved++;
                }
            } catch (e) {
                console.error('整理失敗：', photo.name, e);
                result.failed.push({ name: photo.name, message: e && e.message ? e.message : String(e) });
            }
        }
        if (onProgress) onProgress(items.length, items.length, '');
        return result;
    }

    return { plan, run };
})();
