/* ============================================================
   categories.js — 照片分類設定
   ------------------------------------------------------------
   來源優先序：
     1. localStorage（使用者自訂，隨時可改）
     2. categories.json（專案預設；用 file:// 開啟時抓不到會自動略過）
     3. 內建 FALLBACK（保證一定有東西可用）
   每個分類有一個穩定的 id，照片記的是 id，所以之後改快捷鍵或名稱都不會弄丟已標記的照片。
   ============================================================ */
const PMCategories = (function () {

    const STORAGE_KEY = 'pm.categories.v2';
    const DEFAULT_URL = 'categories.json';
    const ACTIONS = ['move', 'copy', 'keep'];
    const ACTION_LABEL = { move: '移動', copy: '複製', keep: '只標記' };

    const FALLBACK = [
        { key: '1', name: '機器人特寫', folder: '機器人特寫', color: '#87d1ff', action: 'move' },
        { key: '2', name: '賽場動態', folder: '賽場動態', color: '#7dff95', action: 'move' },
        { key: '3', name: '團隊合照', folder: '團隊合照', color: '#ffbc5e', action: 'move' },
        { key: '4', name: '廢片', folder: '_廢片', color: '#ff8080', action: 'move' },
    ];

    const PALETTE = ['#87d1ff', '#7dff95', '#ffbc5e', '#ff8080', '#c9a3ff', '#5eead4', '#f0abfc', '#fde047', '#94a3b8'];

    let list = [];
    let defaults = null;
    const listeners = [];
    let idSeq = 0;

    /* ---------- 工具 ---------- */
    function newId() {
        idSeq++;
        return 'cat_' + idSeq.toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    }

    // Windows / macOS 都不能出現的字元，另外去掉結尾的點與空白
    function sanitizeFolder(name) {
        let s = String(name == null ? '' : name)
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/[\x00-\x1f]/g, '')
            .trim()
            .replace(/[. ]+$/, '');
        if (!s) s = '未命名';
        return s.slice(0, 80);
    }

    function normalizeOne(raw, index) {
        const src = raw && typeof raw === 'object' ? raw : {};
        const name = String(src.name || '').trim() || ('分類 ' + (index + 1));
        const key = String(src.key || '').trim().slice(0, 1);
        const action = ACTIONS.indexOf(src.action) >= 0 ? src.action : 'move';
        const color = /^#[0-9a-fA-F]{6}$/.test(src.color || '') ? src.color : PALETTE[index % PALETTE.length];
        return {
            id: typeof src.id === 'string' && src.id ? src.id : newId(),
            key,
            name,
            folder: sanitizeFolder(src.folder || name),
            color,
            action,
        };
    }

    function normalizeList(arr) {
        if (!Array.isArray(arr)) return [];
        const usedKeys = new Set();
        const usedIds = new Set();
        return arr.slice(0, 40).map((raw, i) => {
            const c = normalizeOne(raw, i);
            if (!c.key || usedKeys.has(c.key)) c.key = nextFreeKey(usedKeys);
            usedKeys.add(c.key);
            while (usedIds.has(c.id)) c.id = newId();
            usedIds.add(c.id);
            return c;
        });
    }

    const KEY_POOL = '123456789qwertyuiopasdfghjklzxcvbnm0';
    function nextFreeKey(used) {
        for (const ch of KEY_POOL) if (!used.has(ch)) return ch;
        return '';
    }

    function emit() { listeners.forEach(fn => { try { fn(list); } catch (e) { console.error(e); } }); }

    /* ---------- 載入 / 儲存 ---------- */
    async function loadDefaults() {
        if (defaults) return defaults;
        try {
            const res = await fetch(DEFAULT_URL, { cache: 'no-cache' });
            if (res.ok) {
                const json = await res.json();
                const parsed = normalizeList(json && json.categories);
                if (parsed.length) defaults = parsed;
            }
        } catch (e) {
            // file:// 或離線時會走到這裡，用內建預設即可
            console.info('讀取 categories.json 失敗，改用內建預設分類。', e.message);
        }
        if (!defaults) defaults = normalizeList(FALLBACK);
        return defaults;
    }

    async function init() {
        await loadDefaults();
        let saved = null;
        try {
            const txt = localStorage.getItem(STORAGE_KEY);
            if (txt) saved = JSON.parse(txt);
        } catch (e) { saved = null; }

        const savedList = saved && Array.isArray(saved.categories) ? normalizeList(saved.categories) : [];
        list = savedList.length ? savedList : defaults.map(c => ({ ...c }));
        emit();
        return list;
    }

    function save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, categories: list }));
        } catch (e) {
            console.warn('無法儲存分類設定：', e);
        }
        emit();
    }

    /* ---------- 讀取 ---------- */
    function all() { return list; }
    function byId(id) { return list.find(c => c.id === id) || null; }
    function byKey(key) {
        if (!key || key.length !== 1) return null;
        const k = key.toLowerCase();
        return list.find(c => c.key.toLowerCase() === k) || null;
    }
    function actionLabel(action) { return ACTION_LABEL[action] || action; }

    /* ---------- 編輯 ---------- */
    function add() {
        const used = new Set(list.map(c => c.key));
        const cat = normalizeOne({
            key: nextFreeKey(used),
            name: '新分類',
            color: PALETTE[list.length % PALETTE.length],
            action: 'move',
        }, list.length);
        list.push(cat);
        save();
        return cat;
    }

    function update(id, patch) {
        const cat = byId(id);
        if (!cat) return null;
        if ('key' in patch) {
            const k = String(patch.key || '').trim().slice(0, 1);
            // 快捷鍵不可重複，重複時把舊的那個清空
            if (k) list.forEach(c => { if (c !== cat && c.key.toLowerCase() === k.toLowerCase()) c.key = ''; });
            cat.key = k;
        }
        if ('name' in patch) cat.name = String(patch.name).slice(0, 60);
        if ('folder' in patch) cat.folder = sanitizeFolder(patch.folder || cat.name);
        if ('color' in patch && /^#[0-9a-fA-F]{6}$/.test(patch.color)) cat.color = patch.color;
        if ('action' in patch && ACTIONS.indexOf(patch.action) >= 0) cat.action = patch.action;
        save();
        return cat;
    }

    function move(id, delta) {
        const i = list.findIndex(c => c.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        const [c] = list.splice(i, 1);
        list.splice(j, 0, c);
        save();
    }

    function remove(id) {
        const i = list.findIndex(c => c.id === id);
        if (i < 0) return null;
        const [removed] = list.splice(i, 1);
        save();
        return removed;
    }

    async function reset() {
        await loadDefaults();
        list = defaults.map(c => ({ ...c, id: newId() }));
        save();
        return list;
    }

    /* ---------- JSON 匯入 / 匯出 ---------- */
    function toJSON() {
        return JSON.stringify({
            version: 2,
            categories: list.map(({ key, name, folder, color, action }) => ({ key, name, folder, color, action })),
        }, null, 2);
    }

    function importJSON(text) {
        let json;
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('不是合法的 JSON 檔案'); }
        const arr = Array.isArray(json) ? json : (json && json.categories);
        const parsed = normalizeList(arr);
        if (!parsed.length) throw new Error('JSON 裡找不到任何分類（需要 categories 陣列）');
        list = parsed;
        save();
        return list;
    }

    function onChange(fn) { listeners.push(fn); }

    return {
        init, save, all, byId, byKey, add, update, remove, move, reset,
        toJSON, importJSON, onChange, actionLabel, sanitizeFolder,
        ACTIONS, ACTION_LABEL,
    };
})();
