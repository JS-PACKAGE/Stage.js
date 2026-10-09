# AGENTS.md — Stage.js 撰寫規範

給所有實作方（人或 Agent）的硬規則。需求與決策的真值來源是 [`PLAN.md`](PLAN.md)；本檔規定**怎麼寫**。

## 語言與風格

- TypeScript（`strict`、`noUncheckedIndexedAccess`、`erasableSyntaxOnly`、`verbatimModuleSyntax`），ESM。目標 **Node.js v24**（`engines: >=24`）。
- 伺服器原始碼直接以 Node type stripping 執行：相對 import **必須帶 `.ts` 副檔名**；不可用 enum、namespace、constructor parameter properties；純型別一律 `import type`。
- 依賴一律釘選精確版本（`package.json` 無 `^`／`~`）。控制面只用 `ws`＋`yaml`；媒體層 `werift`＋`@evan/opus`（只取其內附的 libopus WASM，由 `src/transport/opus.ts` 自行實例化）；前端 vanilla TS＋Vite。新增依賴前先確認標準庫或既有依賴做不到。不要換回 `opusscript`（0.1.1 以 byte 指標當 `HEAPU16` index，PCM 寫到 2× 位址造成 heap 損毀）或 `@discordjs/opus`（0.10.0 在 arm64 走 SILK 會 segfault）。
- 設定值一律來自 `config.yaml`（範本 `config.example.yaml`），程式不得寫死埠號、上限、編碼參數、STUN/TURN。新增設定鍵時同步更新 `src/config.ts` 驗證、`config.example.yaml`、README。
- UI 與使用者訊息用繁體中文；程式碼、log、協定欄位用英文。
- 註解只寫「為什麼」與非顯而易見的限制。

## 建置與測試

```bash
npm install                    # 安裝（workspaces：packages/client、web）
npm run typecheck              # 伺服器＋client＋web 型別檢查
npm test                       # node --test（MockMediaTransport，無需 WebRTC 環境）
npm run build                  # tsc → dist/，vite → packages/client/dist、web/dist
npm start                      # node dist/src/index.js（讀 ./config.yaml 或 $STAGE_CONFIG）
npm run dev                    # node --watch src/index.ts
node scripts/werift-loopback.ts [N]  # 真 werift 端到端：上行解碼、混音、不含自己、觀眾上行封鎖、觀眾→發言者重協商；N＝rtc.mediaWorkers
node scripts/bench-mixer.ts      # Gate 3：8/3 發言者 × 300 訂閱者混音延遲
node scripts/load-test.ts        # 全端壓測：自起伺服器，K 發言者＋N werift 觀眾（多 process），回報掉包、beep 端到端延遲、/metrics
```

改動媒體層（`src/transport/`、`src/mixer/`）後必跑 `werift-loopback`（`0` 與 `2` 各一次，兩種 peer host 都要過）；改動控制面後必跑 `npm test`。

## 結構對應

| 路徑 | 職責 |
|---|---|
| `shared/protocol.ts` | ws 協定型別（server 與 client 共用的**唯一**真值來源） |
| `src/model/room.ts` | 單一房間狀態機與不變量（純同步、無 I/O） |
| `src/model/errors.ts` | `StageError`（回 client 的錯誤碼）、`InvariantViolation`、固定 generic 訊息 |
| `src/ws/hub.ts` | 房間註冊、每房 `SerialQueue`、事件廣播、與媒體層耦合 |
| `src/ws/server.ts` | HTTP(S)＋ws 伺服器、每連線限流與順序、心跳、靜態檔 |
| `src/ws/validate.ts`、`rateLimit.ts` | 輸入白名單驗證、name 清洗轉義；token bucket 限流 |
| `src/rtc/sdp.ts` | offer 方向解析（觀眾 recvonly 強制，與 WebRTC 實作無關） |
| `src/transport/MediaTransport.ts` | 媒體層契約 |
| `src/transport/WeriftMediaTransport.ts`、`opus.ts` | werift adapter（主執行緒：peer 配置、上行重排／解碼、混音分送、publisher 關卡）、Opus 編解碼（@evan/opus） |
| `src/transport/peerHost.ts` | `PeerHost` 介面與 `WeriftPeerHost`：PeerConnection、方向政策、上行第二道關卡、RTP 打包／DTX 省略 |
| `src/transport/mediaShards.ts`、`mediaWorker.ts` | `MediaShard`：在 worker thread 上跑 `WeriftPeerHost`（`rtc.mediaWorkers`；0＝主執行緒）；worker 掛掉時回報其 peer 已關閉並重生 |
| `src/transport/codecPool.ts`、`codecWorker.ts` | Opus 編解碼 worker thread pool（`audio.codecWorkers`）；每房固定一個 worker，維持有狀態 codec 的順序 |
| `src/transport/jitter.ts` | 上行 RTP 重排（`audio.jitter.reorderPackets`）；遺失包以 `null` 送解碼器，由下一包的 in-band FEC 還原，沒有 FEC 時走 libopus PLC |
| `src/transport/MockMediaTransport.ts` | 測試／無 WebRTC 開發用 |
| `src/mixer/` | `RoomMixer`（N 路疊加、mix-minus-self、每路 playout 預緩衝／underrun 重緩衝／漂移排空、緩衝上限）、`limiter` |
| `packages/client/` | 可嵌入的瀏覽器 ESM 函式庫 `StageClient` |
| `web/` | 完整範例前端（建於 client 之上） |
| `src/metrics.ts` | Prometheus 文字輸出、跨房共用的 `MixerCounters`、event loop／記憶體取樣；`/metrics` 由 `server.metrics` 控制（對外 host 必須設 token） |

## 媒體層規則

- 核心（`src/model`、`src/ws`、`src/mixer`）**只透過 `MediaTransport` 介面**操作媒體；不得 import werift。換 WebRTC 實作＝新增 adapter，不動核心。
- PCM 慣例：mono Float32、`audio.sampleRate`（48kHz）、`frameMs`（20ms＝960 samples）。Opus 編解碼與混音同取樣率，**不重取樣**；RTP 時鐘恆為 48kHz（RFC 7587）。
- 觀眾共用一個 encoder（每房一次編碼分送全體）；只有台上者各有 mix-minus-self encoder。不得引入「每位觀眾一個 encoder」。
- Opus 一律走 `src/transport/opus.ts`：它直接實例化 `@evan/opus` 內附的 libopus WASM（套件的 JS wrapper 寫死 `decode_fec = 0`、不能解遺失包，等於沒有 FEC／PLC）；不要改回套件的 `Encoder`／`Decoder`，也不要用其 N-API addon（以 process 全域暫存區編解碼，多執行緒同時使用會互相污染封包）。每條執行緒各有一份 WASM 記憶體，`test/codecPool.test.ts` 守跨執行緒不互相污染。
- werift：伺服器 transceiver 必須在 `setRemoteDescription` **之前**設成政策方向，否則重協商時新 SSRC 不會被登錄（見 PLAN 十二-11）。

## 安全性（PLAN.md 第六節，逐條為硬規則）

**S1. 對外強制 wss/TLS。** 明文 ws 僅限本機開發：`server.allowInsecure: true` **且** host 為 loopback 才啟動（`src/config.ts` 啟動時檢查，fail-closed）。對外部署設 `allowInsecure: false` 並提供憑證，或由本機反向代理終止 TLS。

**S2. 角色由伺服器狀態機強制。** 觀眾端 SDP 僅接受 `recvonly`；未經核准不得上行音軌；違規 offer 整筆拒絕（`forbidden`，fail-closed）並記 warning。上行封包僅在「已登錄 publisher 且最後一次協商允許上行」時才進混音器——兩道關卡缺一不可（werift 在 recvonly answer 下仍可能收發 RTP）。

**S3. 輸入驗證＋尺寸上限。** frame ≤ `limits.maxFrameBytes`（64KB，超過由 ws 以 1009 關閉）；所有欄位白名單逐一重建（未知欄位丟棄）；name ≤ 32 字元、移除控制／格式字元後 HTML 轉義；`targetId` 必須是同房既有 participantId（否則 `not_found`）；未知 type 回 `unknown_type`、不執行。

**S4. 每連線頻率限制。** 控制訊息 ≤ `controlPerSecond`（20/s）、`hand:raise` ≤ 1 次／`handRaiseIntervalMs`（10s）、`rtc:ice` ≤ `icePerSecond`（30/s）；任一超過即以 close code 1008 斷線並記 warning。無法解析的 frame 也計入控制額度。

**S5. 憑證不入庫、不入日誌。** STUN/TURN（coturn）設定只放 `config.yaml`（已在 `.gitignore`），入庫的是 `config.example.yaml`。TURN 一律用 `rtc.turn` 短期憑證（`src/rtc/turn.ts`：`<到期秒>:<participantId>`＋HMAC-SHA1），只經 `rtc:config` 發給已進房者；`rtc.turn.secret` 永不離開伺服器。不得把長期 TURN 帳密放進 `rtc.iceServers`。

**S6. 競態保證。** 每房一條 `SerialQueue`：所有狀態變更與該房信令依序原子套用；每連線訊息依序處理。狀態機每次轉換後檢查不變量；「雙主控」等違例拋 `InvariantViolation` → 關房（fail-closed）。單一 client 的信令錯誤只回該請求錯誤，不得關房。

**S7. 資源防護。** 每房發言者 ≤ 8、主控以外人數 ≤ 300（裁示定值）；全域 `maxRooms`、`maxConnections`；混音每路 PCM 緩衝上限 `mixer.maxBufferedFrames`（超過丟最舊）、limiter 防爆音；超過上限拒絕新上行／新連線（`stage_full`／`room_full`／HTTP 503）。

**S8. 對外一律 generic 錯誤。** client 只收到 `ERROR_MESSAGES` 的固定訊息；內部原因（`StageError.detail`、例外字串）只入本地日誌。使用者可控文字（name、roomName）一律轉義後輸出。

**S9. 依賴釘選、`npm audit` 無 high 以上。** 升版需重跑 audit、測試與 `werift-loopback`。

**S10. 進場驗證＝房間代碼。** 建立時以 `crypto.randomInt` 產生（`rooms.codeLength` 碼，去除易混字元），可於建立時關閉；常數時間比較；房間不存在與代碼錯誤同為 `unauthorized`。代碼、`resumeToken` 不入日誌（`src/log.ts` 另有欄位名遮蔽作保險）。client 需嵌入第三方網站，ws **不採 Origin 白名單**，改以房間代碼＋限流＋上限防護。

## 協定變更流程

1. 改 `shared/protocol.ts`（server 與 client 同時受型別檢查約束）。
2. 改 `src/ws/validate.ts` 白名單與 `src/ws/hub.ts` 處理。
3. 補 `test/hub.test.ts` 或 `test/server.test.ts` 的行為測試。
4. 同步 README 協定摘要與 PLAN.md「十二」。
