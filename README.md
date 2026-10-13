# Stage.js

多人音訊舞台系統：**WebSocket** 為控制平面、**WebRTC** 為音訊平面。一位主控＋最多 8 位發言者在台發言；觀眾只能聆聽，可舉手由主控核准上台。多人同時發言由**伺服器端混音**成單一 Opus 串流（mono、VBR 32–128kbps、48kHz）分送全場。單一 process 承載多個房間，以房間代碼進場。

交付內容：Node 伺服器、可嵌入其他網站的瀏覽器 client 函式庫（ESM）、完整範例前端（響應式手機版、深淺色主題、多人列表管理）。需求與決策全文見 [`PLAN.md`](PLAN.md)，撰寫規範與安全規則見 [`AGENTS.md`](AGENTS.md)。

快速導覽：[安裝與啟動](#安裝與啟動) · [設定](#設定configyaml) · [監控與停機](#監控與停機) · [WebSocket 協定](#websocket-協定摘要) · [client 整合](#整合到其他網站client-函式庫) · [測試與驗證](#測試與驗證) · [SDK 完整 API](packages/client/README.md)

## 架構

```
瀏覽器（主控／發言者／觀眾）── StageClient（packages/client）
   ├─ wss://host/ws   控制平面 JSON：進房、舉手、上下台、移交、靜音、SDP/ICE 信令
   └─ WebRTC          每人一條 PeerConnection 連伺服器
                       上行：僅台上者 Opus mono；下行：單一混音串流（台上者收不含自己的混音）

Stage.js 伺服器（Node v24）
   ├─ src/ws/          ws 伺服器、驗證、限流、StageHub（每房單序佇列、廣播）
   ├─ src/model/       Room 狀態機與不變量
   ├─ src/rtc/         offer 方向檢查（觀眾只能 recvonly）、短期 TURN 憑證
   ├─ src/mixer/       RoomMixer：每路降噪＋音量正規化 → N 路 PCM 48kHz 疊加 → limiter → mix / mix-minus-self；jitter buffer、說話偵測；所有房間共用一個 MixerClock
   └─ src/transport/   MediaTransport 介面；werift adapter；Mock
        ├─ 主執行緒       上行 RTP 重排／判定遺失、混音分送、觀眾 low tier 分級、政策關卡
        ├─ media workers PeerConnection（ICE／DTLS／SRTP／RTP 打包、RTCP 接收報告）；rtc.mediaWorkers > 0 時分散到多條 thread，0＝主執行緒
        └─ codec workers Opus 編解碼（audio.codecWorkers 條 thread，libopus WASM；遺失包以 FEC／PLC 還原；同 worker 的工作合併成一則訊息）
```

混音：每 20ms 一個 tick，各發言者取一個 960-sample frame 疊加。觀眾共用一次編碼（下行掉包持續偏高的觀眾改收另一路共用的低位元率＋高 FEC 編碼）；台上者有聲時各自一路 mix-minus-self 編碼，持續無聲超過 1 秒則共用完整混音。全零 PCM 同樣算無聲，但低於說話偵測門檻的非零音訊仍照常播放；全房無聲超過 1 秒且啟用 DTX 時停止編碼。編好的封包送到持有該房 peer 的各 media worker，由它們各自打包、加密、送出。移除 publisher 時釋放其 encoder 與 decoder，再上台使用全新解碼狀態。

## 需求

- Node.js **v24** 以上（`engines: >=24`；開發模式以 Node 內建 type stripping 執行 `.ts`；`npm start` 執行建置後的 `dist/src/index.js`）
- npm 11
- 對外部署：TLS 憑證（或本機反向代理終止 TLS）＋STUN/TURN（建議 coturn）

## 安裝與啟動

```bash
git clone https://github.com/JS-PACKAGE/Stage.js.git
cd Stage.js
npm install
cp config.example.yaml config.yaml
npm run config:check
npm run build
npm start
```

開啟 <http://127.0.0.1:9728/>：建立房間 → 複製邀請連結 → 另一個瀏覽器開啟連結加入。範例設定為本機開發模式（明文 ws、只綁 127.0.0.1）。

開發模式：

```bash
npm run dev        # 伺服器（node --watch src/index.ts）
npm run dev:web    # Vite 前端開發伺服器，/ws 代理到 127.0.0.1:9728
```

### 啟動前檢查設定

```bash
npm run config:check                     # STAGE_CONFIG 或專案根目錄 config.yaml
npm run config:check -- config.example.yaml # 指定檔案，覆蓋 STAGE_CONFIG
node dist/src/check-config.js /path/to/config.yaml # 建置後也可直接執行
```

只驗證 YAML 與既有欄位／跨欄位規則，不啟動伺服器、worker 或網路連線，也不建立／改寫設定檔；不代表 TLS／靜態檔可讀、連接埠可綁定或 TURN 可達。成功 exit 0、讀取／驗證失敗 exit 1、用法錯誤 exit 2；`-h`／`--help` 顯示用法，`--` 後可指定以 `-` 開頭的檔名。明確路徑優先於 `STAGE_CONFIG`，相對路徑以目前工作目錄解析；未提供兩者時從專案根目錄找 `config.yaml`，不受目前目錄影響。沿用直接啟動的語意：空的 `STAGE_CONFIG` 不等同未設定，會指向目前目錄並讀取失敗。輸出不列出設定內容或 stack trace；共用 loader 的 YAML 診斷只保留錯誤種類與安全的行／列位置，原本僅有 warning 的 YAML 仍可通過既有 schema，但不再印出可能包含憑證的 warning／原文片段。

### 靜態資源預壓縮

`npm run build` 最後以 Node 內建 zlib 為 client／web 的 HTML、JS、CSS、JSON、SVG 與 webmanifest 產生較小的 `.br`／`.gz` 副本；不壓縮圖片、已編碼檔或 symlink，壓縮後較大的副本不保留。也可在兩個 workspace 都完成建置後單獨執行 `npm run build:compress`，或 `node scripts/precompress.ts <建置目錄>`；指令會列出原始／Brotli／gzip 位元組數。

伺服器依 `Accept-Encoding` 的權重與排除規則選擇可用版本（同權重優先 Brotli），附 `Vary: Accept-Encoding`、各版本獨立 ETag 與正確 Content-Length。HEAD 與 304 保持相同的編碼資訊，未預壓縮或副本比來源舊時退回原檔；用戶端明確排除所有可用版本才回 406。不會在請求期間壓縮，也不會重複壓縮 `.br`／`.gz` URL。ETag 使用所選版本的檔案身分、大小及奈秒修改／變更時間，避免保留大小與 mtime 的 release 檔案替換沿用舊驗證值；它仍是弱 metadata validator，不是內容雜湊。只使用 If-Modified-Since 的用戶端仍受 Last-Modified 秒級精度及保留 mtime 的限制。部署時請將原檔與副本一起更新；Vite 開發模式仍維持原工作流程。

靜態掛載會同時檢查 URL 路徑與解析 symlink 後的實際路徑；原始檔或壓縮 sidecar 不可指向該掛載實際根目錄之外。仍允許根目錄內的來源檔 symlink，以及設定成 release 目錄 symlink 的掛載根；根目錄切換或稍後才完成的 build 不需重啟服務。壓縮 sidecar 本身仍須為一般檔案。這是意外／既有 symlink 越界的防護，不是對具有資產目錄寫入權者的競態安全檔案沙箱；部署時不要讓非信任程序寫入公開資產樹。

自訂 prefix 掛載（例如 `/demo/`）若 `index.html` 存在且解析後是掛載內的一般檔案，請求 `/demo` 會以 308 導向 `/demo/`，保留 query；這讓 HTML 的相對資產網址從正確目錄解析。GET／HEAD 共用此規則，redirect 使用同來源相對 Location 與 `Cache-Control: no-cache`，不依賴傳入 Host 建立絕對網址。預設 `/`、一般檔案與已帶斜線網址不變；缺少或越界的 index 不會產生 redirect。壓縮與 conditional request 在後續的 canonical URL 照常處理。

### 控制腳本

根目錄的 `stage.sh`（macOS／Linux）與 `stage.ps1`（Windows）包裝常用操作，背景執行時 pid／log 存放在 `.run/`：

```bash
./stage.sh build      # 建置
./stage.sh start      # 背景啟動（config.yaml 不存在時自動由範例建立）
./stage.sh status     # 執行狀態（未執行時 exit code 3）
./stage.sh logs -f    # 追蹤 log
./stage.sh stop       # SIGTERM 優雅停止，逾時（STAGE_STOP_TIMEOUT，預設 15 秒）強制終止
./stage.sh help       # 全部指令：install／restart／run／dev／test
```

`stage.sh` 的 `STAGE_STOP_TIMEOUT` 接受 0–2147483647 的非負十進位整數秒數；未設定或空值用 15，0 表示送出 SIGTERM 後不等待，若程序仍在執行即送 SIGKILL。上限採可攜的 signed 32-bit 範圍；無效值讓 `stop`／`restart` 在任何程序探測或訊號前以 exit code 1 結束，不刪除 PID 檔，也不啟動替代程序。其他指令不使用這個期限。

`stage.sh` 只接受 PID 檔中的正十進位整數（1–2147483647，可含前導零與尾端換行；拒絕 NUL 等其他位元組）。內容無效或讀取失敗時，`start`／`status`／`stop`／`restart` 以 exit code 1 結束，保留檔案供檢查，不探測／發送訊號／啟動程序；有效但已不存在的 PID 仍清除，`status` 回 3、`stop` 成功返回。這只防止錯誤格式與 process-group selector，不驗證 PID 是否仍屬於原本的 Stage 程序，也不解決作業系統的 PID 重用。

`stage.sh restart` 在送出 SIGTERM 前先檢查 Node 版本、已建置的 server／設定檢查器與設定語法／schema；檢查失敗時不停止目前程序。請先執行 `build`，舊版建置若沒有 `dist/src/check-config.js` 也會拒絕 restart。檢查器與 server 使用同一份已建置 schema，不改用可能較新的 source schema。原有 timeout／PID 驗證仍優先；設定準備沿用 `start`，因此缺少預設設定時仍可能先由範例建立 `config.yaml`，而 checker 本身不寫入設定。`STAGE_CONFIG` 原值會保留給 checker，relative path 從腳本所在專案目錄解析，空值仍依 server 語意驗證並失敗。通過後仍依序 stop／start，不保證零停機或啟動成功，也不預測 port、TLS／media 資源、相依套件的所有 runtime 路徑或檢查後的檔案變更。其他控制指令與 Windows 腳本維持原本行為。

Windows 用 `.\stage.ps1 <command>`，指令相同；Windows 無法對背景 node 送 SIGTERM，`stop` 為直接終止。

## 設定（`config.yaml`）

以下五個欄位可省略以相容舊設定，其餘欄位必填：`server.httpShutdownDrainMs`（1000）、`limits.maxSendBufferBytes`／`limits.maxPendingBytes`（各為 `maxFrameBytes × 16`，最高為 `Number.MAX_SAFE_INTEGER`）、`limits.maxPendingMessages`（128）、`rtc.mediaWorkerTimeoutMs`（30000）。啟動時嚴格驗證，錯誤會指出欄位路徑。設定檔路徑可用環境變數 `STAGE_CONFIG` 覆寫。`config.yaml` 不入庫。

| 區塊 | 重點欄位 |
|---|---|
| `server` | `host`、`port`、`wsPath`；`allowInsecure`（明文 ws，僅限 loopback host）；`tls.certFile`／`keyFile`；`static` 靜態掛載（`/` → `web/dist`，`/lib/` → `packages/client/dist` 附 CORS）；`metrics.{enabled,token}`（`GET /metrics`，對外 host 須設 token）；`trustProxy`（反向代理後以 `X-Forwarded-For` 計算每 IP 連線）；`httpShutdownDrainMs`（最後 HTTP 排空期限，0–60000 ms，詳見監控與停機） |
| `limits` | `maxRooms`、`maxConnections`、`maxConnectionsPerIp`（同一位址同時連線，0＝不限；NAT 或反向代理後多人共用位址，設定前先估算，代理後須開 `server.trustProxy`）、`joinTimeoutMs`（連上後未開房／進房的逾時，0＝不限）、`maxSpeakersPerRoom`（8，主控以外的台上者；主控席位另計）、`maxAudiencePerRoom`（300）、`maxFrameBytes`（64KB）、`maxSendBufferBytes`（每條 ws 待送位元組上限，含下一則訊息；範例 1 MiB，舊設定省略時採 `maxFrameBytes × 16`）、`maxPendingMessages`／`maxPendingBytes`（每條 ws 等待處理的工作數／位元組上限，詳見下方輸入工作佇列）、`controlPerSecond`（20）、`handRaiseIntervalMs`（10000）、`icePerSecond`（30）、`nameMaxLength`（32）、`codeMaxLength`（16）、`sdpMaxLength` |
| `rooms` | `codeLength`（8）、`controllerGraceMs`（主控斷線寬限 60000）、`participantGraceMs`（其他人斷線寬限 15000；期間保留席位、台位、舉手順位與 PeerConnection，音訊不中斷；0＝立即移除）、`heartbeatIntervalMs`、`presenceBroadcastMs`（觀眾進出合併 `room:state` 廣播的時間窗，250；進場者本人仍立即收到自己的 snapshot）、`qualityIntervalMs`（台上者連線品質回報間隔，2000；0＝停用）、`createToken`（非空時 `room:create` 須帶相同 `token`，否則 `unauthorized`；空字串＝任何人可開房，對外部署建議設定） |
| `audio` | `sampleRate`（48000；只接受 Opus 原生取樣率）、`frameMs`（20）、`codecWorkers`（Opus 編解碼 worker 數，房間平均分配到各 worker）、`opus.{vbr,minBitrate,maxBitrate,bitrate,complexity}`、`opus.fec`／`opus.packetLossPercent`（下行 in-band FEC 與預期掉包率）、`opus.dtx`（靜音不送包）、`lowTier.{enabled,bitrate,packetLossPercent,enterLossPercent,exitLossPercent}`（RTCP 接收報告顯示持續掉包的觀眾改收第二路共用混音：較低位元率＋較多 FEC，掉包回落後切回）、`mixer.{maxBufferedFrames,limiterThreshold}`、`mixer.latencyTargetMs`（僅供 `bench-mixer`／`load-test` 當驗收門檻）、`mixer.speakingThreshold`／`speakingHoldMs`（說話指示的 RMS 門檻與釋放延遲）、`jitter.playoutFrames`（每路上行預緩衝幀數）、`jitter.reorderPackets`（亂序容忍包數，超過即判定遺失並補幀）、`noiseFilter.{enabled,highPassHz,gateThreshold,gateHoldMs,gateFloor}`（伺服器端上行降噪：高通濾掉低頻雜音＋噪音門壓低說話間隙的背景音；瀏覽器端另開 `noiseSuppression`）、`loudness.{enabled,targetRms,maxGainDb,speechRms,adaptMs}`（伺服器端每路音量正規化：依說話時的平均音量把各發言者拉到相近大小，增益上限 ±maxGainDb） |
| `rtc` | `iceServers`（下發給瀏覽器的靜態 STUN）、`serverIceServers`（伺服器端 ICE）、`portRange`（`[]` 或 `[min, max]`）、`mediaWorkerTimeoutMs`（worker RPC 逾時，預設／舊設定省略時 30000，1–300000 ms；不適用於 `mediaWorkers: 0`）、`mediaWorkers`（承載 PeerConnection 的 worker thread 數，預設 2 對應 300 聽眾；0＝主執行緒）、`turn.{urls,secret,ttlSeconds}`（coturn `use-auth-secret` 短期憑證，每次進房以 HMAC 簽發；`urls: []` 停用） |
| `log` | `level`：`debug`／`info`／`warn`／`error`（房間代碼、token、憑證、SDP 一律不入日誌） |

### 對外部署

`allowInsecure: false`、`host: 0.0.0.0`、填 `tls`；開放 `rtc.portRange` 的 UDP；設定 `rtc.turn`（coturn 需 `use-auth-secret` 與相同的 `static-auth-secret`）。憑證檔更新（含 ACME 工具的改名／symlink 替換）後約 2 秒自動重載，不需重啟；新憑證載入失敗時沿用舊憑證並記 error。

### 主控斷線接任

主控斷線寬限到期時，仍優先移交給最早上台且已連線的發言者，否則給最早加入且已連線的觀眾。即使所有發言席都由寬限中的斷線者占用，觀眾也能接任主控；到期舊主控會移除，不需額外占用發言席。其他斷線者仍保留原席位、媒體與各自寬限，接任觀眾不會自動開啟麥克風。手動移交的滿台限制維持不變；沒有可接任的已連線者時關房。接任順位依實際加入／本次上台的先後，不受系統時鐘校正影響；同席重連保留順位，下台後再次上台則排到仍在台上者之後。公開時間戳記維持原值。

### 媒體 worker 看門狗

RPC（SDP、ICE、統計、關閉）超過 `rtc.mediaWorkerTimeoutMs` 即拒絕該 worker 全部待回覆請求、停止並重建 worker，通知其音訊連線已失效；其他 worker 不受影響。替換後忽略舊 worker 的延遲回覆／事件，避免舊協商污染新連線。這會讓該 worker 的使用者暫時中斷音訊並依既有流程重建，請將期限設得足以涵蓋正常 ICE／STUN 協商；過小會反覆重生。停機沿用同一期限，但不重生 worker。

### WebSocket 路徑設定

`server.wsPath` 必須以 `/` 開頭，而且原值必須能完整保留為 HTTP／WebSocket URL 的 pathname；含 query／fragment、會被移除的 dot segment、反斜線、原始空白／控制字元或需 URL 編碼的 Unicode 拼法會在啟動與離線設定檢查時失敗，不會默默改成另一條路徑。請自行改成預期的字面 pathname（例如 `/control` 或 `/%E8%88%9E%E5%8F%B0`）。原本已可匹配的百分比序列保持原值，不解碼或重寫；例如 `/a%2Fb` 與 `/a/b` 不同。少見但可由合適 request target 表達的多重前導斜線路徑仍相容；完整範例與最小 embed 的路徑選項刻意只接受一般單一前導斜線路徑。這會拒絕舊版曾接受、卻不符合 HTTP／WebSocket URL 正規路徑拼法的設定；少數非 HTTP scheme 的特殊 request target 原本可能匹配原始反斜線等值，現在也會被設定檢查拒絕。runtime 的 request target 解析政策不在此修改；錯誤只標示欄位，不輸出設定內容。

### 慢速讀取端

每條 WebSocket 的待送資料加上下一則 JSON 的 UTF-8 位元組若超過 `limits.maxSendBufferBytes`，伺服器立即中斷該連線以釋放緩衝，不影響其他連線。此為非主動離開，仍依既有斷線寬限保留席位與音訊，client 可自動回座取得最新 snapshot。請將上限設得足以容納最大房間 snapshot；持續無法接收完整 snapshot 的 client 會再次斷線。`stage_ws_backpressure_disconnects_total` 記錄此類中斷次數。

### 監控與停機

程序的 unhandled rejection 仍只記錄、不自動停機；uncaught exception 仍啟動失敗退出的清理流程。這兩種診斷與停機／metrics 錯誤一樣，將原始值交給結構化 logger，避免先讀取不可信 stack getter 或做字串轉換而讓回報本身中斷；一般 Error 的 name／message／stack 以結構呈現，敏感欄位沿用既有遮蔽。這不保證任意自訂 logger／輸出裝置失敗時仍能完成清理。SDP／ICE transport 拒絕值也直接交給安全 logger，保留該請求的 generic `bad_request`；無法安全字串化的診斷不會因此升級成整個房間的 internal failure。SDP 失敗仍依最新 offer 的所有權清理該 peer，其他席位不受影響；這不放寬上行權限或改變真正的房間 invariant failure 政策。WebSocket 控制佇列及關閉清理的錯誤也不先字串化：記錄診斷後仍終止失敗連線，第一次 detach 失敗仍等待 active work 完成後再執行清理。

`GET /healthz` 回 `ok`（程序存活）；`GET /readyz`／`HEAD /readyz` 表示是否接收新工作，正常回 200，開始停機即回 503／`draining` 且禁止快取，並拒絕新的 WebSocket upgrade（503）。它不是媒體連線健康檢查；存活探針在排空期間仍為 200。停機會先停止既有連線的待處理／新控制工作，再發房間停機通知與關閉握手；已開始的工作不強制取消。房間／WebSocket 清理完成後，HTTP listener 停止接收連線，既有回應最多等待 `server.httpShutdownDrainMs`（預設 1000ms，整數 0–60000，0 表示立即切斷）；逾時會關閉尚未完成的 HTTP socket，避免慢速下載或卡住的 metrics 回應阻止退出。這只限制最後 HTTP 網路排空階段，不是整體停機期限，也不取消底層統計收集 promise。`GET /metrics` 回 Prometheus 文字格式（`Authorization: Bearer <server.metrics.token>`），包含房間／連線／發言者數、上下行封包與補幀數、DTX 省略幀、全房無聲時跳過編碼的幀數（`opus.dtx` 開啟且台上全員靜音、沒有上行或持續全零 PCM 超過 1 秒時，混音不再編碼、直接以 DTX 處理）、low tier 聽眾數、codec backlog 與丟幀、mixer underrun／漂移丟幀／tick 延遲、event loop delay 與記憶體。同一伺服器上重疊的已授權 scrape 共用尚未完成的統計收集，避免重複掃描房間與查詢 worker；收集完成或失敗立即釋放，下一次請求重新取樣，不保留過期快取。CLI 以 `server.metrics.enabled: false` 啟動時不建立 event-loop delay 的背景取樣器；啟用時仍從啟動開始保留 histogram，不延後到第一次 scrape。其他房間／媒體計數器與停機順序不變；這是省去未使用的取樣工作，不代表已量測 CPU、耗電或端到端延遲改善。

統計收集失敗回空白 500，不把診斷內容傳給 HTTP 呼叫端；provider 拋出或拒絕的值直接交給既有結構化 logger 處理，不先執行其字串轉換，因此 null-prototype 物件或自訂轉換失敗也不會阻斷這個錯誤回應。這不保證任意自訂 logger／sink 本身不會拋錯，也不是統計收集的執行期限。

CLI 停機依序嘗試 server 與 media transport 清理；任何一段同步拋錯或 promise 拒絕，都會記錄該段錯誤並繼續下一段，最後以非零狀態退出。正常 SIGINT／SIGTERM 完成時為 0；停機途中發生 uncaught exception 會升級為 1，後續一般訊號不會降回 0，既有非零退出意圖也不被覆寫。重複通知不重複清理。這不新增整體停機期限，亦不保證未 settle 的底層 close promise 能自行結束。

### 輸入工作佇列

`limits.maxPendingMessages`（預設 128）與 `limits.maxPendingBytes`（範例 1 MiB；舊設定為 `maxFrameBytes × 16`）限制每條 WebSocket 等待處理的工作，以訊息數與 JSON UTF-8 位元組分別計算。正在執行的一筆不計入等待上限，仍受單幀上限限制。超過任一上限立即終止該連線並清除等待工作，沿用非主動離開的席位寬限；實際 socket 關閉時立即解除既有連線綁定並依房間佇列標記離線，讓卡住的 SDP 不阻擋同席回座。一般斷線也丟棄尚未開始的工作；已開始的工作不強制取消，完成後再次清理可能遲到的 join 綁定，不會移除已回座的新連線。席位寬限從這次離線處理開始，不等待 SDP 完成。Prometheus `stage_ws_inbound_queue_disconnects_total` 記錄超限次數。正常順序與每秒頻率限制不變。`node scripts/bench-ws-inbound.ts` 比較 gated 工作下舊 promise chain 與有界佇列的待處理筆數／payload 位元組及斷線後執行數；這不是 RSS 或延遲 benchmark。

伺服器限流以單調經過時間計算，不以牆鐘時間計算，避免系統校時讓正常連線誤觸限流或提早補滿配額；房間時間戳與日誌仍保留正常 UTC／epoch 語意。

### 結構化日誌遮蔽

logger 會遞迴遮蔽物件／陣列中的 `code`、`resumeToken`、`token`、`credential`、`password`、`username`、`secret`、`sdp`、`payload` 欄位（不分大小寫），不修改原物件。循環、深度 8 或超過 1000 個欄位／元素的結構使用標記截斷；getter、toJSON 與 Proxy 不執行。深度／欄位上限限制遞迴複製與輸出結構，不限制 Object.keys 列舉成本或任意字串的位元組數，呼叫端仍應使用精簡欄位。Error 的資料型 name／message／stack／cause 保留並遞迴處理，accessor 型 stack 以標記表示；Date 與 bigint 安全轉成字串。這只是欄位名稱防護，不會辨識任意訊息／字串裡的秘密，呼叫端仍不得把憑證或原始 SDP 混進 log message。

## WebSocket 協定摘要

無法解析的 WebSocket upgrade request target 會收到固定、空內容的 HTTP 400 並關閉該 socket，不建立 session，也不把原始 target 或 parser error 寫入診斷／回應。合法 URL 仍沿用既有 path、連線容量與握手檢查；停機中的 upgrade 仍優先回 503。這是輸入邊界的解析失敗隔離，不新增 Origin／認證政策或遠端服務驗證。

JSON frame，型別定義在 [`shared/protocol.ts`](shared/protocol.ts)。每個請求帶 `requestId`，成功回 `ok {requestId}`，失敗回 `error {requestId, code, message}`（固定 generic 訊息）。

| Client → Server | 說明 |
|---|---|
| `room:create {name?, roomName?, codeRequired?, token?}` | 開房，建立者成為主控（預設在台）；伺服器設定 `rooms.createToken` 時須帶相同 `token` |
| `join {roomId, code?, name, resumeToken?}` | 進房（預設觀眾）；`resumeToken` 供斷線後在寬限期內回座（席位、台位、舉手順位、音訊連線都保留） |
| `hand:raise`／`hand:withdraw` | 觀眾舉手／收回（舉手 10 秒最多 1 次） |
| `stage:approve {targetId}`／`stage:reject {targetId}` | 主控核准／婉拒；`targetId` 為自己＝主控返回舞台 |
| `stage:leave` | 下台（主控下台仍保有控制權） |
| `stage:remove {targetId}` | 主控把發言者移回觀眾 |
| `control:transfer {targetId}` | 主控移交控制權 |
| `mic:mute`／`mic:unmute`、`mic:force-mute`／`mic:force-unmute {targetId}` | 自我靜音；主控強制靜音（解除時保留本人的自我靜音） |
| `room:close` | 主控關房 |
| `participant:kick {targetId}` | 主控把人踢出房間（對方收到 `kicked` 後連線被關閉、不會自動重連）；要防止對方再進來，接著更換代碼 |
| `mic:gain {targetId, gainDb}` | 主控調整某人在混音中的音量（±20 dB，0＝不調整；疊加在自動音量正規化之上），離開舞台後再上台仍保留；所有人在 `room:state` 的 `gainDb` 看到 |
| `room:rotate-code` | 主控更換房間代碼（限需代碼的房間）；舊代碼／邀請連結立即失效，既有連線保留。重連仍驗證代碼；主控 SDK 更新已收到的新代碼，其他成員未取得新代碼時無法以舊代碼重連 |
| `rtc:offer`／`rtc:ice {payload}` | WebRTC 信令（一律由 client 發 offer） |
| `ping` | 回 `pong` |

| Server → Client | 說明 |
|---|---|
| `hello` | `{protocol, serverVersion, limits: {controlPerSecond, icePerSecond, handRaiseIntervalMs}}`：client 依 `limits` 自行節流與舉手冷卻 |
| `room:state` | 個人化 snapshot（每次變動重送）；每人帶 `connected`（ws 斷線、席位保留中為 false）；`code`、`audience` 名單只給主控，`resumeToken` 只給本人 |
| `room:created`、`room:closed` | 開房（只有建立者收到 code）、關房（全員離房）；伺服器停止時 `room:closed` 帶 `reason: 'shutdown'`，連線隨後以 close code 1001 關閉 |
| `kicked` | `{roomId}`：你被主控踢出，伺服器隨即以 close code 4001 關閉連線 |
| `rtc:config` | 瀏覽器用的 ICE servers（設定 `rtc.turn` 時含該參與者專屬的短期 TURN 憑證） |
| `speaking` | `{participantIds}`：目前在混音中有聲的參與者（VAD＋釋放延遲），集合變動時才送 |
| `quality` | `{participants: [{participantId, uplinkLossPercent?, downlinkLossPercent?, rttMs?}]}`：依 `qualityIntervalMs` 回報可取得統計的上行者連線品質（上行掉包為該區間伺服器實際遺失比例，下行掉包取自對方 RTCP 接收報告），只送給主控與台上者 |
| `role:update`、`hand:raise`／`hand:withdraw`、`stage:invite`、`stage:joined`、`stage:left`、`control:transferred`、`mic:muted`／`mic:unmuted` | 事件廣播 |
| `rtc:answer`、`rtc:ice` | 伺服器端信令 |
| `status` | `waiting`／`live` |

連線品質收集每房間同時最多一輪；完成後再等待 `qualityIntervalMs` 啟動下一輪。個別 publisher 統計失敗只略過該人的本輪資料，其他人的回報照常；全部失敗時不送空報告，但下一輪仍會重試。失敗不會被當作 0% 掉包，恢復後上行差量從上次成功樣本計算。關房或最後一位停止發布後不再排程；離台再發布的舊統計結果會被忽略。 個別統計請求的 rejection value 直接交給安全結構化 logger，不先字串化，避免不可轉字串的診斷值阻斷其他 publisher 的本輪資料與差量回報；任意自訂 logger／sink 自身拋錯仍不在此保證範圍。

`limits.joinTimeoutMs`、`rooms.controllerGraceMs`、`rooms.participantGraceMs` 的範圍為 0～2147483647 ms；`rooms.heartbeatIntervalMs` 為 1000～2147483647 ms。上限包含 2147483647（約 24.9 天）；更大的值以前會被 Node timer 正規化成約 1 ms，現在啟動與離線 `config:check` 會拒絕該設定。0 的既有語意不變：join deadline 停用、participant 立即移除、controller 立即排程到期。這不限制只做經過時間比較的 `handRaiseIntervalMs`。

範例設定的限制：frame ≤ 64KB，超過以 close code 1009 斷線；控制訊息 ≤ 20/s、`rtc:ice` ≤ 30/s，超過頻率上限以 close code 1008 斷線。房間不存在或代碼錯誤一律回 `unauthorized`。名稱以 HTML 轉義形式傳送。client 以 close code 1000 關閉＝主動離開（立即移出房間）；其他關閉碼或斷線＝保留席位至寬限期結束（主控一律保留 `controllerGraceMs`）。

同席回座後，若新連線已送出通過權限檢查的 offer，舊 offer 遲到的失敗不會再由 hub 清掉新一輪的 peer／訂閱／發布。只有最新通過檢查的 offer 失敗才清理媒體；單純斷線或回座但未送新 offer 時，原協商失敗仍會清理，讓後續 offer 能重新建立 peer。這是 hub 清理的 ownership 保護，不會取消底層已執行中的 WebRTC 工作。

## 整合到其他網站（client 函式庫）

伺服器在 `/lib/stage-client.js` 提供 ESM 版本（附 `Access-Control-Allow-Origin: *`），外部頁面可直接匯入：

```html
<button id="unlock">啟用音訊</button>
<script type="module">
  import { StageClient, decodeName } from 'https://stage.example.com/lib/stage-client.js';

  const client = new StageClient({ url: 'wss://stage.example.com/ws' });
  client.on('state', ({ detail }) => {
    document.title = decodeName(detail.name); // 名稱已轉義：decodeName 後以 textContent 顯示
  });
  client.on('audioblocked', () => { /* 顯示「啟用音訊」按鈕 */ });
  client.on('micerror', ({ detail }) => console.warn(detail.message));
  document.querySelector('#unlock').onclick = () => client.unlockAudio();

  await client.connect();
  await client.join({ roomId: 'ROOM_ID', code: 'ROOMCODE', name: '訪客' });
  // 觀眾：client.raiseHand()；主控：client.approve(id)、client.transferControl(id)…
</script>
```

整合注意事項：

- CSP：`script-src` 允許函式庫來源；`connect-src wss://stage.example.com`；`media-src blob: mediastream:`。
- 以 iframe 嵌入時需 `allow="microphone; autoplay"`，且上層 Permissions-Policy 允許 `microphone`。
- 瀏覽器自動播放限制：收到 `audioblocked` 時，必須在使用者點擊事件中呼叫 `unlockAudio()`。
- 邀請連結含房間代碼，請視為敏感資訊。

不想寫 JavaScript 的頁面可改用 Web Component：`<script type="module" src="https://stage.example.com/lib/stage-element.js"></script>` 後放 `<stage-client room="…" code="…" name="…"></stage-client>`（內建狀態列、啟用音訊、舉手、台上靜音／下台與失敗後手動重試麥克風、離開房間／手動重新加入；事件以 `stage-<type>` 派發，`element.client` 取得底層 `StageClient`）。

Web Component 的「離開房間」會停止本機收聽／擷取及自動重連，保留屬性與音量／收聽靜音偏好；同一元素更換屬性或移除再掛載後仍等待手動「重新加入」。重入採用最新屬性，不保證原台位／主控身分；關房／被踢不提供這個重入操作。離房先退休 client，因此與元件移除一樣不轉送其晚到事件（含 disconnect status），也不新增合成 SDK 狀態。此 UI 使用既有 disconnect，不代表伺服器房間立即關閉；受控 DOM／SDK 假媒體測試仍不等於真實瀏覽器音訊驗收。

連線中取消、關房與被踢會完整停止麥克風／麥克風測試並清除待回覆請求；同一個 client 可在取消後重用。Web Component 快速移除／重掛載時只接受最新一次連線的事件，音訊解鎖失敗可重試，成功後隱藏按鈕。

本機收聽可用 `setPlaybackVolume(0.5)`／`setPlaybackMuted(true)` 調整，`playbackVolume`／`playbackMuted` 即時讀取；不影響麥克風或其他人，重連時保留。範例前端的「音訊設定」也提供音量與靜音收聽控制。

範例會在本機瀏覽器記住你明確調整的收聽音量與收聽靜音，下次載入先套用，再加入房間。只使用同 origin 的 `stage-playback` localStorage 記錄（version 1、音量 0–1、boolean 靜音）；缺少、無效、超過 128 字元或讀取失敗時保留預設音量 100%／未靜音；寫入失敗仍會套用當次調整，只是不保證下次還原。音量 0 與靜音各自獨立；麥克風、裝置、房間與帳號資料不儲存在此記錄，沒有跨分頁同步。清除該網站的儲存資料即可回到預設。

麥克風音量表只在本機測試或台上未靜音時每 50ms 更新；自身／主控靜音後立即歸零並停止輪詢，解除後恢復。收聽靜音不影響麥克風音量表，房間的 2 秒連線統計排程也不變。

範例的「點擊啟用音訊」結果綁定當次房間身分；離房會暫停音訊，尚未完成的播放可能因此拒絕，但舊操作不會把這類錯誤顯示到入口／新房。當前房間的失敗仍可重試；SDK 的 `unlockAudio()` promise 與瀏覽器自動播放政策不變。

範例的邀請連結複製提示只接受最新一次操作，且房間身分與目前連結仍須相符；離房／換碼後的晚到結果不會覆寫新通知。快照重繪未改變連結時，複製失敗會選取目前畫面上的連結供手動複製。這只隔離提示與選取行為，不能取消或還原已交給瀏覽器的剪貼簿寫入。

音訊裝置清單只套用最新一次列舉結果，避免啟動、麥克風就緒與裝置變更的舊回覆蓋掉新清單；列舉失敗時保留已顯示內容，之後成功更新仍可恢復。已選擇的麥克風／揚聲器若不在最新清單，選單保留「已選擇的裝置（目前未列出）」提示，不自動切換硬體或假裝使用系統預設；同一裝置再次列出時恢復正常名稱，也可自行選擇其他裝置或系統預設。未列出可能與瀏覽器授權或裝置可見性有關，不代表已確認硬體故障；提示不顯示原始 device ID。

發言中標示依目前渲染的參與者索引更新，只切換有變化的列；同人出現在舉手與觀眾名單時會一併更新，重繪／離房不保留舊列。

範例前端的建立／加入房間表單共用一個等待鎖；任一請求進行中，兩個提交按鈕一起停用並標示 `aria-busy`，鍵盤提交也不會重複送出，完成或失敗後恢復。 尚未收到房間狀態時可按「取消連線」，透過 SDK `disconnect()` 結束本機等待；這次取消的建立／加入錯誤不顯示，原請求結束後才能重新提交。收到房間狀態後不再提供取消，請使用房內的離開控制；若此時建立／加入尚未收到 ACK，主動離房也不會把這次已放棄的等待顯示成連線失敗，仍待原請求結束才解除提交鎖。當前真正失敗與關房／被踢的既有診斷照常保留；取消不保證回滾伺服器已接受的操作。

範例前端的個人靜音、上下台、舉手與主控管理按鈕，在等待回覆期間保留停用狀態與 `aria-busy`，不會因冷卻 tick 或房間快照重繪而再次送出。離房／切換身分會清除舊 pending 狀態，舊完成事件不會解鎖新房操作；核准／婉拒／移出舞台共用每人的 pending key，強制靜音與解除亦共用；控制權移交在全列表保留單一 pending，換碼與關房也受保護。舊房間換碼完成不會覆寫新房通知。主控調整講者的音量 slider 在重連期間停用，恢復房間狀態後重新開放；事件 handler 也拒絕重連中的程式化 change。本機收聽音量與靜音仍可操作。gain 不套用 pending 按鈕鎖，連線正常時仍逐次送出放開時的值；離房後才完成的舊 gain 請求不再顯示錯誤到入口／新房，當前房間的失敗仍正常顯示。 舉手倒數只在畫面可見且尚未歸零時排程下一個顯示秒數邊界；沒有倒數時不執行冷卻輪詢，房內連線統計仍每 2 秒更新；只有目前房間最新一次請求可更新顯示，舊輪詢／離房前的延遲結果不會清空新資訊。

範例在台上的麥克風擷取失敗提示旁提供「重試麥克風」；修正權限或裝置後明確點擊才提出重試，不必先放棄台位。已接納的要求顯示等待擷取結果並保持 `aria-busy`／停用，普通快照重畫不會重複要求；失敗後可再次手動重試，信令重連時暫停新的操作。取得麥克風事件只清除擷取提示，不代表協商或聲音傳送成功；下台／離房／換身分清除舊 UI 工作，本機收聽與既有靜音政策不變。

範例的麥克風測試與輸入裝置切換共用操作鎖，避免切換途中重複啟動預覽。 等待預覽權限時可按「取消麥克風測試」，原預覽請求結束後即可重試，不需離房且不停止房內麥克風或收聽。此控制也適用於裝置切換後重新擷取預覽，但不取消 `setInputDevice()` 本身；上台或離房會取消尚未完成的預覽。取消無法自動關閉瀏覽器權限提示，稍後允許的串流會由 SDK 停止。離房後的晚到預覽只會停止自己的串流，不會覆寫新預覽或解鎖新的操作；SDK 仍允許呼叫端各自管理獨立預覽。

完整 API 見 [`packages/client/README.md`](packages/client/README.md)；`web/embed.html` 是最小嵌入範例。

主機使用自訂 `server.wsPath` 時，可填「WebSocket 路徑」或以 `?wsPath=%2Fcontrol` 預填，缺省／空白仍用 `/ws`；模組仍從同一主機的 `/lib/stage-client.js` 載入。路徑必須以單一 `/` 開頭，不接受跨主機 authority、scheme、反斜線、query／fragment、控制字元、內部空白或一般／`%2e` 編碼的 dot segment。安全的百分比編碼保留為 pathname，不會再解碼成另一個主機；query 本身先依 URLSearchParams 解碼一次，例如預填字面 `%2F` 路徑片段要寫 `%252F`。Unicode 路徑依 URL 規則序列化，因此伺服器 `wsPath` 須與序列化後 pathname 相符，不保證任意輸入 byte 原樣保留。每次送出在任何等待前，一起擷取當時的主機、路徑、房間 ID、代碼與名稱；等待舊連線清理、模組載入或 hello 期間改欄位，只影響下一次明確送出，不把新房間資料混入舊主機的加入請求。房間 ID／代碼／名稱沿用原 trim，空白代碼仍省略；驗證失敗不載入模組或建立連線。此頁會執行所選主機提供的 JavaScript，請只使用可信任主機；送出快照避免操作時序混用，不是對惡意模組的隔離。

它沒有房間麥克風音量表，因此明確設定 SDK `enableMicMeter: false`，避免建立未使用的 Web Audio 音量計；擷取／靜音／舞台操作不變，SDK 預設與獨立麥克風預覽仍保留音量計。初次加入會顯示載入元件、連線、加入房間的進度，submit 按鈕以 `aria-busy` 標示等待；首次房間快照前可按「取消連線」結束這次本機等待，隨後可手動重新提交。取消會忽略舊 import／hello／加入結果及其回報，但不保證中止下載、立即完成底層關閉或回滾伺服器操作；一旦觀察到房間狀態，改用房內離開控制，不再開放初次取消。房間快照與當前錯誤優先，不必等 ACK 才顯示已進場。初次加入尚未收到 ACK 時若已收到房間狀態並選擇離開，晚到的加入失敗不會覆蓋離開提示；關房／被踢與新一輪加入亦撤銷舊 attempt 的回報及解鎖權限，當前加入失敗仍正常顯示。台上者另有麥克風靜音／取消靜音按鈕，依伺服器快照呈現目前狀態；待回覆、重新連線或遭主控強制靜音時停用，下台即隱藏。它與 audio 元件的本機收聽控制分開，不會自行重試擷取或要求新權限；舊房間操作的晚到回覆不解鎖新房間按鈕。另有個人舞台按鈕：台上者可「離開舞台」而繼續收聽，台下主控可依原伺服器政策「返回舞台」；一般台下觀眾仍走舉手流程。強制靜音不妨礙下台；待回覆與重連期間停用，快照提前變更角色或文字也不提早解鎖。返回舞台仍沿用既有 SDK 的擷取／權限流程。在台上的麥克風擷取失敗時，可明確按「重試麥克風」，不必離房；只有按下按鈕才呼叫既有 retryMicrophone，沒有自動重試。等待期間標示 aria-busy，離房／終止連線、下台或換房會撤銷舊操作；同席重連保留重試狀態但暫停按鈕。SDK 回 false 時保留當前錯誤且恢復按鈕。「已取得麥克風」只表示 micready 擷取階段，並不保證音軌安裝、協商或其他人已聽到，後續真正失敗仍正常顯示。已舉手時，收回按鈕會依最新個人快照的 hands 顯示自己的佇列位置，重連期間標示「上次」；快照沒有自己時保留一般收回文字，不推算等待時間或保證發言順序，也不顯示其他人的名稱。其舉手／收回按鈕只供台下非主控使用；若自動繼任的主控仍在台下，也不會開放無效的舉手操作，並取消原有倒數。按鈕在待回覆期間保持停用並標示 `aria-busy`，狀態更新或冷卻計時不會提早解鎖；完成後重新套用目前角色、重連與冷卻限制。只有畫面顯示舉手冷卻倒數時才排程下一個整秒邊界，閒置不持續輪詢按鈕。完整範例與 Web Component 也會在同席重連的 `hello.limits` 改變時提前新的冷卻邊界，避免沿用較晚的舊 timer。手動啟用音訊的晚到失敗只回報到原連線生命週期，離房／關房／被踢的提示不會被取消播放的錯誤覆蓋；當前啟用失敗仍可重試。

## 測試與驗證

```bash
npm run typecheck                # 伺服器＋client＋web
npm test                         # 控制面流程 1–4、不變量、斷線寬限與回座、信令與政策競態、ws 邊界（驗證、限流、尺寸、轉義、靜態檔、准入）、混音器與時鐘、下行分級／共用編碼／靜音 DTX、worker 重生
node --test --test-timeout=20000 test/roomSequences.test.ts # 固定 seed 的房間模型轉換與快照／拒絕原子性檢查
node scripts/werift-loopback.ts 0 # 真 werift 端到端（主執行緒，含觀眾→發言者重協商、client 端 ICE restart）
node scripts/werift-loopback.ts 2 # 同一流程驗證 media worker 模式
node scripts/bench-ws-backpressure.ts unbounded # 慢速讀取端基準（無上限，僅限本機壓測）
node scripts/bench-ws-backpressure.ts bounded   # 同一測試含待送上限；量測 queued bytes／RSS／健康連線 RTT
node scripts/bench-ws-inbound.ts # gated 工作下的佇列筆數／payload 比較，非 RSS／延遲量測
node scripts/bench-control-plane.ts --hands # 真實本機 WebSocket＋Mock 媒體，含舉手突發／回座／停機
node scripts/bench-audience-count.ts # 觀眾計數 getter 的有界比較
node scripts/bench-mixer.ts      # 混音壓測：3／8 發言者 × 300 訂閱者
node scripts/load-test.ts        # 全端壓測：3 發言者＋298 werift 觀眾（--speakers/--audience/--seconds/--procs/--url）
npm audit
```

`test/roomSequences.test.ts` 使用 12 個固定 seed、每個 500 步，混合 17 種模型操作與時鐘前進／回撥／同值。獨立的成功操作 ledger 檢查入場／上台／舉手順序、每位接收者的快照與私人欄位；拒絕操作必須保持完整原狀，固定邊界案例另驗證權限與容量。失敗訊息包含 seed 與 action trace，參與者最多 20 人；這是有界狀態模型覆蓋，不是所有序列的證明或網路／媒體壓測。

完整範例的 `test/webLifecycle.test.ts` 會執行整份 `web/src/main.ts`（只替換 SDK／CSS imports），透過實際註冊的表單、按鈕與 SDK event handlers 驗證離房／重入、預覽取消與晚到完成、統計／冷卻排程、preview→stage meter 切換及關房／kick 通知。fixture 使用可斷開／重掛 DOM、依 SDK 順序派發的 stub events 與有 callback 上限的虛擬時鐘；沒有真實網路、麥克風或新依賴。這補足函式片段測試的初始化／事件串接覆蓋，不替代瀏覽器版面、原生輸入／accessibility、權限提示、CSS 或真實 SDK／WebRTC 整合驗證。

範例的品質警示沿用每次 render 的 participant→rows 索引，只更新前次／本次品質報告涉及的人，省去每則事件掃描所有觀眾列；省略的人仍會移除舊警示，同人出現在舉手與觀眾名單時會一併更新。`test/webQuality.test.ts` 以 301 人、593 個顯示列、100 次單人品質報告計數：完整列查詢 100 → 0 次，badge 查詢 59,300 → 100 次。這是 fake DOM 操作數，不是瀏覽器 CPU／延遲量測；房間重繪、品質資料本身的更新頻率與 badge 文案不變。

完整範例收到與目前畫面相同的房間快照時，會重用參與者列與操作按鈕；仍同步 pending、冷卻倒數與提示。快照、連線狀態、邀請代碼或尚未套用的 speaking／quality 輸入改變時照常重建；已由事件就地更新的 speaking／quality 會同步各自呈現記錄，之後相同房間快照不再因此重建。兩種覆蓋資訊各自比對，漏發事件或共用物件被改動仍可由下一個快照發現；已拖動但尚未由伺服器確認的 gain slider 仍會按原行為回復 authoritative 值。離房清除快取，同房重加也重新建立節點。受控 fake DOM 的 301 席、10 次相同快照工作量，createElement 次數由 21,630 降為 2,163，主要內容替換由 10 次降為 1 次。另一個 100 席、100 次 speaking／quality 事件後接相同快照的受控工作量，主要內容替換由 100 次降為 0 次，新增假 DOM 節點由 75,701 降為 1 個警告 badge。每次房間快照仍序列化／比較完整狀態與覆蓋資訊、檢查 gain input；speaking／quality 事件只各自序列化剛套用的資訊。只保留目前三份 signature 及 gain input 參照，並非零配置或固定時間；以上是合成操作數，未驗證瀏覽器 CPU、記憶體、焦點或延遲改善。

完整範例預設連到同主機 `/ws`；自訂 `server.wsPath` 的部署可開啟 `/?wsPath=%2Fcontrol`。頁面載入時只讀取一次 `wsPath`，缺省／空白沿用 `/ws`，不自動探測設定。驗證沿用最小 embed 的單一 leading slash／same-origin 路徑限制；不允許 authority、反斜線、query／fragment、raw control、內部空白或普通／encoded-dot segment。安全百分比序列不再解碼，Unicode 依 URL 規則序列化；server 設定須匹配序列化 pathname。無效參數會保留表單並顯示固定錯誤，建立／加入在開啟 socket 前中止，需修正網址後重新載入；不會偷偷改連預設路徑。邀請連結只加入已驗證的非預設 `wsPath`、房間 ID 及原有允許的房間代碼，不複製其他 query／fragment；即使頁面 pathname 以 `//` 開頭，邀請仍保留目前 origin。Vite 開發代理預設仍只代理 `/ws`，自訂路徑需另行設定代理。

完整範例的建立／加入表單尚未收到房間狀態、且仍屬於同一個進房畫面時，若收到該次請求的 `bad_request`，保留原始錯誤訊息與代碼，並補充檢查名稱、房間資料是否符合伺服器規則的中文指引。這不判定是哪一欄失敗，也不假設名稱長度上限：`limits.nameMaxLength` 可由部署端自訂，目前 hello 不公布此值。輸入保持可編輯，其他錯誤及獨立媒體／RTC 錯誤仍按原本訊息顯示；已取消或主動離房的舊建立／加入回覆不重新顯示指引；已收到房間狀態、終止或重建進房畫面的舊請求只保留原有一般錯誤處理。沒有更動輸入 maxlength、驗證或 SDK 錯誤物件。

主控的完整範例提供「篩選觀眾名稱」：只在已授權的觀眾名單中，以顯示名稱做去除查詢首尾空白、不分大小寫的字面子字串比對；查詢與解碼後名稱先採 NFC 正規化，讓組合／分解形式相同的字元（例如 é 或韓文字）一致，與伺服器名稱正規化對齊，不移除重音或做 NFKC 相容字元折疊；中文與重複名稱皆保留原順序，不比對 participant ID。輸入只隱藏／顯示既有觀眾列，不重建整個房間，也不影響舞台、舉手佇列、pending 操作或伺服器名單。空白查詢與「清除篩選」恢復全部觀眾，另顯示符合筆數或無結果提示。查詢僅留在記憶體，同席快照與重連保留；換房、換身分、失去主控／名單權限或離房清除，不寫網址或 storage。篩掉的觀眾操作與舊已移除列不能藉程式 click 繞過目前角色／pending 檢查。搜尋欄位在房間重畫時保留同一連接節點；原生焦點、輸入法、鍵盤／輔助科技與版面仍需實際瀏覽器驗收，測試只驗證受控 DOM 行為。

### 本機控制面容量煙霧測試

`node scripts/bench-control-plane.ts` 只在 `127.0.0.1` 啟動臨時伺服器，依範本的 300 位觀眾上限，以每批 50 條真實 WebSocket 驗證進房、Mock SDP、滿房拒絕、10 位斷線回座與全體關機通知。30 秒硬期限避免卡住；完成即關閉連線與伺服器。輸出 ACK 延遲分位數、CPU、取樣 RSS 高點、事件迴圈延遲與訊息量，並檢查可用的輸入／輸出超限計數器為零（舊版無該指標時輸出 `null`）。

這不是音訊容量驗收：媒體使用 `MockMediaTransport`，混音器不啟動，負載產生器與伺服器共用 Node 程序，所以資源／延遲包含兩者，也不代表跨網路或實際 WebRTC 表現。presence 合併視窗會讓不同次執行的快照數不同；請使用相同環境、多次比較，不把單次小幅差異當成加速證據。完整媒體測試仍使用 `scripts/load-test.ts`。

`node scripts/bench-control-plane.ts --hands` 另驗證 300 位同時舉手、其中一半收回、所有接收端事件順序與最終快照一致，並繼續回座／關機檢查。舉手與收回事件仍立即可靠廣播，發起者仍在 ACK 前取得自身新快照；其他人的完整 `room:state` 合併到下一輪事件迴圈。每房最多一個待送快照計時器，不逐次延後；台位／控制權等變動仍即時送完整狀態，並取代待送快照。觀眾離開或寬限期到期造成的純收回事件也合併快照。這能避免多人同時舉手時反覆傳送日益增長的完整排隊名單，讓正常接收端不因控制面突發流量觸發輸出上限。

### 觀眾計數 microbenchmark

重複送出已生效的個人靜音／取消靜音、強制靜音／解除或相同 gain 時，Hub 仍執行原有權限與模型檢查，但不把完全未變的狀態再次廣播全房；發起者照常在 ACK 前收到自己的個人化快照。判斷依 selfMuted／forceMuted／gainDb 原值，不以「沒有 mic event」推斷，因此有效靜音不變、但底層靜音旗標改變時仍完整廣播。既有待送 presence／舉手快照保留，真正變動與 mixer gain setter 的執行方式不變。

`node scripts/bench-audience-count.ts` 比較舊逐人掃描與目前觀眾計數 getter：以 1／9／301 人的合法房間、主控在台／離台及零／滿額發言者，warm-up 後交錯執行固定次數並核對 checksum。目前計數從 participant／speaker 集合大小取得，不掃描參與者、不新增快取狀態。這只是 getter 的 JIT microbenchmark，不代表整個 snapshot／廣播／請求的延遲；主控名單、invariant 掃描、序列化與 fan-out 仍照常執行。

## 授權

[Apache License 2.0](LICENSE)
