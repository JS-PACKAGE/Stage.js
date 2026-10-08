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

`createRoom({name, roomName?, codeRequired?})` 回傳 `{roomId, code?}`。加入後用 `raiseHand` / `withdrawHand`，在台用 `mute` / `unmute` / `leaveStage`；主控用 `approve(id)`、`reject(id)`、`returnToStage()`、`transferControl(id)`、`forceMute(id)`、`forceUnmute(id)`、`removeFromStage(id)`、`closeRoom()`。`disconnect()` 停止自動重連。請求在伺服器 `ok` 後完成，失敗拋出有 `code` 的 `StageError`；逾時為 15 秒（另加本機排程等待）。舉手最少間隔 10 秒，`handCooldownMs` 可供倒數 UI 使用。

`state`、`me`、`status` 為即時 getters。`on(type, listener)` 回傳取消訂閱函式；事件也可透過 EventTarget 的 `addEventListener` 使用。事件：`state`、`status`、`created`、`closed`、`hand`、`invite`、`stagejoined`、`stageleft`、`transferred`、`mic`、`role`、`error`、`micerror`、`audioblocked`。狀態為 waiting/live/reconnecting/disconnected。名稱先用 `decodeName()` 還原伺服器的五種 HTML entities，再以 `textContent` 顯示，勿使用 innerHTML。

每人一個 PeerConnection，觀眾 recvonly；上台才索取麥克風（mono、48 kHz）、轉 sendrecv。權限失敗仍可收聽；請下台、修正權限後再上台。`getStats()` 回傳 inbound/outbound 的 codec、clockRate、channels、bitrateKbps、packetsLost、jitter、rtt；位元率從兩次呼叫間的差量計算，首次無 bitrateKbps，jitter/rtt 單位秒，瀏覽器未提供的欄位保持 undefined。

## 嵌入與瀏覽器政策

- 正式環境須 HTTPS/WSS；CSP `script-src` 允許函式庫來源，`connect-src wss://host`（視 WebRTC 部署增加允許來源），`media-src blob: mediastream:`。若自行傳入音訊元件，仍須允許串流播放。
- iframe 須上層 Permissions-Policy 允許 `microphone` 給嵌入來源，且 iframe 設 `allow="microphone; autoplay"`。跨站頁也須符合自身的 CSP。
- `audioblocked` 時顯示按鈕，在使用者點擊事件立即呼叫 `unlockAudio()`；不要在等待網路請求後才解鎖。
- 房間代碼及 resume token 僅保存在執行期記憶體，不要記錄到日誌。邀請 URL 含代碼，請當作敏感資訊分享，建議頁面設定 `Referrer-Policy: no-referrer`。
- 可傳入 `audioElement`、`micConstraints`、`reconnect: {initialDelayMs,maxDelayMs}`。預設隱藏 audio 與 500–15000ms 指數重連；主控自動帶上 resume token 恢復席位。
