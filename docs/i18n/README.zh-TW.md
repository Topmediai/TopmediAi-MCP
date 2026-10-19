# TopMediAi-MCP

[English](../../README.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Deutsch](README.de.md) · [Français](README.fr.md) · [Español](README.es.md) · [Italiano](README.it.md) · **繁體中文**

TopMediai 的本機 TypeScript stdio MCP 伺服器與 Codex 外掛程式。目前版本 **1.0.0**，支援圖片生成、圖生圖、音樂、影片、多素材參考影片、文字轉語音（TTS）及語音轉換（STS），提供模型目錄、費用估算、預算驗證、任務復原與圖片／音訊／影片預覽。尚未開放降噪、聲音複製及音樂影片。

生成會使用登入帳號的使用額度。請先查詢模型與準確報價，再依使用者預算及目前對話的確認偏好提交。上傳素材需要同意將檔案儲存於外部服務，上傳網址可能公開存取。詳見[資料與隱私（英文）](../privacy.md)。

## 安裝與登入

需要 Node.js >= 22.18、Codex CLI，以及可存取的官方連線頁面。目前瀏覽器登入支援同一台 Windows 電腦上的瀏覽器與 MCP 伺服器。PowerShell 請使用 `npm.cmd`；其他支援的 shell 可使用 `npm`。

在專案目錄執行：

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run install:codex
```

外掛程式在 Codex 中顯示為 `TopMediAi-MCP`，安裝識別碼為 `topmediai-mcp@topmediai-local`。安裝會產生本機 `plugin/.mcp.json`，不會將 Token 或 Cookie 寫入外掛程式。該檔案包含本機執行檔路徑，不可提交或散布；移動專案或更換電腦後請重新安裝。

在目前聊天呼叫 `get_service_status`。需要登入時使用 `start_login`，在官方頁面確認帳號並核准連線。持續以相同 `login_id` 呼叫 `wait_for_login`，直到儲存成功或工作階段結束。儲存後在同一聊天呼叫 `get_service_status`、`get_balance` 並繼續原始請求，無須重新啟動 Codex 或 MCP。

備用 CLI 指令：

```powershell
npm.cmd run login
npm.cmd run login:status
npm.cmd run logout
```

登入最多等待十分鐘，預設不顯示私人連線網址。瀏覽器無法自動開啟時，可在本機使用 `--show-private-link`。該網址僅供本機瀏覽器使用，不可分享、截圖或貼入聊天。

安裝自我檢查僅證明獨立 MCP 程序可以啟動，不代表目前聊天已載入工具或帳號憑證有效。工具缺少時請檢查外掛程式是否啟用、更新套件並重新連線，必要時開啟新聊天。不可將其他生成工具的作品稱為 TopMediai 結果。

## 環境與設定

公開版安裝程式、伺服器與所有 CLI 指令均**僅支援正式環境**，內建官方網站與 API 位址。新使用者無須建立 `.env`、選擇環境、填寫網域或複製 Token。選用設定見 [.env.example](../../.env.example)，詳見[正式環境安裝與設定（英文）](../production-switch.md)。

- 預設直接連線正式 API。服務位址必須是有效的 HTTPS Origin，必要設定明確留空會被拒絕。舊閘道僅在明確設定 `TOPMEDIAI_PRODUCTION_GATEWAY_HOST` 時啟用，且功能有限。
- 安裝時讀取 shell 設定並固定服務位址、環境與上傳設定。覆寫值請在安裝前設定；直接啟動與登入 CLI 的差異請參閱設定範例註解。
- 一般安裝使用私人儲存的憑證。`TOPMEDIAI_TOKEN` 僅供明確覆寫，不可放入公開檔案、截圖或問題回報。標準安裝會清空舊覆寫值，避免沿用過期憑證。
- Windows 憑證儲存於 `%LOCALAPPDATA%\TopMediai\credentials\`，每次工具呼叫前重新驗證。切換帳號時會選用對應任務目錄；已執行中的請求仍使用原帳號。
- 生成及上傳無須額外功能開關。上傳仍需要針對指定檔案的許可及專用目錄。服務位址、上傳設定或程式碼變更後，請更新安裝設定與套件並重新連線 MCP。
- 本機登出僅刪除儲存的憑證，不會登出網站、撤銷伺服器 Token 或取消已提交任務。

```powershell
npm.cmd run setup:plugin
```

更新後請核對 `get_service_status.server_version`，不必預設重新啟動整個應用程式。

## 工具與創作流程

| 用途 | 主要工具 |
| --- | --- |
| 狀態與登入 | `get_service_status`, `start_login`, `wait_for_login`, `cancel_login` |
| 帳號與計畫 | `get_balance`, `review_generation_plan` |
| 圖片 | `list_image_models`, `estimate_image_cost`, `generate_image`, `get_image_task` |
| 參考圖片與預覽 | `upload_reference_image`, `preview_image_task` |
| 音樂 | `list_music_models`, `estimate_music_cost`, `generate_music` |
| 影片 | `list_video_models`, `estimate_video_cost`, `generate_video`, `upload_reference_media`, `preview_video_task` |
| 語音 | `list_voices`, `get_voice_detail`, `list_tts_models`, `list_sts_models`, `get_speech_entitlements`, `upload_speech_audio`, `estimate_tts_cost`, `generate_tts`, `estimate_sts_cost`, `generate_sts` |
| 多媒體查詢與播放 | `get_generation_capabilities`, `get_generation_task`, `preview_audio_task` |

以實際載入的工具清單為準。使用者未指定模型時採用目前目錄回傳的預設模型，不依價格或風格擅自切換。參數、參考素材上限、聲音語言及能力皆由目前目錄取得；列出模型不代表報價或生成一定可用。

先取得有效報價，再以穩定的 `request_id` 及明確預算提交。`review_generation_plan` 彙整目前流程的報價；預設在使用指定高費用模型，或流程預估總額**嚴格大於 1000 點數**時需要確認。使用者明確偏好優先；報價到期、輸入變更或價格上漲時重新評估。工具不能取代使用者同意，本機預算也不是伺服器強制執行的消費上限。

逾時、取消、斷線及提交結果不明，不代表後端未生成或未扣款。保留原始任務識別碼，核對本人歷史紀錄，不自動重新生成。帳號或設定變更後找不到舊任務時，也應先查歷史紀錄。

圖片完成後優先預覽。連結失效可對原任務呼叫 `get_image_task({request_id, refresh_result:true})`，但不保證延長有效期。音訊透過播放器或具名連結交付，影片提供內嵌播放器與原始作品連結。預覽失敗與生成失敗分開說明；部分步驟失敗仍交付成功作品。

## 影片預覽

影片完成後，以原始 `task_handle` 呼叫 `preview_video_task`，顯示唯讀播放器並附上各成功版本的具名原始影片連結。支援點擊播放、暫停、拖曳進度、音量、全螢幕及重試。部分完成時先顯示成功版本，不重複開啟未變更的卡片。

預覽只讀取目前帳號儲存的本機任務，不查詢生成後端、不下載至本機、不生成、不扣點，也不修改任務。只從核准的正式影片 CDN 載入媒體，不傳送帳號憑證。介面、格式或播放失敗時仍保留原始連結，不可因此重新生成。瀏覽器操作、截圖及下載仍需使用者明確要求。

更新套件並重新連線 MCP 後，確認 `server_version=1.0.0`、35 個工具與 `preview_video_task`。卡片顯示及全螢幕能力依主程式支援而定。

## 上傳參考素材

僅選取專用目錄內經使用者允許的檔案，不擴大存取範圍至個人資料或憑證目錄。

```powershell
$env:TOPMEDIAI_UPLOAD_ROOT = 'C:\path\to\upload-inputs'
npm.cmd run setup:plugin
```

先建立目錄並放入獲准素材，再更新設定並重新連線 MCP。

- **圖片：** PNG/JPEG，最大 5 MiB。使用回傳的 `reference_image_id`，不得猜測或跨帳號使用。詳見[圖片上傳（英文）](../image-to-image-security.md)。
- **影片參考：** MP4/WAV/MP3。需要專用目錄與本機 FFmpeg/FFprobe。數量、尺寸、長度及組合限制依各操作的模型目錄；上傳 ID 與順序會綁定報價。
- **STS 來源音訊：** MP3/WAV/AAC/FLAC/AIFF/OGG，最大 50 MiB、300 秒。需要相同專用目錄設定與 FFmpeg/FFprobe。詳見[語音指南（英文）](../speech-integration.md)。

本機驗證與中繼資料移除不會讓雲端檔案變成私人檔案。請勿直接將上傳網址、作品連結或完整本機報告放入公開問題回報。

## 診斷與分享報告

```powershell
# 唯讀查詢，不提交生成
npm.cmd run diagnose
# 同時建立已遮蔽敏感資訊的分享副本
npm.cmd run diagnose -- --share-report
```

主控台預設只顯示摘要。完整報告 `.data/diagnostic-runs/latest-production.json` 僅供本機私人使用；分享副本 `.data/diagnostic-runs/shared-production.json` 會隱藏帳號識別碼、提示詞、費用數值、媒體網址、私人連結及本機路徑。分享前仍應檢查副本，不能只將完整報告改名。正常 MCP 結果仍提供真實餘額與有效作品連結。

## 開發與公開檢查

```powershell
npm.cmd test
npm.cmd run check:public
npm.cmd run check:public -- --build
npm.cmd run prepare:public
```

`prepare:public` 從已審核檔案建立獨立公開快照，並初始化不繼承原始歷史紀錄的本機 Git 儲存庫。僅公開通過檢查的副本；修改目前檔案不會移除舊歷史。詳見[公開檢查（英文）](../releasing.md)。

## 授權條款

本專案原創程式碼採用 [MIT License](../../LICENSE)，著作權人為 TopMediai。第三方程式碼與相依套件仍遵循各自的授權及著作權聲明。

程式碼授權不代表免費使用 TopMediai 雲端服務；登入、生成、上傳等仍受帳號權益、計費規則及服務條款約束。TopMediai 名稱、商標與品牌圖示不包含在本專案 MIT 授權範圍內，使用須取得相應許可。
