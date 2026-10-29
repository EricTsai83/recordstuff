# Learning articles

Standalone HTML articles that teach transferable design patterns, using this project as the worked example. They explain design rationale and its preconditions, not the current implementation: behavior is documented in [system design](../system-design/README.md), and unfinished work lives in [plans](../../plans/README.md). Articles are written in the language they were requested in and are generated with the `to-html` skill under `.agents/skills/`; run its highlight and validate scripts after editing.

# 學習文章

可獨立閱讀的 HTML 設計模式文章，以本專案為範例，說明可遷移到其他程式碼庫的設計判斷與前提。它們不是目前實作的規格：行為以[系統設計](../zh-TW/system-design/README.md)為準，未完成工作在[計畫](../../plans/README.zh-TW.md)。文章以撰寫時要求的語言寫成，由 `.agents/skills/` 下的 `to-html` skill 產生；修改後請執行該 skill 的 highlight 與 validate 腳本。

| 文章 | 主題 |
| --- | --- |
| [事件迴圈裡的磁碟工作：三個可遷移的設計模式](disk-work-in-an-event-loop.html) | 非同步 I/O 與執行緒的取捨、建立資源前先寫意圖紀錄、用 promise 鏈做有上限的並行；以計畫 036／037／038 的設計為例 |
| [錄影到底錄得好不好：螢幕錄影工具的品質量測入門](measuring-screen-recording-quality.html) | 錄影管線與基本名詞、固定測試素材、ffprobe／ffmpeg 量測、每個完整性與效能指標、五種判定狀態、音質診斷、為什麼 30／60 fps 與位元率等範圍表現不同、分層觀察與對照實驗、證據層級與精簡測試的原則；以計畫 030／041 與音質修正為例 |
| [打字不卡、清單跟得上：在 React 裡篩選本機清單時，該用 useDeferredValue 還是 debounce](deferred-search-in-react.html) | 先找出輸入驅動清單的成本在哪、同步篩選的失敗模式、debounce 的固定延遲與阻塞、useDeferredValue 的緊急／背景兩次 render 與 memo 前提、不適用的情況（I/O、純計算、DOM 過多、自己擁有 setState），以及清單短暫落後輸入時程式化聚焦的陷阱；以錄影檔分類搜尋為例 |
| [從瀏覽器 API 到作業系統 API：native 是什麼，什麼時候值得往下走](native-apis-and-tech-stack-choices.html) | 瀏覽器、runtime 與作業系統三層 API、native 呼叫慣例與 JavaScript 為何需要 runtime 幫忙、原生程式碼放在哪個 process、Swift／C++／Rust 的取捨、每條路的代價與其他產品的選擇、換框架何時值得、何時不該往下走；以計畫 076 把錄影從 Chromium 移到 Rust 引擎為例 |
| [開源授權實務：別人的程式碼能怎麼用，又如何決定你的架構](open-source-licenses-in-practice.html) | 基本概念與主要授權（MIT、Apache、LGPL、GPL、AGPL）、天真做法出錯的方式、授權如何限制架構與技術選擇（連結函式庫、另開 process、自己寫）、決策流程與不能直接套用的情況；以 MIT 授權的錄影 App 如何參考 AGPL 專案為例 |
| [編解碼器、容器與不怕當機的錄影：每一個選擇的取捨](codecs-containers-and-crash-safe-recording.html) | codec 與容器的分工、MP4 的 box 結構與為何索引最後才寫得完、一般／fragmented／hybrid MP4、硬體與軟體編碼器、自己寫 muxer 還是連結 FFmpeg、誰負責寫檔與停止／完成的分離；以計畫 076 的原生引擎為例 |
| [音訊時脈、混音與影音同步：每一個選擇的取捨](audio-clocks-mixing-and-av-sync.html) | 取樣率與時脈領域、從樣本數得出時間戳（buffer 時間戳、只數樣本、容許校正、自適應重取樣）、漂移的大小與量法、混音的增益／削波／up-mix 與等待遲到的輸入、語音處理（回音消除、降噪、自動增益）與 ducking、喇叭回音、一軌或分軌與麥克風中斷的取捨，以及 OBS、Chromium／WebRTC、Cap 等的選擇；以計畫 076 的原生引擎與計畫 074 的麥克風為例 |
| [開著的檔案擋住資料夾改名：Windows 與 macOS 的差異，以及有上限的重試](open-files-block-folder-rename.html) | POSIX 檔案描述子與 Windows handle、共用模式對上層資料夾的影響、Node.js／libuv 在兩個平台回報的錯誤碼、只在 Windows／只對暫時性錯誤碼／有上限的重試、與不重試及 graceful-fs 長時間重試的比較、不適用的情況；以錄影資料夾改名在 Windows CI 時好時壞為例 |
| [macOS 與 Windows 的螢幕擷取：內容過濾、系統音訊、排除視窗與權限的取捨](screen-capture-apis-on-macos-and-windows.html) | ScreenCaptureKit 的內容過濾與 Windows.Graphics.Capture、系統音訊與單一 App 的聲音（SCStream、Core Audio taps、WASAPI process loopback）、把自己的視窗與選單列、Dock 排除在錄影外、視窗保護為何失效與取代它的做法、螢幕錄影權限與重新啟動；以計畫 076／075 的原生引擎為例 |
| [媒體權限與隱私：桌面 App 何時、如何取用螢幕、麥克風與相機](media-permissions-and-privacy-in-desktop-apps.html) | macOS 的 TCC、使用說明與 entitlement、簽章身分與 bundle identifier、在使用者開啟功能時才詢問、敏感輸入預設關閉、被拒絕後的拒絕卡片與設定頁、執行中的 App 看不到新授權、系統指示器與及時關閉裝置、Windows 的隱私設定；以計畫 074／075／076 為例 |
| [在螢幕錄影裡放進攝影機：合成在哪裡、預覽怎麼送、形狀與鏡像的取捨](designing-a-camera-overlay.html) | 錄下浮動視窗、在錄影程式裡合成、分軌後再剪輯三種架構（Loom、OBS、Cap Studio）、在 GPU 上於編碼前合成（WGSL 轉 Metal／HLSL、NV12、色彩矩陣）、鏡頭畫面的時間與中斷、從另一個 process 顯示預覽的代價（WebCodecs、Electron sharedTexture）、形狀尺寸與鏡像慣例；以計畫 075 為例 |
| [設定頁怎麼儲存才不會卡：每項設定各自儲存、單一寫入者排序、畫面樂觀顯示](settings-saves-without-locks.html) | 設定值由另一個 process 擁有時的儲存模式：全頁存檔鎖、畫面端排隊與無排序並行各自怎麼壞、把寫入順序交給擁有者的單一寫入者、畫面新舊交給遞增 revision、進行中狀態與錯誤改為每項設定各一份、樂觀顯示與失敗退回、值與動作的區分，以及表單、慢速網路、不可逆動作等不該使用的情況；以錄影工作室的相機與音量欄位為例 |
| [原始檔、使用者的決定與可重建的衍生檔：放在哪裡、怎麼認、什麼時候清](derived-data-lifecycle.html) | 使用者自己也會整理的資料夾旁，App 另外保存的資料：依「誰的、能否重建、要不要備份」分開存放（使用者資料夾、Application Support、Caches）、路徑用來找而內容指紋用來認（分辨搬動與複製）、找不到時畫面與交出去的檔案一起退回原始狀態、先寫紀錄成功才搬檔案與失敗時依錯誤碼說明原因、可重建的從嚴清而不可重建的確定刪除才清、保留但看得見而非計時刪除、持續監看資料夾加備援檢查，以及 Cap、Final Cut、Photos 把衍生檔包在一起的做法與不適用的情況；以分享錄影的 plan 100 為例 |
