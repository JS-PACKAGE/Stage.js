# Stage.js

多人音訊舞台系統：**WebSocket** 為控制平面、**WebRTC** 為音訊平面。一位主控＋最多 8 位發言者在台發言；觀眾只能聆聽，可舉手由主控核准上台。多人同時發言由**伺服器端混音**成單一 Opus 串流（mono、VBR 32–128kbps、48kHz）分送全場。單一 process 承載多個房間，以房間代碼進場。

交付內容：Node 伺服器、可嵌入其他網站的瀏覽器 client 函式庫（ESM）、完整範例前端（響應式手機版、深淺色主題、多人列表管理）。需求與決策全文見 [`PLAN.md`](PLAN.md)，撰寫規範與安全規則見 [`AGENTS.md`](AGENTS.md)。

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

混音：每 20ms 一個 tick，各發言者取一個 960-sample frame 疊加。觀眾共用一次編碼（下行掉包持續偏高的觀眾改收另一路共用的低位元率＋高 FEC 編碼）；台上者各自一路 mix-minus-self 編碼。編好的封包送到持有該房 peer 的各 media worker，由它們各自打包、加密、送出。

## 需求

- Node.js **v24** 以上（`engines: >=24`；伺服器以 Node 內建 type stripping 直接執行 `.ts`）
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

Windows 用 `.\stage.ps1 <command>`，指令相同；Windows 無法對背景 node 送 SIGTERM，`stop` 為直接終止。

## 設定（`config.yaml`）

所有欄位必填，啟動時嚴格驗證，錯誤會指出欄位路徑。設定檔路徑可用環境變數 `STAGE_CONFIG` 覆寫。`config.yaml` 不入庫。

| 區塊 | 重點欄位 |
|---|---|
| `server` | `host`、`port`、`wsPath`；`allowInsecure`（明文 ws，僅限 loopback host）；`tls.certFile`／`keyFile`；`static` 靜態掛載（`/` → `web/dist`，`/lib/` → `packages/client/dist` 附 CORS）；`metrics.{enabled,token}`（`GET /metrics`，對外 host 須設 token）；`trustProxy`（反向代理後以 `X-Forwarded-For` 計算每 IP 連線） |
| `limits` | `maxRooms`、`maxConnections`、`maxConnectionsPerIp`（同一位址同時連線，0＝不限；NAT 或反向代理後多人共用位址，設定前先估算，代理後須開 `server.trustProxy`）、`joinTimeoutMs`（連上後未開房／進房的逾時，0＝不限）、`maxSpeakersPerRoom`（8，主控以外的台上者；主控席位另計）、`maxAudiencePerRoom`（300）、`maxFrameBytes`（64KB）、`controlPerSecond`（20）、`handRaiseIntervalMs`（10000）、`icePerSecond`（30）、`nameMaxLength`（32）、`codeMaxLength`（16）、`sdpMaxLength` |
| `rooms` | `codeLength`（8）、`controllerGraceMs`（主控斷線寬限 60000）、`participantGraceMs`（其他人斷線寬限 15000；期間保留席位、台位、舉手順位與 PeerConnection，音訊不中斷；0＝立即移除）、`heartbeatIntervalMs`、`presenceBroadcastMs`（觀眾進出合併 `room:state` 廣播的時間窗，250；進場者本人仍立即收到自己的 snapshot）、`qualityIntervalMs`（台上者連線品質回報間隔，2000；0＝停用）、`createToken`（非空時 `room:create` 須帶相同 `token`，否則 `unauthorized`；空字串＝任何人可開房，對外部署建議設定） |
| `audio` | `sampleRate`（48000；只接受 Opus 原生取樣率）、`frameMs`（20）、`codecWorkers`（Opus 編解碼 worker 數，房間平均分配到各 worker）、`opus.{vbr,minBitrate,maxBitrate,bitrate,complexity}`、`opus.fec`／`opus.packetLossPercent`（下行 in-band FEC 與預期掉包率）、`opus.dtx`（靜音不送包）、`lowTier.{enabled,bitrate,packetLossPercent,enterLossPercent,exitLossPercent}`（RTCP 接收報告顯示持續掉包的觀眾改收第二路共用混音：較低位元率＋較多 FEC，掉包回落後切回）、`mixer.{maxBufferedFrames,limiterThreshold}`、`mixer.latencyTargetMs`（僅供 `bench-mixer`／`load-test` 當驗收門檻）、`mixer.speakingThreshold`／`speakingHoldMs`（說話指示的 RMS 門檻與釋放延遲）、`jitter.playoutFrames`（每路上行預緩衝幀數）、`jitter.reorderPackets`（亂序容忍包數，超過即判定遺失並補幀）、`noiseFilter.{enabled,highPassHz,gateThreshold,gateHoldMs,gateFloor}`（伺服器端上行降噪：高通濾掉低頻雜音＋噪音門壓低說話間隙的背景音；瀏覽器端另開 `noiseSuppression`）、`loudness.{enabled,targetRms,maxGainDb,speechRms,adaptMs}`（伺服器端每路音量正規化：依說話時的平均音量把各發言者拉到相近大小，增益上限 ±maxGainDb） |
| `rtc` | `iceServers`（下發給瀏覽器的靜態 STUN）、`serverIceServers`（伺服器端 ICE）、`portRange`（`[]` 或 `[min, max]`）、`mediaWorkers`（承載 PeerConnection 的 worker thread 數，預設 2 對應 300 聽眾；0＝主執行緒）、`turn.{urls,secret,ttlSeconds}`（coturn `use-auth-secret` 短期憑證，每次進房以 HMAC 簽發；`urls: []` 停用） |
| `log` | `level`：`debug`／`info`／`warn`／`error`（房間代碼、token、憑證、SDP 一律不入日誌） |

對外部署：`allowInsecure: false`、`host: 0.0.0.0`、填 `tls`；開放 `rtc.portRange` 的 UDP；設定 `rtc.turn`（coturn 需 `use-auth-secret` 與相同的 `static-auth-secret`）。憑證檔更新（含 ACME 工具的改名／symlink 替換）後約 2 秒自動重載，不需重啟；新憑證載入失敗時沿用舊憑證並記 error。

監控：`GET /healthz` 回 `ok`；`GET /metrics` 回 Prometheus 文字格式（`Authorization: Bearer <server.metrics.token>`），包含房間／連線／發言者數、上下行封包與補幀數、DTX 省略幀、全房無聲時跳過編碼的幀數（`opus.dtx` 開啟且台上全員靜音或沒有上行超過 1 秒時，混音不再編碼、直接以 DTX 處理）、low tier 聽眾數、codec backlog 與丟幀、mixer underrun／漂移丟幀／tick 延遲、event loop delay 與記憶體。

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
| `quality` | `{participants: [{participantId, uplinkLossPercent?, downlinkLossPercent?, rttMs?}]}`：每 `qualityIntervalMs` 回報所有上行者的連線品質（上行掉包為該區間伺服器實際遺失比例，下行掉包取自對方 RTCP 接收報告），只送給主控與台上者 |
| `role:update`、`hand:raise`／`hand:withdraw`、`stage:invite`、`stage:joined`、`stage:left`、`control:transferred`、`mic:muted`／`mic:unmuted` | 事件廣播 |
| `rtc:answer`、`rtc:ice` | 伺服器端信令 |
| `status` | `waiting`／`live` |

限制：frame ≤ 64KB；控制訊息 ≤ 20/s、`rtc:ice` ≤ 30/s；超過即以 close code 1008 斷線。房間不存在或代碼錯誤一律回 `unauthorized`。名稱以 HTML 轉義形式傳送。client 以 close code 1000 關閉＝主動離開（立即移出房間）；其他關閉碼或斷線＝保留席位至寬限期結束（主控一律保留 `controllerGraceMs`）。

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

完整 API 見 [`packages/client/README.md`](packages/client/README.md)；`web/embed.html` 是最小嵌入範例。

## 測試與驗證

```bash
npm run typecheck                # 伺服器＋client＋web
npm test                         # 控制面流程 1–4、不變量、ws 邊界（驗證、限流、尺寸、轉義、靜態檔）、混音器
node scripts/werift-loopback.ts  # 真 werift 端到端（含觀眾→發言者重協商）
node scripts/bench-mixer.ts      # 混音壓測：3／8 發言者 × 300 訂閱者
node scripts/load-test.ts        # 全端壓測：3 發言者＋298 werift 觀眾（--speakers/--audience/--seconds/--procs/--url）
npm audit
```

## 授權

[Apache License 2.0](LICENSE)
