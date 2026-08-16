/* ============================================================
   exif.js — JPEG/TIFF EXIF 讀取（含 Sony MakerNote 創意風格）
   只讀檔案開頭 256KB，不會把整張原圖讀進記憶體。
   ============================================================ */
const PMExif = (function () {

    /* ---------- 1. 二進位 / TIFF 基礎工具 ---------- */
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
                case 2: return null; // 字串另外處理
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
        if (type === 2) return readString(dv, dataPos, count);
        if (type === 7) {
            const bytes = [];
            for (let i = 0; i < count; i++) bytes.push(dv.getUint8(dataPos + i));
            return { raw: bytes, offset: dataPos };
        }
        if (count === 1) return readOne(0);
        const arr = [];
        for (let i = 0; i < count; i++) arr.push(readOne(i));
        return arr;
    }

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

    /* ---------- 2. 標準 EXIF 判讀 ---------- */
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
    function fmtRational(v, digits) {
        return v == null ? null : (Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits));
    }

    function parseStandardExif(dv, tiffStart, little) {
        const ifd0 = readIFD(dv, tiffStart + dv.getUint32(tiffStart + 4, little), tiffStart, little);
        const info = { make: null, model: null, software: null, dateTime: null };
        const get = (map, id) => map.tags.has(id) ? map.tags.get(id).value : null;

        info.make = get(ifd0, 0x010F);
        info.model = get(ifd0, 0x0110);
        info.software = get(ifd0, 0x0131);
        info.dateTime = get(ifd0, 0x0132);
        info.orientation = get(ifd0, 0x0112);

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

            if (exifIfd.tags.has(0x927C)) makerNoteEntry = exifIfd.tags.get(0x927C);
        }
        return { info, makerNoteEntry, exifIfd, ifd0Next: ifd0.next };
    }

    /* ---------- 3. Sony MakerNote：Creative Style ---------- */
    const SONY_CREATIVE_STYLE_TAG = 0xb020;

    function parseSonyCreativeStyle(dv, mnAbsOffset, tiffStart, little) {
        let header = "";
        try { header = readString(dv, mnAbsOffset, 12); } catch (e) { }
        let ifdStart = mnAbsOffset;
        if (header.indexOf("SONY") === 0) ifdStart = mnAbsOffset + 12;
        let ifd;
        try { ifd = readIFD(dv, ifdStart, tiffStart, little); } catch (e) { return null; }
        if (!ifd.tags.has(SONY_CREATIVE_STYLE_TAG)) return null;
        const entry = ifd.tags.get(SONY_CREATIVE_STYLE_TAG);
        if (typeof entry.value !== 'string') return null;
        return entry.value.trim() || null;
    }

    /* ---------- 4. 解析入口 ---------- */
    const HEADER_READ_BYTES = 262144; // 256KB

    /**
     * @param {File|Blob} file
     * @param {{wantThumb?:boolean}} [opts]
     * @returns {Promise<{info:Object|null, thumbBlob:Blob|null}>}
     */
    async function extractExif(file, opts) {
        const wantThumb = !opts || opts.wantThumb !== false;
        const headerBuf = await file.slice(0, HEADER_READ_BYTES).arrayBuffer();
        const dv = new DataView(headerBuf);
        if (dv.byteLength < 4 || dv.getUint16(0) !== 0xFFD8) return { info: null, thumbBlob: null };

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
        if (app1Offset === null) return { info: null, thumbBlob: null };

        const tiffStart = app1Offset + 6;
        const little = dv.getUint16(tiffStart) === 0x4949;

        const { info, makerNoteEntry, ifd0Next } = parseStandardExif(dv, tiffStart, little);

        if (makerNoteEntry && info.make && info.make.toUpperCase().indexOf("SONY") !== -1) {
            const mnAbsOffset = makerNoteEntry.count > 4
                ? tiffStart + dv.getUint32(makerNoteEntry.valueOffsetPos, little)
                : makerNoteEntry.valueOffsetPos;
            try { info.creativeStyle = parseSonyCreativeStyle(dv, mnAbsOffset, tiffStart, little); }
            catch (e) { info.creativeStyle = null; }
        }

        // ---- 相機內建縮圖 (IFD1) ----
        let thumbBlob = null;
        if (wantThumb && ifd0Next) {
            try {
                const ifd1 = readIFD(dv, tiffStart + ifd0Next, tiffStart, little);
                const offEntry = ifd1.tags.get(0x0201);
                const lenEntry = ifd1.tags.get(0x0202);
                if (offEntry && lenEntry && typeof offEntry.value === 'number'
                    && typeof lenEntry.value === 'number' && lenEntry.value > 0) {
                    const start = tiffStart + offEntry.value;
                    const buf = await file.slice(start, start + lenEntry.value).arrayBuffer();
                    if (buf.byteLength >= 2 && new DataView(buf).getUint16(0) === 0xFFD8) {
                        thumbBlob = new Blob([buf], { type: 'image/jpeg' });
                    }
                }
            } catch (e) { thumbBlob = null; }
        }

        return { info, thumbBlob };
    }

    /* ---------- 5. EXIF Orientation → CSS transform ---------- */
    const ORIENTATION_TRANSFORM = {
        1: '', 2: 'scaleX(-1)', 3: 'rotate(180deg)', 4: 'scaleX(-1) rotate(180deg)',
        5: 'scaleX(-1) rotate(270deg)', 6: 'rotate(90deg)', 7: 'scaleX(-1) rotate(90deg)', 8: 'rotate(270deg)'
    };
    const ORIENTATION_SWAPS_AXES = new Set([5, 6, 7, 8]);

    /**
     * 縮圖：直接旋轉並微放大填滿方框。
     * 大圖預覽：旋轉 90/270 度時用 ResizeObserver 把圖片寬高與容器對調，避免超出邊界。
     */
    function applyOrientation(img, orientation, isPreview) {
        const o = orientation || 1;
        const needsAxisSwap = ORIENTATION_SWAPS_AXES.has(o);

        // 同一個 <img> 重複套用時，先收掉上一個 observer，避免疊加
        if (img._ro) { img._ro.disconnect(); img._ro = null; }

        if (isPreview) {
            img.style.transform = ORIENTATION_TRANSFORM[o] || '';
            if (needsAxisSwap) {
                img.style.maxWidth = 'none';
                img.style.maxHeight = 'none';
                const ro = new ResizeObserver(entries => {
                    for (const entry of entries) {
                        img.style.width = entry.contentRect.height + 'px';
                        img.style.height = entry.contentRect.width + 'px';
                    }
                });
                const parent = img.parentElement;
                if (parent) ro.observe(parent);
                img._ro = ro;
            } else {
                img.style.width = 'auto';
                img.style.height = 'auto';
                img.style.maxWidth = '100%';
                img.style.maxHeight = '64vh';
            }
        } else {
            img.style.transform = (ORIENTATION_TRANSFORM[o] || '') + (needsAxisSwap ? ' scale(1.35)' : '');
        }
    }

    return {
        extractExif,
        applyOrientation,
        fmtShutter,
        WHITE_BALANCE_STD,
    };
})();
