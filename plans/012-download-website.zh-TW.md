# 012 官方網站與 DMG 下載

[English](012-download-website.md) | [繁體中文](012-download-website.zh-TW.md)

狀態：階段 1–3 完成，階段 4–5 的程式碼與文件部分已於 2026-09-20 完成（未提交）。維護者選定版本 A，B 與 C 已刪除。剩餘：維護者的 Vercel 專案與 secrets、第一次部署、上線驗證（階段 4.5）、把正式網址加入 README、repository About 與發行說明 help 連結，然後結案。本版在檢視 [T3 Code](https://github.com/pingdotgg/t3code) 官網（`apps/marketing`，MIT 授權）的建置與部署方式後，取代 2026-09-19 的舊計畫。

實作備註（與下文的差異）：比較期間三個版本放在 `src/pages/a|b|c/`，根目錄為比較索引（沒有 `SITE_VARIANT` 切換）；現在版本 A 已佔據站根，其餘已刪除。`deploy-website` job 使用 `vercel pull`／`build`／`deploy --prebuilt --prod`，讓 CI 測過的建置就是上線的內容。`astro check` 需要 TypeScript 6.x（TS 7 原生編譯器缺少 language-server API），所以網站套件如 T3 Code 一樣釘 `typescript ~6.0.3`；App 維持 TS 7。截圖改用 `puppeteer-core` 驅動已安裝的 Chrome，因為 headless Chrome 的命令列有約 500 px 的最小視窗限制。產品視覺是內嵌的動畫 SVG 場景（`src/components/DesktopScene.astro`）而非截圖；維護者接受它作為首頁主視覺，社群預覽圖由 `pnpm site:screenshots` 從它渲染。第二輪設計（2026-09-20）比較 Ember／Paper／Aurora，選定 Ember，其餘刪除。第三、四輪（同日）在 `/preview/` 比較三種地景風格並改為石墨中性配色；維護者選擇 Facet，`/preview/` 與其他地景已刪除，鏡頭推近重新定錨並放慢。

## 目標

建立一個仿照 T3 Code 官網設計的英文 RecordStuff 網站：介紹產品、提供醒目的目前已驗版本 DMG 直接下載，並承載安裝、操作、更新與移除指引。公開下載宣稱必須與已發布的 release metadata 完全一致。不需要 App 更新器、後端或自訂網域；網站之後會提供 [018](018-app-update.zh-TW.md) 要讀取的版本 feed。

## 本版已定的決策

| 項目 | 決策 | 理由 |
| --- | --- | --- |
| Repo 結構 | 只新增一個頂層目錄 `website/`，有自己的 `package.json`。不改成 monorepo、不搬進 `apps/`、不加 workspace 檔；Electron App、scripts、docs、plans 全部維持原位。根目錄 `package.json` 新增 `site:*` scripts，以 `pnpm --dir website` 轉呼叫。 | T3 Code 的 `apps/marketing` 在 monorepo 裡是因為它有五個 app。RecordStuff 只有一個 App 加一個網站，用同層目錄就夠，且根目錄 `pnpm check` 不變。 |
| 框架 | Astro 靜態網站，不用 UI 框架，TypeScript。 | 與 T3 Code 相同；純靜態輸出、內建圖片最佳化。 |
| 設計 | 重現 T3 Code 官網的設計語言：深色 zinc 配色（背景 `#09090b`、前景 `#fafafa`、灰階 muted）、`oklch` 強調色、自行託管的 DM Sans 與 JetBrains Mono（皆為 SIL OFL）、fractal-noise 全頁疊層、捲動後出現邊線的細窄固定導覽列、eyebrow／display 字級、圓角下載卡與 hover 上浮、錯落 rise-in 動畫並在 `prefers-reduced-motion` 下停用。CSS 結構沿用其 `Layout.astro` 與 `download.astro`。不使用 T3 Code 的圖示、截圖、文案、統計數字、Discord／App Store 連結與品牌名稱。 | 維護者要求；MIT 授權允許改作程式碼，並在 `website/THIRD_PARTY.md` 保留聲明。 |
| 語言 | 只有英文。沒有 `/zh-TW/` 路由與語言切換。`<html lang="en">`。 | 維護者決定。Repo 文件與 App UI 維持雙語；本計畫檔依 repo 慣例仍保留翻譯。 |
| Hosting | Vercel。維護者自行在 Vercel 平台建立與設定專案（根目錄 `website/`、關閉 Git 部署、secrets）。程式碼端提供 `website/vercel.ts`、`website/dist` 建置輸出，以及一個 secrets 不存在時自動略過的選用 CI 部署 job。 | 維護者將自行處理平台設定；GitHub Pages 已排除。 |
| 版本資料 | 建置時使用已提交的 `website/release-manifest.json`，由公開 release 的 `release.json` 與 `SHA256SUMS` 產生並與 GitHub asset 清單交叉核對。見下方「為何不用瀏覽器端 GitHub API」。 | 計畫要求顯示大小、SHA-256 與日期，且禁止把未驗資料標成最新。 |
| Fallback | 所有下載控制項預設連到 GitHub Releases 頁，只有 manifest 在建置時驗證通過才升級成直接下載連結。 | T3 Code 的作法；保證不會出現壞掉的下載按鈕。 |
| 安裝檔來源 | 只用 GitHub Releases，網站不鏡射任何檔案。 | 不變。 |
| 選定流程 | 在同一份內容／資料／樣式層上做三個版本，維護者在本機比較後選定一個，之後才部署。 | 維護者要求。 |

### 為何不用瀏覽器端 GitHub API

T3 Code 的下載頁出廠時所有連結都指向 Releases 頁；訪客打開頁面後，瀏覽器內的 JavaScript 會呼叫 `https://api.github.com/repos/pingdotgg/t3code/releases/latest`，再把每張卡片的 `href` 改成對應的 asset。好處：發新版不用重新部署網站，nightly 幾分鐘內就出現。代價：未驗證的 GitHub API 每個訪客 IP 每小時只有 60 次，共用網路的訪客會看到 fallback；頁面只能顯示 API 回傳的東西（tag 名稱與 asset URL），無法顯示經驗證的大小、SHA-256 或日期；而且 GitHub 目前標記為「latest」的任何版本都會直接顯示，即使維護者從未在網站上核對過。

RecordStuff 的發布 workflow 已在每次穩定 tag 後把 release 事實提交到 `main`，並可在同一個 run 內重新部署網站，所以重新部署的成本為零。建置時 manifest 讓頁面能陳述已對照公開 asset 驗證的大小、雜湊與日期，離線與速率限制下都能運作，也不會宣傳 workflow 未驗證的版本。若維護者偏好 T3 Code 的行為，改動只限 `src/lib/release.ts` 加一段小型 client script；manifest 仍作為建置時 fallback。預設為只用建置時資料。

## 階段 0：維護者提供的輸入

1. 產品視覺素材：選單列截圖（閒置與錄影中、淺色與深色選單列）及一張存檔／Finder 畫面，不含私人內容。代理可在確認沒有錄影進行中後，從執行中的 App 擷取；否則由維護者提供。存放於 `website/src/assets/`。
2. Vercel 專案，在階段 4 前任何方便的時間：在 Vercel 平台建立，根目錄 `website/`、框架 Astro、關閉 Git 部署；若要 CI 部署，再把 `VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` 加為 repository secrets。階段 1–3 不依賴此項。

## 階段 1：共用底層

```
website/
  package.json            astro、@astrojs/check、sharp、typescript；scripts dev/build/preview/check
  astro.config.mjs        site URL 為 https://record.ericts.com（維護者網域），預覽時可用 SITE_URL 覆寫
  vercel.ts               @vercel/config：git.deploymentEnabled false、outputDirectory "dist"
  THIRD_PARTY.md          改作版面／CSS 的 T3 Code MIT 聲明；DM Sans 與 JetBrains Mono 的 OFL 聲明
  release-manifest.json   由腳本產生；見下文
  scripts/manifest.mts    generate | verify [--offline]
  src/content/site.ts     產品文案、功能列表、說明步驟、支援事實、repository 連結
  src/lib/release.ts      建置時讀取 manifest；提供型別化資料與 fallback 連結
  src/styles/fonts.css    自行託管 DM Sans 與 JetBrains Mono 子集的 @font-face
  src/styles/global.css   改作自 T3 Code Layout.astro 的 token 與基礎規則
  src/layouts/Layout.astro  meta、OpenGraph 圖、canonical、skip link、導覽、頁尾、捲動 script
  src/components/         BrandMark、DesktopScene（動畫首頁場景）、DownloadCard、ChecksumBlock、StepList、Section、HelpContent、SupportContent、heroes/EmberHero、pages/{HomeBody,DownloadBody,TextPage}
  src/pages/              index.astro、download.astro、help.astro、support.astro
  src/assets/             og.png（由 site:screenshots 從首頁場景渲染）
  public/                 由 build/icon.png 產生的 favicon 組、robots.txt、字型授權文字
```

`scripts/manifest.mts`：

- `generate vX.Y.Z` 從公開 release 下載 `release.json` 與 `SHA256SUMS`，確認該 release 非草稿、非 prerelease，確認恰有三個預期 asset 且名稱與大小相符，然後寫入 `release-manifest.json`：版本、tag、來源 commit、發布日期、架構（`arm64`）、DMG 檔名、位元組大小、SHA-256、DMG 直接連結、SHA256SUMS 連結、release 頁連結、發行說明連結與 `verifiedAt`。
- `verify` 重新抓取 release metadata，若任一欄位改變、tag 不存在，或 DMG 連結對 HEAD 請求不回 `200`／`302`，即失敗。Astro build 先跑 `verify`，失敗就停止而不是發布過期資料。`--offline` 在本機設計時略過網路，並在頁尾標示「manifest 未重新驗證」。

`src/content/site.ts` 的內容規則：只寫 README、[INSTALL.zh-TW.md](../resources/INSTALL.zh-TW.md)、[桌面設計](../docs/zh-TW/system-design/desktop.md)與[驗證紀錄](../docs/zh-TW/verification/README.md)已記載的事實。不宣稱公證、無安全提示、自動更新、Intel／Windows／Linux 支援或任何未驗行為。仍成立的限制（例如自簽身分提示）在適當處直接說明；獨立的「已知限制」清單已於 2026-09-20 依維護者要求移除，因為其中的 Finder 項目已修復，更新項目則改由計畫 018 處理。只提供 macOS Apple silicon；不放灰掉的平台卡。

所有版本共用的無障礙基準：語意化 landmark、可見焦點框、鍵盤可達的下載控制項與展開區塊、所有轉場尊重 `prefers-reduced-motion`、320 px 寬可讀、字型以 `font-display: swap` 載入並如 T3 Code 預先載入。

## 階段 2：三個版本與比較

三個版本共用階段 1 的 token、字型、導覽、頁尾、元件與內容，只在頁面結構與追隨 T3 Code 頁面組合的程度上不同。每個版本位於 `website/variants/<a|b|c>/pages` 加一份版本樣式表，以 `SITE_VARIANT=a pnpm site:dev` 選擇。選定前 `variants/` 不提交到 main。

| 版本 | 方向 | 結構 | 待評估的取捨 |
| --- | --- | --- | --- |
| A | 最接近 T3 Code | `/` 首頁含 hero、截圖與功能格；`/download` 卡片清單與版本行；`/help` 與 `/support` 沿用法律頁版面的文字頁 | 看過 t3.codes 的人最熟悉；四頁要維護 |
| B | T3 Code 風格的單頁 | Hero 內嵌下載卡、功能、說明用 `<details>` 區塊、支援與 checksum 在頁尾區 | 一頁、最快到按鈕、捲動長 |
| C | 下載優先 | `/` 就是下載頁（T3 Code 下載版面，卡片下方加版本／大小／雜湊區塊與一段「它做什麼」）；`/help` 合併說明與支援 | 產品故事次要；表面最小 |

比較交付物，在選定前產出：

1. 本機索引 `http://localhost:4173/compare/`，連到每個版本與頁面。
2. 每版截圖矩陣：每頁桌機 1440 px 與手機 390 px（僅深色，與 T3 Code 相同），從本機伺服器擷取。
3. 簡短書面比較：每次發布需維護的頁數、CSS 大小、鍵盤 tab 順序、Lighthouse 無障礙分數，以及放不進去的內容。
4. 維護者選定一版，可附調整要求。這是唯一的阻斷決策。

## 階段 3：完成選定版本

1. 把選定版本的頁面／樣式移入 `website/src/`，刪除 `website/variants/`，並在[桌面設計](../docs/zh-TW/system-design/desktop.md)新增「官方網站」一節（含翻譯）記錄選擇與理由。
2. 完成內容：首頁；下載（版本、架構、檔名、大小、日期、DMG 直接連結、SHA256SUMS、發行說明、舊版 → Releases 頁）；說明（拖入 Applications、仍要打開、螢幕／系統音訊權限與重啟、快捷鍵與語言設定、手動替換更新、結束後移到垃圾桶、保留哪些資料）；支援（已驗平台邊界、原始碼、問題回報、隱私／儲存事實）。
3. 執行 `pnpm site:check`（astro check、manifest verify、產出內部錨點與外部 URL 連結檢查）與鍵盤操作走查。執行根目錄 `pnpm check` 證明 App 不受影響。

## 階段 4：程式碼端的部署掛鉤

1. `website/vercel.ts` 關閉 Git 部署並設定輸出目錄，與 T3 Code 相同。第一次正式部署由維護者從 Vercel 後台或在自己機器上執行 `vercel deploy --prod`。得知網址後，代理將其寫入 `SITE_URL` 與文件。
2. 在 [release.yml](../.github/workflows/release.yml) 新增 `deploy-website` job：`needs: record`、僅限穩定 tag、`contents: read`，並以 `if` 守衛，未設定 `VERCEL_TOKEN` 時略過並印出提示。它在 record commit 之後 checkout `main`，對該 tag 執行 `manifest.mts generate`，與 `verify` 不一致即失敗，然後建置、以 `vercel deploy --prod --yes` 部署，並把部署網址印到 job summary。它絕不修改 release。
3. 另新增 `workflow_dispatch` 輸入 `deploy-website=true`，讓純內容修改可以不發版重新部署。一般推送 main 永不部署。
4. 擴充 `record` job 執行 `manifest.mts generate`，並把 `website/release-manifest.json` 放進其既有的 release 事實 commit，使 `main` 永遠指向最新已驗版本。
5. 上線網站驗證，記錄於[驗證紀錄](../docs/zh-TW/verification/README.md)並附翻譯：私密視窗確認 HTTPS 與公開存取；桌機與手機版面；純鍵盤操作；所有內外部連結；透過網站按鈕下載 DMG 並以 `shasum -a 256` 比對已發布的 SHA256SUMS；記錄 quarantine／Gatekeeper 提示與乾淨安裝時「仍要打開」的結果。按鈕有畫出來不等於下載通過。

## 階段 5：文件與結案

1. 工具文件：專案網址、`site:*` scripts、manifest 維護、維護者選定的 Vercel 設定與 CI 部署 job 寫入[工具](../docs/zh-TW/system-design/tooling.md)；發布時的官網步驟寫入[發布自動化](../docs/zh-TW/system-design/releases.md)；皆含翻譯。
2. 把正式網址加到雙語 README 下載區塊附近、GitHub repository About／homepage 欄位，以及 `scripts/release.mts` 發行說明的 help 連結。README 保留 GitHub 下載連結，網站失效時仍可下載。
3. 更新 [plans/README.md](README.zh-TW.md) 與翻譯，然後依完成規則移除本計畫及其翻譯。

## 驗收

- 公開網址以 HTTPS 載入，沒有 placeholder 文字、壞連結或假的平台按鈕。
- 主按鈕下載 manifest 所列的 DMG；其 SHA-256 等於已發布的 SHA256SUMS；頁面上的大小與日期與 GitHub 一致。
- 一次穩定 tag 推送，在同一個 workflow run 內產出 release、含 manifest 的 record commit，以及（secrets 存在時）重新部署的網站。
- manifest 驗證失敗時建置失敗、前一次部署維持上線；任何情況都不會呈現未驗的「最新」。
- 純鍵盤可到達每個下載控制項與每個說明區塊。

## 排除

不做帳號系統、後端、付款、分析、安裝檔鏡射、購買網域、App 更新器、nightly 通道、Intel／Windows／Linux 版本、Apple 公證或第二語言。瀏覽器端 GitHub API 輪詢不是預設（見上文）。未選定的版本刪除，不保留。Vercel 平台設定屬維護者工作，不在程式碼工作範圍內。

## 指令（執行時參考）

```bash
# 階段 1
pnpm --dir website install
pnpm site:manifest generate v0.1.2      # 寫入 website/release-manifest.json
pnpm site:check

# 階段 2
SITE_VARIANT=a pnpm site:dev            # b、c 相同；/compare/ 列出全部

# 階段 4（維護者，Vercel 專案建立後可選的本機部署）
npx vercel@59.23.2 pull --yes --environment=production
npx vercel@59.23.2 build --prod
node website/scripts/check-links.mts --dir .vercel/output/static --offline
npx vercel@59.23.2 deploy --prebuilt --prod --yes
```
