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
