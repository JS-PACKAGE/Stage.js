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

`createRoom({name, roomName?, codeRequired?, token?})` 回傳 `{roomId, code?}`；伺服器設定 `rooms.createToken` 時須傳入 `token`。加入後用 `raiseHand` / `withdrawHand`，在台用 `mute` / `unmute` / `leaveStage`；主控用 `approve(id)`、`reject(id)`、`returnToStage()`、`transferControl(id)`、`forceMute(id)`、`forceUnmute(id)`、`setGain(id, gainDb)`（調整此人在混音中的音量，±`MAX_GAIN_DB` dB，0 還原；目前值見 `ParticipantView.gainDb`）、`removeFromStage(id)`、`kick(id)`（踢出房間）、`rotateCode()`（更換房間代碼，新代碼見主控的 `state.code`）、`closeRoom()`。`disconnect()` 停止自動重連。請求在伺服器 `ok` 後完成，失敗拋出有 `code` 的 `StageError`；逾時為 15 秒（另加本機排程等待）。舉手最少間隔 10 秒，`handCooldownMs` 可供倒數 UI 使用。

`state`、`me`、`status`、`speaking`（目前說話中的 participantId 集合）為即時 getters。`on(type, listener)` 回傳取消訂閱函式；事件也可透過 EventTarget 的 `addEventListener` 使用。事件：`state`、`status`、`created`、`closed`（`{roomId, reason?}`；`reason: 'shutdown'` 表示伺服器停止或重啟，而非主控關房）、`kicked`（被主控踢出；已斷線且不會自動重連）、`hand`、`invite`、`stagejoined`、`stageleft`、`transferred`、`mic`、`role`、`speaking`（說話中集合變動）、`quality`（主控與台上者每隔數秒收到所有上行者的 `{participantId, uplinkLossPercent?, downlinkLossPercent?, rttMs?}`）、`error`、`micerror`、`micready`、`audioblocked`。狀態為 waiting/live/reconnecting/disconnected。名稱先用 `decodeName()` 還原伺服器的五種 HTML entities，再以 `textContent` 顯示，勿使用 innerHTML。

每人一個 PeerConnection，觀眾 recvonly；上台才索取麥克風（mono、48 kHz）、轉 sendrecv。權限失敗仍可收聽；請下台、修正權限後再上台。`getStats()` 回傳 inbound/outbound 的 codec、clockRate、channels、bitrateKbps、packetsLost、jitter、rtt、lossPercent；位元率與 inbound 的 lossPercent 從兩次呼叫間的差量計算（首次沒有），outbound 的 lossPercent 為伺服器最近一次回報的掉包比例；jitter/rtt 單位秒，瀏覽器未提供的欄位保持 undefined。觀眾可定期呼叫它顯示自己的連線狀態。

## 音訊裝置與麥克風測試

- `listAudioDevices(): Promise<AudioDevices>`：回傳 `{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }`，授權前裝置名稱可能為空。取得權限後會觸發 `micready`（detail 為 undefined），可重新整理清單；裝置插拔可監聽 `navigator.mediaDevices` 的 `devicechange`。
- `setInputDevice(deviceId: string): Promise<void>`：選擇麥克風，空字串恢復設定的預設裝置。上台時透過 `replaceTrack` 即時切換、不重新協商，保留靜音狀態，停止舊裝置；選擇會保留至重連。選定 ID 優先於 `micConstraints.deviceId`。
- `outputDeviceSupported: boolean`：瀏覽器是否支援輸出選擇。`setOutputDevice(deviceId: string): Promise<void>` 使用 `setSinkId`，不支援時拒絕並拋出 `StageError('media_error', ...)`；空字串使用系統預設。音訊元件於重連重用，因此保留所選輸出。
- `micLevel: number`：目前上台麥克風的 RMS 振幅（0–1，非分貝），未上台或靜音時為 0；可定期讀取以更新音量表。
- `startMicTest(): Promise<MicTest>`：不需連線或上台，使用所選麥克風，回傳 `{ level(): number, stop(): void }`；`level()` 同樣為 0–1 RMS，不會播放測試音訊。`stop()` 可重複呼叫，停止軌道並關閉 AudioContext；`disconnect()` 也會停止所有測試（包含仍等待授權的測試）。測試期間切換裝置後，請停止並重啟測試。

## 嵌入與瀏覽器政策

- 正式環境須 HTTPS/WSS；CSP `script-src` 允許函式庫來源，`connect-src wss://host`（視 WebRTC 部署增加允許來源），`media-src blob: mediastream:`。若自行傳入音訊元件，仍須允許串流播放。
- iframe 須上層 Permissions-Policy 允許 `microphone` 給嵌入來源，且 iframe 設 `allow="microphone; autoplay"`。跨站頁也須符合自身的 CSP。
- `audioblocked` 時顯示按鈕，在使用者點擊事件立即呼叫 `unlockAudio()`；不要在等待網路請求後才解鎖。
- 房間代碼及 resume token 僅保存在執行期記憶體，不要記錄到日誌。邀請 URL 含代碼，請當作敏感資訊分享，建議頁面設定 `Referrer-Policy: no-referrer`。
- 可傳入 `audioElement`、`micConstraints`、`reconnect: {initialDelayMs,maxDelayMs}`。預設隱藏 audio 與 500–15000ms 指數重連；主控自動帶上 resume token 恢復席位。
