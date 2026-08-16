# Photo Manager

瀏覽器裡的 EXIF 檢視 + 照片分類工具。**照片不會上傳，也不需要下載回來** —— 直接讀取本機資料夾，分類完成後就地把檔案搬進子資料夾。

## 使用方式

因為要用到 File System Access API，頁面必須從 `http://localhost` 或 `https://` 開啟（`file://` 不行）。

```bash
python -m http.server 8000
```

然後打開 <http://localhost:8000>。或直接部署到 GitHub Pages。

1. **開啟照片資料夾** → 選一個資料夾（瀏覽器會問你要不要給讀寫權限）
2. 到「整理分類」，用鍵盤 `1` `2` `3`… 標記，方向鍵切換，`⌫` 清除標記
3. 按「套用整理」→ 照片就在原資料夾底下被移進各分類資料夾

分類標記會存在瀏覽器裡（依資料夾名稱記憶），關掉重開不會不見。

### 相容模式

Safari / Firefox 不支援直接存取資料夾，這時會退回舊流程：選擇檔案 → 標記 → 打包成 `.zip` 下載。

## 自訂分類

分類定義在 [`categories.json`](categories.json)：

```json
{
  "categories": [
    { "key": "1", "name": "機器人特寫", "folder": "機器人特寫", "color": "#87d1ff", "action": "move" }
  ]
}
```

| 欄位 | 說明 |
| --- | --- |
| `key` | 鍵盤快捷鍵，單一字元 |
| `name` | 顯示名稱 |
| `folder` | 要移動到的資料夾名稱（留空則用 `name`） |
| `color` | 標籤顏色 HEX |
| `action` | `move` 移動 / `copy` 複製（原檔保留）/ `keep` 只標記不動檔案 |

在「分類設定」頁可以直接新增、刪除、改快捷鍵與顏色，設定會存進瀏覽器；也可以匯出 JSON 帶去別台電腦，或按「重設為預設」回到 `categories.json` 的內容。

## 檔案結構

| 檔案 | 用途 |
| --- | --- |
| `js/exif.js` | JPEG/TIFF EXIF 解析（含 Sony MakerNote 創意風格）、Orientation 修正 |
| `js/categories.js` | 分類設定的載入、儲存、匯入匯出 |
| `js/library.js` | 照片來源（資料夾／檔案）、EXIF 與縮圖的延遲載入與記憶體回收 |
| `js/organize.js` | 實際的檔案搬移／複製 |
| `js/app.js` | UI 與流程 |

## 效能筆記

- 只讀檔案開頭 256KB 解 EXIF，縮圖優先用相機內建的 EXIF 縮圖；沒有才用 `createImageBitmap` 縮到 480px。
- 一律使用 `objectURL`（不是 dataURL），縮圖與原圖各有 LRU 上限，超過就回收，幾千張照片也不會把記憶體吃爆。
- EXIF 與縮圖只在翻到那一頁時才讀。統計頁需要全部資料時，按「分析全部照片的 EXIF」再掃一次。
- 移動檔案優先用 `FileSystemFileHandle.move()`，同一個磁碟上是瞬間完成，不會真的複製資料。
