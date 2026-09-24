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

    /* ---------- 2b. 完整檢視用: 標籤名稱與 GPS ---------- */
    /**
     * 標籤編號 → 名稱。給「完整資訊」裡的 Raw EXIF 用的,
     * 查不到的就照原樣顯示成 0x____ —— 相機廠商的私有欄位本來就沒有公開名字。
     */
    const TAG_NAMES = {
        ifd0: {
            0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample',
            0x0103: 'Compression', 0x0106: 'PhotometricInterpretation',
            0x010E: 'ImageDescription', 0x010F: 'Make', 0x0110: 'Model',
            0x0112: 'Orientation', 0x011A: 'XResolution', 0x011B: 'YResolution',
            0x0128: 'ResolutionUnit', 0x0131: 'Software', 0x0132: 'DateTime',
            0x013B: 'Artist', 0x0213: 'YCbCrPositioning', 0x8298: 'Copyright',
            0x8769: 'ExifIFDPointer', 0x8825: 'GPSInfoIFDPointer',
        },
        exif: {
            0x829A: 'ExposureTime', 0x829D: 'FNumber', 0x8822: 'ExposureProgram',
            0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType', 0x8832: 'RecommendedExposureIndex',
            0x9000: 'ExifVersion', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized',
            0x9010: 'OffsetTime', 0x9011: 'OffsetTimeOriginal',
            0x9101: 'ComponentsConfiguration', 0x9102: 'CompressedBitsPerPixel',
            0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9203: 'BrightnessValue',
            0x9204: 'ExposureBiasValue', 0x9205: 'MaxApertureValue', 0x9206: 'SubjectDistance',
            0x9207: 'MeteringMode', 0x9208: 'LightSource', 0x9209: 'Flash',
            0x920A: 'FocalLength', 0x927C: 'MakerNote', 0x9286: 'UserComment',
            0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized',
            0xA000: 'FlashpixVersion', 0xA001: 'ColorSpace',
            0xA002: 'PixelXDimension', 0xA003: 'PixelYDimension',
            0xA20E: 'FocalPlaneXResolution', 0xA20F: 'FocalPlaneYResolution',
            0xA210: 'FocalPlaneResolutionUnit', 0xA217: 'SensingMethod',
            0xA300: 'FileSource', 0xA301: 'SceneType', 0xA401: 'CustomRendered',
            0xA402: 'ExposureMode', 0xA403: 'WhiteBalance', 0xA404: 'DigitalZoomRatio',
            0xA405: 'FocalLengthIn35mmFilm', 0xA406: 'SceneCaptureType',
            0xA407: 'GainControl', 0xA408: 'Contrast', 0xA409: 'Saturation',
            0xA40A: 'Sharpness', 0xA40C: 'SubjectDistanceRange', 0xA420: 'ImageUniqueID',
            0xA430: 'CameraOwnerName', 0xA431: 'BodySerialNumber',
            0xA432: 'LensSpecification', 0xA433: 'LensMake', 0xA434: 'LensModel',
            0xA435: 'LensSerialNumber',
        },
        gps: {
            0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
            0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef',
            0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x0008: 'GPSSatellites',
            0x0009: 'GPSStatus', 0x000A: 'GPSMeasureMode', 0x000B: 'GPSDOP',
            0x000C: 'GPSSpeedRef', 0x000D: 'GPSSpeed', 0x0010: 'GPSImgDirectionRef',
            0x0011: 'GPSImgDirection', 0x0012: 'GPSMapDatum', 0x001D: 'GPSDateStamp',
        },
    };

    /** 度／分／秒 → 十進位度數。 */
    function dmsToDegrees(dms, ref) {
        if (!Array.isArray(dms) || dms.length < 3) return null;
        const d = dms[0], m = dms[1], sec = dms[2];
        if (d == null || m == null || sec == null) return null;
        const value = Math.abs(d) + Math.abs(m) / 60 + Math.abs(sec) / 3600;
        const negative = ref === 'S' || ref === 'W';
        return negative ? -value : value;
    }

    function parseGps(gpsIfd) {
        if (!gpsIfd) return null;
        const g = (id) => gpsIfd.tags.has(id) ? gpsIfd.tags.get(id).value : null;
        const latRef = g(0x0001);
        const lonRef = g(0x0003);
        const lat = dmsToDegrees(g(0x0002), latRef);
        const lon = dmsToDegrees(g(0x0004), lonRef);
        if (lat == null || lon == null) return null;
        const altRaw = g(0x0006);
        return {
            latitude: lat,
            longitude: lon,
            latitudeRef: latRef || (lat >= 0 ? 'N' : 'S'),
            longitudeRef: lonRef || (lon >= 0 ? 'E' : 'W'),
            altitude: altRaw == null ? null : (g(0x0005) === 1 ? -altRaw : altRaw),
        };
    }

    /** 把一個 IFD 攤平成「名稱 + 看得懂的值」, 給 Raw EXIF 那一段用。 */
    function dumpIFD(ifd, kind) {
        if (!ifd) return [];
        const names = TAG_NAMES[kind] || {};
        const rows = [];
        ifd.tags.forEach((entry, id) => {
            let value = entry.value;
            if (value && typeof value === 'object' && Array.isArray(value.raw)) {
                // 未定義型別（7）就只說有多長: 把幾千個位元組印出來沒有意義。
                value = '<' + value.raw.length + ' bytes>';
            } else if (Array.isArray(value)) {
                value = value.length > 16
                    ? value.slice(0, 16).join(', ') + '\u2026'
                    : value.join(', ');
            }
            rows.push({
                id: id,
                tag: '0x' + id.toString(16).toUpperCase().padStart(4, '0'),
                name: names[id] || null,
                value: value == null ? '' : String(value),
            });
        });
        return rows.sort((a, b) => a.id - b.id);
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

            // 像素尺寸: EXIF 自己就有, 不必把整張圖解出來才知道多大。
            info.width = g(0xA002) ?? get(ifd0, 0x0100) ?? null;
            info.height = g(0xA003) ?? get(ifd0, 0x0101) ?? null;

            if (exifIfd.tags.has(0x927C)) makerNoteEntry = exifIfd.tags.get(0x927C);
        }

        let gpsIfd = null;
        if (ifd0.tags.has(0x8825)) {
            try {
                const gpsOffset = tiffStart + dv.getUint32(ifd0.tags.get(0x8825).valueOffsetPos, little);
                gpsIfd = readIFD(dv, gpsOffset, tiffStart, little);
            } catch (e) { gpsIfd = null; }
        }
        info.gps = parseGps(gpsIfd);

        return { info, makerNoteEntry, exifIfd, gpsIfd, ifd0, ifd0Next: ifd0.next };
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

    /* ---------- 4. HEIF / HEIC 容器 ---------- */
    //
    // HEIC 不是 JPEG, 沒有 APP1 區段。它是 ISOBMFF（跟 MP4 同一種盒狀結構）:
    //
    //   ftyp                        檔案型別, brand 認得出是不是 HEIF
    //   meta                        中繼資料
    //     ├ iinf → infe             每個項目的編號與型別, 其中一個 type 是 "Exif"
    //     └ iloc                    每個項目在檔案裡的位置與長度
    //   mdat                        真正的資料（影像與那塊 Exif）
    //
    // 找到 Exif 那一項的位置之後, 裡面裝的就是一般的 TIFF 結構,
    // 後面直接交給上面那套 IFD 解析, 不必重寫一份。

    const HEIF_BRANDS = new Set([
        'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
        'mif1', 'msf1', 'heif', 'avif', 'avis',
    ]);

    function isHeifHeader(dv) {
        if (dv.byteLength < 12) return false;
        if (readString(dv, 4, 4) !== 'ftyp') return false;
        if (HEIF_BRANDS.has(readString(dv, 8, 4).toLowerCase())) return true;
        // 相容品牌列在主 brand 後面, 有些機器的主 brand 不在上面那張表裡。
        const size = dv.getUint32(0);
        for (let at = 16; at + 4 <= Math.min(size, dv.byteLength); at += 4) {
            if (HEIF_BRANDS.has(readString(dv, at, 4).toLowerCase())) return true;
        }
        return false;
    }

    /** 走訪某個範圍裡的盒子, 回呼拿到 (型別, 內容起點, 內容長度)。回 false 就停。 */
    function walkBoxes(dv, from, to, visit) {
        let at = from;
        while (at + 8 <= to) {
            let size = dv.getUint32(at);
            const type = readString(dv, at + 4, 4);
            let head = 8;
            if (size === 1) {
                // 64 位元長度。這裡不會大到需要高 32 位元, 直接讀低位那半。
                if (at + 16 > to) break;
                size = dv.getUint32(at + 12);
                head = 16;
            } else if (size === 0) {
                size = to - at;
            }
            if (size < head || at + size > to) break;
            if (visit(type, at + head, size - head) === false) return;
            at += size;
        }
    }

    /** iinf: 找出 item_type 是 "Exif" 的那一項的編號。 */
    function findExifItemId(dv, from, len) {
        let itemId = null;
        const version = dv.getUint8(from);
        // FullBox: 1 byte version + 3 bytes flags, 接著是項目數（v0 是 16 位元, 之後 32 位元）。
        const at = from + 4 + (version === 0 ? 2 : 4);
        walkBoxes(dv, at, from + len, (type, body) => {
            if (type !== 'infe') return;
            const v = dv.getUint8(body);
            if (v < 2) return;
            const id = v === 2 ? dv.getUint16(body + 4) : dv.getUint32(body + 4);
            const itemType = readString(dv, body + (v === 2 ? 8 : 10), 4);
            if (itemType === 'Exif') itemId = id;
        });
        return itemId;
    }

    /** iloc: 這一項在檔案裡的位置與長度。只處理最常見的 construction_method 0。 */
    function findItemLocation(dv, from, len, wantedId) {
        const version = dv.getUint8(from);
        let at = from + 4;
        const sizes = dv.getUint8(at);
        const offsetSize = sizes >> 4;
        const lengthSize = sizes & 0xF;
        const sizes2 = dv.getUint8(at + 1);
        const baseOffsetSize = sizes2 >> 4;
        const indexSize = version >= 1 ? (sizes2 & 0xF) : 0;
        at += 2;
        const count = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
        at += version < 2 ? 2 : 4;

        const readInt = (pos, bytes) => {
            if (bytes === 4) return dv.getUint32(pos);
            if (bytes === 8) return dv.getUint32(pos) * 4294967296 + dv.getUint32(pos + 4);
            if (bytes === 2) return dv.getUint16(pos);
            return 0;
        };

        for (let i = 0; i < count && at < from + len; i++) {
            const id = version < 2 ? dv.getUint16(at) : dv.getUint32(at);
            at += version < 2 ? 2 : 4;
            if (version >= 1) at += 2;                 // construction_method
            at += 2;                                   // data_reference_index
            const baseOffset = readInt(at, baseOffsetSize);
            at += baseOffsetSize;
            const extentCount = dv.getUint16(at);
            at += 2;
            for (let e = 0; e < extentCount; e++) {
                at += indexSize;
                const offset = readInt(at, offsetSize);
                at += offsetSize;
                const length = readInt(at, lengthSize);
                at += lengthSize;
                if (id === wantedId && e === 0) return { offset: baseOffset + offset, length };
            }
        }
        return null;
    }

    /** 從 HEIF 的檔頭找出 Exif 那一塊在檔案裡的位置。 */
    function locateHeifExif(dv) {
        let found = null;
        walkBoxes(dv, 0, dv.byteLength, (type, body, size) => {
            if (type !== 'meta') return;
            let itemId = null;
            let iloc = null;
            // meta 是 FullBox, 前 4 個位元組是 version + flags。
            walkBoxes(dv, body + 4, body + size, (t, b, l) => {
                if (t === 'iinf') itemId = findExifItemId(dv, b, l);
                else if (t === 'iloc') iloc = { body: b, len: l };
            });
            if (itemId != null && iloc) found = findItemLocation(dv, iloc.body, iloc.len, itemId);
            return false;   // meta 只有一個, 找完就不必再走
        });
        return found;
    }

    /* ---------- 5. 解析入口 ---------- */
    const HEADER_READ_BYTES = 262144; // 256KB

    /** 這個位置是不是 TIFF 檔頭: "II" + 42 或 "MM" + 42。 */
    function isTiffHeader(dv, at) {
        if (at < 0 || at + 4 > dv.byteLength) return false;
        const bom = dv.getUint16(at);
        if (bom === 0x4949) return dv.getUint16(at + 2, true) === 42;
        if (bom === 0x4D4D) return dv.getUint16(at + 2) === 42;
        return false;
    }

    /** JPEG: 找出 APP1 裡那段 Exif 的起點。 */
    function findJpegExif(dv) {
        let offset = 2;
        while (offset < dv.byteLength - 4) {
            const marker = dv.getUint16(offset);
            if ((marker & 0xFF00) !== 0xFF00) break;
            const size = dv.getUint16(offset + 2);
            if (marker === 0xFFE1) {
                const tag = readString(dv, offset + 4, 6);
                if (tag.indexOf("Exif") === 0) return offset + 4;
            }
            if (marker === 0xFFDA) break;
            offset += 2 + size;
        }
        return null;
    }

    /**
     * @param {File|Blob} file
     * @param {{wantThumb?:boolean}} [opts]
     * @returns {Promise<{info:Object|null, thumbBlob:Blob|null}>}
     */
    async function extractExif(file, opts) {
        const wantThumb = !opts || opts.wantThumb !== false;
        const headerBuf = await file.slice(0, HEADER_READ_BYTES).arrayBuffer();
        let dv = new DataView(headerBuf);
        if (dv.byteLength < 4) return { info: null, thumbBlob: null };

        // dv 的第 0 個位元組在原始檔案裡的位置。JPEG 是 0;
        // HEIC 的 Exif 藏在檔案中間, 會另外切一段出來讀, 所以要記住它從哪裡開始。
        let bufferBase = 0;
        let app1Offset = null;
        let container = 'jpeg';

        if (dv.getUint16(0) === 0xFFD8) {
            app1Offset = findJpegExif(dv);
        } else if (isHeifHeader(dv)) {
            container = 'heif';
            const at = locateHeifExif(dv);
            if (!at || !at.length) return { info: null, thumbBlob: null };
            const block = await file.slice(at.offset, at.offset + at.length).arrayBuffer();
            dv = new DataView(block);
            bufferBase = at.offset;
            if (dv.byteLength < 12) return { info: null, thumbBlob: null };
            //
            // ExifDataBlock: 4 個位元組的偏移量, 接著才是 Exif 內容。蘋果寫的是
            // 偏移 6 + "Exif\0\0" + TIFF, 但也有檔案直接接 TIFF, 所以三種都試:
            // 認的是 TIFF 檔頭的位元組順序標記（II 或 MM）, 不是前綴字串。
            //
            const skip = dv.getUint32(0);
            const tiffAt = [
                readString(dv, 4, 4) === 'Exif' ? 10 : null,   // 4 + "Exif\0\0"
                4 + skip,
                4,
                0,
            ].find((at) => at != null && isTiffHeader(dv, at));
            if (tiffAt == null) return { info: null, thumbBlob: null };
            app1Offset = tiffAt - 6;   // 下面會 +6 補回來
        }
        if (app1Offset === null) return { info: null, thumbBlob: null };

        const tiffStart = app1Offset + 6;
        if (tiffStart + 8 > dv.byteLength) return { info: null, thumbBlob: null };
        const little = dv.getUint16(tiffStart) === 0x4949;

        const { info, makerNoteEntry, exifIfd, gpsIfd, ifd0, ifd0Next } =
            parseStandardExif(dv, tiffStart, little);

        // Raw EXIF 只有「完整資訊」那個視窗要, 平常整批掃的時候不做 —— 一張照片
        // 幾百個欄位, 全部留在記憶體裡對幾千張的資料夾是不必要的負擔。
        if (opts && opts.wantRaw) {
            info.raw = {
                ifd0: dumpIFD(ifd0, 'ifd0'),
                exif: dumpIFD(exifIfd, 'exif'),
                gps: dumpIFD(gpsIfd, 'gps'),
            };
        }

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
                    const start = bufferBase + tiffStart + offEntry.value;
                    const buf = await file.slice(start, start + lenEntry.value).arrayBuffer();
                    if (buf.byteLength >= 2 && new DataView(buf).getUint16(0) === 0xFFD8) {
                        thumbBlob = new Blob([buf], { type: 'image/jpeg' });
                    }
                }
            } catch (e) { thumbBlob = null; }
        }

        if (info) info.container = container;
        return { info, thumbBlob };
    }

    /* ---------- 6. EXIF Orientation → CSS transform ---------- */
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
                // 交給外框決定能佔多高（預覽面板會自己撐滿剩下的空間）。
                img.style.maxHeight = '100%';
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
