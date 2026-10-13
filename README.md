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
npm run build
npm start
```

開啟 <http://127.0.0.1:9728/>：建立房間 → 複製邀請連結 → 另一個瀏覽器開啟連結加入。範例設定為本機開發模式（明文 ws、只綁 127.0.0.1）。

開發模式：

```bash
npm run dev        # 伺服器（node --watch src/index.ts）
npm run dev:web    # Vite 前端開發伺服器，/ws 代理到 127.0.0.1:9728
```

### 靜態資源預壓縮

`npm run build` 最後以 Node 內建 zlib 為 client／web 的 HTML、JS、CSS、JSON、SVG 與 webmanifest 產生較小的 `.br`／`.gz` 副本；不壓縮圖片、已編碼檔或 symlink，壓縮後較大的副本不保留。也可在兩個 workspace 都完成建置後單獨執行 `npm run build:compress`，或 `node scripts/precompress.ts <建置目錄>`；指令會列出原始／Brotli／gzip 位元組數。

伺服器依 `Accept-Encoding` 的權重與排除規則選擇可用版本（同權重優先 Brotli），附 `Vary: Accept-Encoding`、各版本獨立 ETag 與正確 Content-Length。HEAD 與 304 保持相同的編碼資訊，未預壓縮或副本比來源舊時退回原檔；用戶端明確排除所有可用版本才回 406。不會在請求期間壓縮，也不會重複壓縮 `.br`／`.gz` URL。部署時請將原檔與副本一起更新；Vite 開發模式仍維持原工作流程。

靜態掛載會同時檢查 URL 路徑與解析 symlink 後的實際路徑；原始檔或壓縮 sidecar 不可指向該掛載實際根目錄之外。仍允許根目錄內的來源檔 symlink，以及設定成 release 目錄 symlink 的掛載根；根目錄切換或稍後才完成的 build 不需重啟服務。壓縮 sidecar 本身仍須為一般檔案。這是意外／既有 symlink 越界的防護，不是對具有資產目錄寫入權者的競態安全檔案沙箱；部署時不要讓非信任程序寫入公開資產樹。

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

### 慢速讀取端

每條 WebSocket 的待送資料加上下一則 JSON 的 UTF-8 位元組若超過 `limits.maxSendBufferBytes`，伺服器立即中斷該連線以釋放緩衝，不影響其他連線。此為非主動離開，仍依既有斷線寬限保留席位與音訊，client 可自動回座取得最新 snapshot。請將上限設得足以容納最大房間 snapshot；持續無法接收完整 snapshot 的 client 會再次斷線。`stage_ws_backpressure_disconnects_total` 記錄此類中斷次數。

### 監控與停機

`GET /healthz` 回 `ok`（程序存活）；`GET /readyz`／`HEAD /readyz` 表示是否接收新工作，正常回 200，開始停機即回 503／`draining` 且禁止快取，並拒絕新的 WebSocket upgrade（503）。它不是媒體連線健康檢查；存活探針在排空期間仍為 200。停機會先停止既有連線的待處理／新控制工作，再發房間停機通知與關閉握手；已開始的工作不強制取消。房間／WebSocket 清理完成後，HTTP listener 停止接收連線，既有回應最多等待 `server.httpShutdownDrainMs`（預設 1000ms，整數 0–60000，0 表示立即切斷）；逾時會關閉尚未完成的 HTTP socket，避免慢速下載或卡住的 metrics 回應阻止退出。這只限制最後 HTTP 網路排空階段，不是整體停機期限，也不取消底層統計收集 promise。`GET /metrics` 回 Prometheus 文字格式（`Authorization: Bearer <server.metrics.token>`），包含房間／連線／發言者數、上下行封包與補幀數、DTX 省略幀、全房無聲時跳過編碼的幀數（`opus.dtx` 開啟且台上全員靜音、沒有上行或持續全零 PCM 超過 1 秒時，混音不再編碼、直接以 DTX 處理）、low tier 聽眾數、codec backlog 與丟幀、mixer underrun／漂移丟幀／tick 延遲、event loop delay 與記憶體。同一伺服器上重疊的已授權 scrape 共用尚未完成的統計收集，避免重複掃描房間與查詢 worker；收集完成或失敗立即釋放，下一次請求重新取樣，不保留過期快取。

### 輸入工作佇列

`limits.maxPendingMessages`（預設 128）與 `limits.maxPendingBytes`（範例 1 MiB；舊設定為 `maxFrameBytes × 16`）限制每條 WebSocket 等待處理的工作，以訊息數與 JSON UTF-8 位元組分別計算。正在執行的一筆不計入等待上限，仍受單幀上限限制。超過任一上限立即終止該連線並清除等待工作，沿用非主動離開的席位寬限；實際 socket 關閉時立即解除既有連線綁定並依房間佇列標記離線，讓卡住的 SDP 不阻擋同席回座。一般斷線也丟棄尚未開始的工作；已開始的工作不強制取消，完成後再次清理可能遲到的 join 綁定，不會移除已回座的新連線。席位寬限從這次離線處理開始，不等待 SDP 完成。Prometheus `stage_ws_inbound_queue_disconnects_total` 記錄超限次數。正常順序與每秒頻率限制不變。`node scripts/bench-ws-inbound.ts` 比較 gated 工作下舊 promise chain 與有界佇列的待處理筆數／payload 位元組及斷線後執行數；這不是 RSS 或延遲 benchmark。

伺服器限流以單調經過時間計算，不以牆鐘時間計算，避免系統校時讓正常連線誤觸限流或提早補滿配額；房間時間戳與日誌仍保留正常 UTC／epoch 語意。

### 結構化日誌遮蔽

logger 會遞迴遮蔽物件／陣列中的 `code`、`resumeToken`、`token`、`credential`、`password`、`username`、`secret`、`sdp`、`payload` 欄位（不分大小寫），不修改原物件。循環、深度 8 或超過 1000 個欄位／元素的結構使用標記截斷；getter、toJSON 與 Proxy 不執行。深度／欄位上限限制遞迴複製與輸出結構，不限制 Object.keys 列舉成本或任意字串的位元組數，呼叫端仍應使用精簡欄位。Error 的資料型 name／message／stack／cause 保留並遞迴處理，accessor 型 stack 以標記表示；Date 與 bigint 安全轉成字串。這只是欄位名稱防護，不會辨識任意訊息／字串裡的秘密，呼叫端仍不得把憑證或原始 SDP 混進 log message。

## WebSocket 協定摘要

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
| `room:rotate-code` | 主控更換房間代碼（限需代碼的房間）；舊代碼／邀請連結立即失效，已在房內的人不受影響 |
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

連線品質收集每房間同時最多一輪；完成後再等待 `qualityIntervalMs` 啟動下一輪。個別 publisher 統計失敗只略過該人的本輪資料，其他人的回報照常；全部失敗時不送空報告，但下一輪仍會重試。失敗不會被當作 0% 掉包，恢復後上行差量從上次成功樣本計算。關房或最後一位停止發布後不再排程；離台再發布的舊統計結果會被忽略。

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

不想寫 JavaScript 的頁面可改用 Web Component：`<script type="module" src="https://stage.example.com/lib/stage-element.js"></script>` 後放 `<stage-client room="…" code="…" name="…"></stage-client>`（內建狀態列、啟用音訊、舉手、台上靜音／下台；事件以 `stage-<type>` 派發，`element.client` 取得底層 `StageClient`）。

連線中取消、關房與被踢會完整停止麥克風／麥克風測試並清除待回覆請求；同一個 client 可在取消後重用。Web Component 快速移除／重掛載時只接受最新一次連線的事件，音訊解鎖失敗可重試，成功後隱藏按鈕。

本機收聽可用 `setPlaybackVolume(0.5)`／`setPlaybackMuted(true)` 調整，`playbackVolume`／`playbackMuted` 即時讀取；不影響麥克風或其他人，重連時保留。範例前端的「音訊設定」也提供音量與靜音收聽控制。

範例會在本機瀏覽器記住你明確調整的收聽音量與收聽靜音，下次載入先套用，再加入房間。只使用同 origin 的 `stage-playback` localStorage 記錄（version 1、音量 0–1、boolean 靜音）；缺少、無效、超過 128 字元或讀取失敗時保留預設音量 100%／未靜音；寫入失敗仍會套用當次調整，只是不保證下次還原。音量 0 與靜音各自獨立；麥克風、裝置、房間與帳號資料不儲存在此記錄，沒有跨分頁同步。清除該網站的儲存資料即可回到預設。

麥克風音量表只在本機測試或台上未靜音時每 50ms 更新；自身／主控靜音後立即歸零並停止輪詢，解除後恢復。收聽靜音不影響麥克風音量表，房間的 2 秒連線統計排程也不變。

範例的「點擊啟用音訊」結果綁定當次房間身分；離房會暫停音訊，尚未完成的播放可能因此拒絕，但舊操作不會把這類錯誤顯示到入口／新房。當前房間的失敗仍可重試；SDK 的 `unlockAudio()` promise 與瀏覽器自動播放政策不變。

範例的邀請連結複製提示只接受最新一次操作，且房間身分與目前連結仍須相符；離房／換碼後的晚到結果不會覆寫新通知。快照重繪未改變連結時，複製失敗會選取目前畫面上的連結供手動複製。這只隔離提示與選取行為，不能取消或還原已交給瀏覽器的剪貼簿寫入。

音訊裝置清單只套用最新一次列舉結果，避免啟動、麥克風就緒與裝置變更的舊回覆蓋掉新清單；列舉失敗時保留已顯示內容，之後成功更新仍可恢復。

發言中標示依目前渲染的參與者索引更新，只切換有變化的列；同人出現在舉手與觀眾名單時會一併更新，重繪／離房不保留舊列。

範例前端的建立／加入房間表單共用一個等待鎖；任一請求進行中，兩個提交按鈕一起停用並標示 `aria-busy`，鍵盤提交也不會重複送出，完成或失敗後恢復。 尚未收到房間狀態時可按「取消連線」，透過 SDK `disconnect()` 結束本機等待；這次取消的建立／加入錯誤不顯示，原請求結束後才能重新提交。收到房間狀態後不再提供取消，請使用房內的離開控制；取消不保證回滾伺服器已接受的操作。

範例前端的個人靜音、上下台、舉手與主控管理按鈕，在等待回覆期間保留停用狀態與 `aria-busy`，不會因冷卻 tick 或房間快照重繪而再次送出。離房／切換身分會清除舊 pending 狀態，舊完成事件不會解鎖新房操作；核准／婉拒／移出舞台共用每人的 pending key，強制靜音與解除亦共用；控制權移交在全列表保留單一 pending，換碼與關房也受保護。舊房間換碼完成不會覆寫新房通知。音量 slider 不在這個按鈕保護範圍，仍逐次送出放開時的值；離房後才完成的舊 gain 請求不再顯示錯誤到入口／新房，當前房間的失敗仍正常顯示。 舉手倒數只在畫面可見且尚未歸零時排程下一個顯示秒數邊界；沒有倒數時不執行冷卻輪詢，房內連線統計仍每 2 秒更新；只有目前房間最新一次請求可更新顯示，舊輪詢／離房前的延遲結果不會清空新資訊。

範例的麥克風測試與輸入裝置切換共用操作鎖，避免切換途中重複啟動預覽。離房後的晚到預覽只會停止自己的串流，不會覆寫新預覽或解鎖新的操作；SDK 仍允許呼叫端各自管理獨立預覽。

完整 API 見 [`packages/client/README.md`](packages/client/README.md)；`web/embed.html` 是最小嵌入範例。

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

### 本機控制面容量煙霧測試

`node scripts/bench-control-plane.ts` 只在 `127.0.0.1` 啟動臨時伺服器，依範本的 300 位觀眾上限，以每批 50 條真實 WebSocket 驗證進房、Mock SDP、滿房拒絕、10 位斷線回座與全體關機通知。30 秒硬期限避免卡住；完成即關閉連線與伺服器。輸出 ACK 延遲分位數、CPU、取樣 RSS 高點、事件迴圈延遲與訊息量，並檢查可用的輸入／輸出超限計數器為零（舊版無該指標時輸出 `null`）。

這不是音訊容量驗收：媒體使用 `MockMediaTransport`，混音器不啟動，負載產生器與伺服器共用 Node 程序，所以資源／延遲包含兩者，也不代表跨網路或實際 WebRTC 表現。presence 合併視窗會讓不同次執行的快照數不同；請使用相同環境、多次比較，不把單次小幅差異當成加速證據。完整媒體測試仍使用 `scripts/load-test.ts`。

`node scripts/bench-control-plane.ts --hands` 另驗證 300 位同時舉手、其中一半收回、所有接收端事件順序與最終快照一致，並繼續回座／關機檢查。舉手與收回事件仍立即可靠廣播，發起者仍在 ACK 前取得自身新快照；其他人的完整 `room:state` 合併到下一輪事件迴圈。每房最多一個待送快照計時器，不逐次延後；台位／控制權等變動仍即時送完整狀態，並取代待送快照。觀眾離開或寬限期到期造成的純收回事件也合併快照。這能避免多人同時舉手時反覆傳送日益增長的完整排隊名單，讓正常接收端不因控制面突發流量觸發輸出上限。

### 觀眾計數 microbenchmark

`node scripts/bench-audience-count.ts` 比較舊逐人掃描與目前觀眾計數 getter：以 1／9／301 人的合法房間、主控在台／離台及零／滿額發言者，warm-up 後交錯執行固定次數並核對 checksum。目前計數從 participant／speaker 集合大小取得，不掃描參與者、不新增快取狀態。這只是 getter 的 JIT microbenchmark，不代表整個 snapshot／廣播／請求的延遲；主控名單、invariant 掃描、序列化與 fan-out 仍照常執行。

## 授權

[Apache License 2.0](LICENSE)
