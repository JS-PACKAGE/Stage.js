# Stage.js 瀏覽器 client

建置：`npm run build -w packages/client`。無框架與執行期依賴。

```html
<button id="audio">點擊啟用音訊</button>
<script type="module">
  import { StageClient } from 'https://host/lib/stage-client.js';
  const client = new StageClient({ url: 'wss://host/ws' });
  client.on('state', ({ detail }) => { /* 以 textContent 呈現狀態 */ });
  client.on('micerror', ({ detail }) => alert(detail.message));
  client.on('error', ({ detail }) => alert(detail.message));
  document.querySelector('#audio').onclick = () => client.unlockAudio();
  await client.connect();
  await client.join({ roomId: '房間 ID', code: '房間代碼', name: '訪客' });
</script>
```

`createRoom({name, roomName?, codeRequired?, token?})` 回傳 `{roomId, code?}`；伺服器設定 `rooms.createToken` 時須傳入 `token`。加入後用 `raiseHand` / `withdrawHand`，在台用 `mute` / `unmute` / `leaveStage`；主控用 `approve(id)`、`reject(id)`、`returnToStage()`、`transferControl(id)`、`forceMute(id)`、`forceUnmute(id)`、`setGain(id, gainDb)`（調整此人在混音中的音量，±`MAX_GAIN_DB` dB，0 還原；目前值見 `ParticipantView.gainDb`）、`removeFromStage(id)`、`kick(id)`（踢出房間）、`rotateCode()`（更換房間代碼，新代碼見主控的 `state.code`）、`closeRoom()`。`disconnect()` 停止自動重連。請求在伺服器 `ok` 後完成，失敗拋出有 `code` 的 `StageError`；逾時為 15 秒（另加本機排程等待）。舉手間隔依伺服器設定（`rateLimits.handRaiseIntervalMs`，預設 10 秒），`handCooldownMs` 可供倒數 UI 使用。

取消仍在連線中的 `createRoom()`／`join()` 時，`disconnect()` 會使舊操作以 `disconnected` 失敗，不會稍後偷偷進房；同一個 client 可重新連線。斷線會同時清除待回覆逾時與尚未到送出時刻的排程，立即釋放排隊 payload；成功、錯誤、逾時也走相同清理路徑。同步送出失敗會拒絕該請求，不會從 timer callback 拋出未捕捉例外。`closed`／`kicked` 事件發出前已清除待回覆請求、麥克風與測試、PeerConnection、自建 audio 及 `pagehide` 監聽，不自動重連。

`state`、`me`、`status`、`speaking`（目前說話中的 participantId 集合）為即時 getters。`on(type, listener)` 回傳取消訂閱函式；事件也可透過 EventTarget 的 `addEventListener` 使用。事件：`state`、`status`、`created`、`closed`（`{roomId, reason?}`；`reason: 'shutdown'` 表示伺服器停止或重啟，而非主控關房）、`kicked`（被主控踢出；已斷線且不會自動重連）、`hand`、`invite`、`stagejoined`、`stageleft`、`transferred`、`mic`、`role`、`speaking`（說話中集合變動）、`quality`（主控與台上者每隔數秒收到所有上行者的 `{participantId, uplinkLossPercent?, downlinkLossPercent?, rttMs?}`）、`error`、`micerror`、`micready`、`audioblocked`。狀態為 waiting/live/reconnecting/disconnected。名稱先用 `decodeName()` 還原伺服器的五種 HTML entities，再以 `textContent` 顯示，勿使用 innerHTML。

每人一個 PeerConnection，觀眾 recvonly；上台才索取麥克風（mono、48 kHz）、轉 sendrecv。權限失敗仍可收聽；請下台、修正權限後再上台。`getStats()` 回傳 inbound/outbound 的 codec、clockRate、channels、bitrateKbps、packetsLost、jitter、rtt、lossPercent，inbound 另有 `bufferMs`（收到的音訊在瀏覽器 jitter buffer 等待播放的平均毫秒數，網路抖動越大越高）；位元率、inbound 的 lossPercent 與 bufferMs 從兩次呼叫間的差量計算（首次沒有），outbound 的 lossPercent 為伺服器最近一次回報的掉包比例；jitter/rtt 單位秒，瀏覽器未提供的欄位保持 undefined。觀眾可定期呼叫它顯示自己的連線狀態。 缺少、非有限值或重置的計數器不產生差量；重置樣本立即作為新基準，缺值後則由下一筆有效樣本建立基準；重複／倒退時間戳不覆寫基準。建議等待前一次 `getStats()` 完成再輪詢：已被較新結果取代的重疊呼叫，或舊 PeerConnection 的延遲結果，回傳 `{inbound: null, outbound: null}`；目前連線的 `getStats()` 錯誤仍會拒絕 promise。歷史只保留目前報告中的音訊 RTP ID，斷線清除。

## 本機收聽音量

- `playbackVolume: number`／`setPlaybackVolume(volume: number): void`：本機收聽音量 0–1（線性比例）；接受端點 0 與 1，超出範圍、NaN 或 Infinity 同步拋 `RangeError`，保留原音量。
- `playbackMuted: boolean`／`setPlaybackMuted(muted: boolean): void`：僅將自己的揚聲器靜音，保留原音量；靜音時調整音量不會自動解除靜音。
- 兩者不傳控制訊息、不改麥克風、其他人音量或主控的 `setGain`。可於連線前使用，斷線回座、`disconnect()` 後重用同一 client 都會保留。
- 自訂 `audioElement` 的既有 `volume`／`muted` 原樣保留；getters 即時讀取該元件，因此外部變更也會反映。音量支援依瀏覽器而異（部分行動瀏覽器僅能使用系統音量）。不會繞過自動播放政策，仍須處理 `audioblocked`／`unlockAudio()`。
- 完整範例的「音訊設定」提供收聽音量滑桿與獨立的靜音收聽按鈕。

## 音訊裝置與麥克風測試

- `listAudioDevices(): Promise<AudioDevices>`：回傳 `{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }`，授權前裝置名稱可能為空。取得權限後會觸發 `micready`（detail 為 undefined），可重新整理清單；裝置插拔可監聽 `navigator.mediaDevices` 的 `devicechange`。
- `setInputDevice(deviceId: string): Promise<void>`：選擇麥克風，空字串恢復設定的預設裝置。上台時透過 `replaceTrack` 即時切換、不重新協商，保留靜音狀態，停止舊裝置；選擇會保留至重連。選定 ID 優先於 `micConstraints.deviceId`。
- `outputDeviceSupported: boolean`：瀏覽器是否支援輸出選擇。`setOutputDevice(deviceId: string): Promise<void>` 使用 `setSinkId`，不支援時拒絕並拋出 `StageError('media_error', ...)`；空字串使用系統預設。音訊元件於重連重用，因此保留所選輸出。
- `micLevel: number`：目前上台麥克風的 RMS 振幅（0–1，非分貝），未上台或靜音時為 0；可定期讀取以更新音量表。
- `startMicTest(): Promise<MicTest>`：不需連線或上台，使用所選麥克風，回傳 `{ level(): number, stop(): void }`；`level()` 同樣為 0–1 RMS，不會播放測試音訊。`stop()` 可重複呼叫，停止軌道並關閉 AudioContext；`disconnect()`、關房與被踢也會停止所有測試（包含仍等待授權的測試）。測試期間切換裝置後，請停止並重啟測試。

## Web Component：`<stage-client>`

不寫 JavaScript 也能嵌入：載入 `stage-element.js`（會自動註冊元素，並重新匯出 `stage-client.js` 的全部 API）即可。

```html
<script type="module" src="https://host/lib/stage-element.js"></script>
<stage-client room="房間 ID" code="房間代碼" name="訪客"></stage-client>
```

- 屬性：`room`、`name`（兩者都有才進房）、`code`、`url`（ws 位址，預設為載入此模組的伺服器 `/ws`）。進入文件即進房、移除即離開（close 1000，立即讓出席位）；屬性變更會重新進房。快速移除／重新掛載或更換屬性時，只讓最新一次掛載繼續進房，舊連線的事件不再更新畫面。
- 內建介面：狀態列（房名．直播狀態．收聽中／已舉手／台上）、錯誤列、`啟用音訊`（自動播放被擋時出現，失敗可重試、成功後隱藏）、觀眾的舉手／收回（含冷卻倒數）、台上的靜音／離開舞台。離開、關房與被踢後隱藏失效操作。主控功能請改用 `element.client`（底層 `StageClient`，未進房時為 null）。
- 事件：所有 client 事件以 `stage-<type>` 從元素派發（`bubbles`、`composed`，`detail` 相同），例如 `stage-state`、`stage-hand`、`stage-kicked`。
- 樣式：`::part(panel)`、`::part(status)`、`::part(error)`、`::part(actions)`，以及 CSS 變數 `--stage-fg`、`--stage-bg`、`--stage-border`、`--stage-radius`、`--stage-button-bg`、`--stage-accent`、`--stage-accent-fg`、`--stage-error`。
- 自訂標籤名：`import { defineStageElement } from 'https://host/lib/stage-element.js'` 後呼叫 `defineStageElement('my-stage')`（`stage-client` 已於載入時註冊，兩個標籤可並存）。

## 嵌入與瀏覽器政策

- 正式環境須 HTTPS/WSS；CSP `script-src` 允許函式庫來源，`connect-src wss://host`（視 WebRTC 部署增加允許來源），`media-src blob: mediastream:`。若自行傳入音訊元件，仍須允許串流播放。
- iframe 須上層 Permissions-Policy 允許 `microphone` 給嵌入來源，且 iframe 設 `allow="microphone; autoplay"`。跨站頁也須符合自身的 CSP。
- `audioblocked` 時顯示按鈕，在使用者點擊事件立即呼叫 `unlockAudio()`；不要在等待網路請求後才解鎖。
- 房間代碼及 resume token 僅保存在執行期記憶體，不要記錄到日誌。邀請 URL 含代碼，請當作敏感資訊分享，建議頁面設定 `Referrer-Policy: no-referrer`。
- 可傳入 `audioElement`、`micConstraints`、`requestTimeoutMs`、`reconnect: {initialDelayMs,maxDelayMs}`。預設隱藏 audio 與 500–15000ms 指數重連；所有人自動帶上 resume token 恢復席位（伺服器 `rooms.participantGraceMs`／`controllerGraceMs` 內有效）。
- 斷線韌性：ws 中斷時**不拆** PeerConnection——伺服器在寬限期內保留席位與媒體，音訊持續，重連回座後沿用同一條連線；協商中的 answer 遺失時立即解除等待，回座後直接替換尚未完成的 offer，保留其 MID，不以 rollback 產生額外 transceiver。只有身分改變（寬限逾時、被踢、關房、主動 `disconnect()`）才重建。`disconnect()` 以 close code 1000 告知伺服器「主動離開」，立即讓出席位；`pagehide` 以 4002 關閉、保留席位供返回頁面時回座。client 每 15 秒送 `ping`，35 秒沒收到任何訊息即視為斷線並重連（半開 TCP 不會卡住）。WebRTC 進入 `disconnected` 3 秒即 ICE restart，`failed` 則兩端重建。節流與舉手冷卻依伺服器 `hello.limits`（`rateLimits` getter）；請求排程、舉手冷卻與 keepalive 使用單調經過時間，不受系統時鐘向前／向後校正影響。


## 發佈靜態檔案

根目錄 `npm run build` 會為瀏覽器 ESM 產生 Brotli／gzip 副本，由 Stage.js 靜態伺服器自動協商。直接執行 client workspace 的 build 仍可使用未壓縮原檔；需要副本時再執行 `node scripts/precompress.ts packages/client/dist`。部署請一併保留原檔與副本，第三方嵌入 URL 仍為 `/lib/stage-client.js`，無需改成 `.br` 或 `.gz`。

## 請求期限

`new StageClient({ url, requestTimeoutMs: 30000 })` 可調整等待伺服器 hello、請求 ACK 及 SDP answer 的期限。省略時維持 15000 ms；接受 1–300000 的整數毫秒，其他值在建構時拋 `RangeError`，尚未修改／建立 audio。

請求 ACK 期限保留原本的 pacing 等待額度；SDP answer 期限從 offer 實際送出時起算，不會因尚在排程佇列而提早逾時。已替換 peer 的未送出 offer 不再送出，其期限也不影響新 peer。成功、失敗、斷線會清理相關計時器。

這是 client 等待期限，不會取消已送達伺服器的操作，也不會延長伺服器 `rtc.mediaWorkerTimeoutMs`。keepalive 的靜默判定、ICE restart 與重連退避不受此選項影響；較短期限可能使慢速但仍正常的操作被判為逾時。

## 取消麥克風預覽

`startMicTest({ signal?: AbortSignal })` 可將預覽綁定至 `AbortController`，原本的 `startMicTest()` 不變。

- 已取消的 signal 不呼叫 getUserMedia、不提出麥克風權限要求。
- 等待權限時取消，promise 立即以 signal.reason 拒絕（預設為 AbortError）；瀏覽器原生權限提示無法由此 API 自動關閉，但之後取得的串流會立即停止，不建立 meter 或發出 micready。
- 預覽已啟動後取消，只停止該預覽的音軌／AudioContext，不影響房間正在使用的麥克風，也不影響使用其他 signal 的預覽。
- `MicTest.stop()` 可重複呼叫；手動停止或取消都移除 abort listener。正常權限失敗仍保留原錯誤，disconnect 的既有清理行為不變。

例如建立 `const controller = new AbortController()`，呼叫 `client.startMicTest({ signal: controller.signal })`，在取消按鈕或視圖卸載時呼叫 `controller.abort()`，並在呼叫端處理取消拒絕。這不會取消已經送到伺服器的房間操作。

舉手／收回的 `hand` 事件保持伺服器順序。`raiseHand()`／`withdrawHand()` 成功時，發起者已收到更新後的自身狀態；其他人的完整 `state` 可在下一輪事件迴圈合併送達，請以 `state` 事件讀取最新完整排隊名單，不假設每個 `hand` 事件各有一份緊接的完整快照。
