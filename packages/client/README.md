# Stage.js 瀏覽器 client

建置：`npm run build -w packages/client`。無框架與執行期依賴。

導覽：[快速開始](#快速開始) · [房間操作](#房間操作) · [請求期限](#請求期限) · [事件與狀態](#事件與狀態) · [連線生命週期](#連線生命週期) · [本機收聽音量](#本機收聽音量) · [麥克風](#音訊裝置與麥克風測試) · [取消預覽](#取消麥克風預覽) · [音訊統計](#音訊統計) · [Web Component](#web-componentstage-client) · [測試](#信令整合測試)

## 快速開始

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

## 房間操作

`createRoom({name, roomName?, codeRequired?, token?})` 回傳 `{roomId, code?}`；伺服器設定 `rooms.createToken` 時須傳入 `token`。加入後用 `raiseHand` / `withdrawHand`，在台用 `mute` / `unmute` / `leaveStage`；主控用 `approve(id)`、`reject(id)`、`returnToStage()`、`transferControl(id)`、`forceMute(id)`、`forceUnmute(id)`、`setGain(id, gainDb)`（調整此人在混音中的音量，±`MAX_GAIN_DB` dB，0 還原；目前值見 `ParticipantView.gainDb`）、`removeFromStage(id)`、`kick(id)`（踢出房間）、`setRoomName(name)`（修改房間名稱）、`rotateCode()`（更換房間代碼，新代碼見主控的 `state.code`）、`closeRoom()`。`disconnect()` 停止自動重連。請求在伺服器 `ok` 後完成，失敗拋出有 `code` 的 `StageError`；逾時預設為 15 秒（可用 `requestTimeoutMs` 調整；另加本機排程等待）。舉手間隔依伺服器設定（`rateLimits.handRaiseIntervalMs`，預設 10 秒），`handCooldownMs` 可供倒數 UI 使用。

`createRoom`／`join` 在通過即時本機容量檢查後、任何等待前複製該次參數。hello、pacing 或 ACK 等待期間修改原物件，不會改變這次送出的欄位或成功後保存的回座 roomId／code／name；下一次明確呼叫會讀取新的值。支援的參數皆為字串／布林等基本值，採淺層複製，不凍結或修改呼叫端物件，也不更改驗證、修剪或錯誤順序。主控已收到的權威房間代碼仍依下述規則更新。

需代碼房間的主控收到同房非空 `state.code` 後，SDK 會更新自動重連使用的代碼；初次 ACK 到達時，最新 snapshot 若仍含該權威值，也會用它建立重連資料。重連資料建立後，未附代碼的 snapshot（例如移交後）不會清除最後已知值。伺服器仍先驗證最新房間代碼再處理 resume token：換碼不切斷既有連線，但未取得新代碼的其他成員無法以舊代碼重連；本行為不向一般成員公開新代碼。

重疊呼叫 createRoom（包含在 created／state 事件內再次呼叫）不會清空先前呼叫已收到、仍在等待 ACK 的房間結果。伺服器仍決定是否允許操作；同一連線已進房時，後續開房仍回 already_joined，第一個成功呼叫保留自己的結果與自動回座 session。沒有新的 room:created 卻只有 ACK 時仍視為 internal 錯誤，不以先前房間的資訊冒充成功。

舉手冷卻屬於目前參與者：明確 disconnect（包含被踢／關房）或收到不同 participantId 的新身分時清除，同一個 StageClient 可立即在新房間舉手；同席位的自動恢復與一般 state 更新保留原本冷卻。伺服器的速率限制仍會獨立檢查請求。 `raiseHand()` 仍先依序檢查既有冷卻與 `queue_full`；接著若沒有 socket 或 socket 非 OPEN，則以 `disconnected` 拒絕且不新占用冷卻。通過本機准入後，即使後續送出失敗、逾時或伺服器拒絕，冷卻仍保留；這不是一般錯誤 rollback，也不代表 OPEN socket 已完成回座或伺服器必然可用。

## 修改房間名稱

`setRoomName(name: string): Promise<void>` 由目前主控更新房間名稱（台上／台下皆可）；伺服器在房間佇列執行時驗證主控權限，同名操作也不能繞過權限。名稱沿用 `roomName` 的伺服器清洗與設定長度；改變後各成員收到既有個人化 `state`，請求者先收到 state 再 ACK，相同名稱只刷新請求者並保留待送的合併廣播。SDK 沿用控制請求容量、排程與逾時，不快取或樂觀改寫房間標題；顯示應讀取 `decodeName(client.state.name)` 並使用 textContent。既有房間 ID、代碼、席位、排序與媒體保持原流程；舊伺服器可能回 `unknown_type`，不自動關房／重建。完整範例提供主控專用「修改房間名稱」按鈕；embed 與 widget 提供主控專用房名欄和更新按鈕，獨立呈現伺服器接受的名稱並保留同席草稿。這些介面都依正常 state 顯示新標題，重連／待回覆期間停用送出，失去主控或離房時清理編輯狀態。

## 修改自己的顯示名稱

`setName(name: string): Promise<void>` 只更新目前席位自己，沿用控制請求 pacing、容量上限、逾時與 generic 錯誤。不更換 participantId、角色、台位或舉手順位，也不重新進房；不提供修改他人的參數。伺服器沿用進房的名稱規則（NFC、移除不安全控制字元、trim、Unicode 字元數上限及 HTML 轉義），以個人化 `state` 更新可見名稱後才 ACK；相同名稱只回傳請求者的 state。一般未上台、未舉手觀眾改名，在沒有 pending 合併廣播或房間狀態轉換時，只刷新本人與目前主控，其他人不收到資料相同的 state，因此也不觸發該次既有 state callback／媒體同步流程；其他改名仍沿用全房個人化更新。沒有全房改名事件，因此不額外公開原本隱藏的觀眾名稱；名稱可重複，不能當作認證身分。

SDK 不樂觀改寫 `me.name`，也不在較晚的 ACK continuation 寫回提案。收到同房間的有效個人狀態時，會在公開 status／state callback 前複製並解碼自己已被接受的名稱供自動回座使用；初次 create／join 的 ACK 晚到時也保留該次新收到的名稱。呼叫者改寫公開 snapshot 不會修改這份名稱紀錄。若操作已被接受但 ACK 遺失，已收到的 state 仍有效；若連新 state 都未收到，只有原席位仍可 resume 時才會從伺服器恢復新名稱，不保證席位過期後恢復未見過的改名。

舊伺服器可能以 `unknown_type` 拒絕此新增指令；呼叫端應顯示錯誤，不會自動離房／重入。Web Component 的 `name` attribute 仍維持原本重入語意；可使用內建本人名稱編輯，或明確呼叫 `element.client.setName()`，並以 state 顯示結果。完整範例提供「修改我的名稱」對話框；文字以 decodeName 後的 textContent 顯示，不寫入 URL、儲存空間或新增名稱日誌。

## 請求期限

`new StageClient({ url, requestTimeoutMs: 30000 })` 可調整等待伺服器 hello、請求 ACK 及 SDP answer 的期限。省略時維持 15000 ms；接受 1–300000 的整數毫秒，其他值在建構時拋 `RangeError`，尚未修改／建立 audio。

請求 ACK 期限保留原本的 pacing 等待額度；SDP answer 期限從 offer 實際送出時起算，不會因尚在排程佇列而提早逾時。已替換 peer 的未送出 offer 不再送出，其期限也不影響新 peer。成功、失敗、斷線會清理相關計時器。 已開始套用的 answer 與其排隊 ICE 只可完成原本那輪協商；期限過後的遲到 continuation 不會完成或拒絕新一輪 waiter。同一 peer 保留原本候選套用順序，不把已收到的 ICE 留給下一輪 answer；peer 已替換或離房時才停止剩餘批次。這不取消已送入瀏覽器的 SDP／ICE 操作，亦不新增 wire answer 的請求 ID 關聯。

這是 client 等待期限，不會取消已送達伺服器的操作，也不會延長伺服器 `rtc.mediaWorkerTimeoutMs`。keepalive 的靜默判定、ICE restart 與重連退避不受此選項影響；較短期限可能使慢速但仍正常的操作被判為逾時。

### 可選的控制請求上限

`new StageClient({ url, maxPendingControlRequests: 128 })` 可限制呼叫端同時等待送出或 ACK 的控制請求數；省略時維持不設上限。值須為正安全整數，無效值在建構時拋 `RangeError`，尚未修改／建立 audio。

上限包含公開 `join`／`createRoom`、舉手／收回、上下台、麥克風靜音、增益、移交、踢人、改自己的名稱、換碼與關房操作。已送出但未 ACK 的請求仍占名額；收到 ACK／錯誤、逾時、送出失敗或斷線即釋放。超限的新呼叫立即以本機 `StageError` 的 `code: 'queue_full'` 拒絕，不送到伺服器、不額外派發 error event、不保留 pacing 時段／timer；舉手不開始冷卻，開房不清除先前待完成的結果。請等待既有 promise 完成後重試，避免持續產生已過時的操作。

hello、內部 SDP／ICE 信令及自動回座不占用此上限，仍遵守原本的 pacing 與 offer／ICE 順序，因此 `maxPendingControlRequests: 1` 不會因未 ACK 的 join 阻擋初始媒體協商。`disconnect()`、本機音訊／裝置設定也不占名額。這只限制 SDK 已接納的呼叫端控制請求數，不是總記憶體／payload 位元組／瀏覽器待送緩衝上限，也不限制 hello 前等待共用 connect 的呼叫者數；不改變伺服器限流或包含 pacing 的等待期限，不取消已送達的操作。自動回座與信令仍可能等待已接納請求的 pacing 時段，並非優先插隊。

## 事件與狀態

`state`、`me`、`status`、`speaking`（目前說話中的 participantId 集合）為即時 getters。`on(type, listener)` 回傳取消訂閱函式；事件也可透過 EventTarget 的 `addEventListener` 使用。事件：`state`、`status`、`created`、`closed`（`{roomId, reason?}`；`reason: 'shutdown'` 表示伺服器停止或重啟，而非主控關房）、`kicked`（被主控踢出；已斷線且不會自動重連）、`hand`、`invite`、`stagejoined`、`stageleft`、`transferred`、`mic`、`role`、`speaking`（說話中集合；伺服器於成功建立／加入／恢復連線的 state 之後、ACK 之前先同步目前集合，之後隨集合變動更新）、`quality`（主控與台上者每隔數秒收到所有上行者的 `{participantId, uplinkLossPercent?, downlinkLossPercent?, rttMs?}`）、`error`、`micerror`、`micready`、`audioblocked`。`quality` 是本輪完整集合；伺服器既有品質輪次完成時若已無發布者，會送空陣列供清除舊資料，之後停止排程。仍有發布者但統計全部失敗／缺失時不因此送空陣列。清空不增加 timer 或 timeout，未完成的統計請求仍可能延後事件；關房或停用品質回報不另發此事件。狀態為 waiting/live/reconnecting/disconnected。名稱先用 `decodeName()` 還原伺服器的五種 HTML entities，再以 `textContent` 顯示，勿使用 innerHTML。

舉手／收回的 `hand` 事件保持伺服器順序。`raiseHand()`／`withdrawHand()` 成功時，發起者已收到更新後的自身狀態；其他人的完整 `state` 可在下一輪事件迴圈合併送達，請以 `state` 事件讀取最新完整排隊名單，不假設每個 `hand` 事件各有一份緊接的完整快照。

`status`／`state` 的監聽器可同步呼叫 `disconnect()`（例如移除嵌入元件）；舊 room:state handler 會停止，不在斷線後繼續建立 PeerConnection／取得麥克風，也不在 status 監聽器取消後發出舊 state。若處理期間已有更新快照，舊 handler 不會取代較新的媒體連線。

## 連線生命週期

- `url` 在建構時擷取，初次連線、手動重新連線與自動回座都沿用該網址；之後修改或重用原始 options 物件不會改變既有 client 的目的地。切換伺服器請建立新的 client，避免既有房間代碼／resume token 隨 options 變更送往另一個端點。網址仍由 WebSocket 在連線時驗證，不新增建構時的網址正規化或驗證；`micConstraints` 的既有讀取方式不變。
- 可傳入 `audioElement`、`micConstraints`、`requestTimeoutMs`、`maxPendingControlRequests`、`reconnect: {initialDelayMs,maxDelayMs}`。預設隱藏 audio 與 500–15000ms 指數重連；所有人自動帶上 resume token 恢復席位（伺服器 `rooms.participantGraceMs`／`controllerGraceMs` 內有效）。

- `reconnect.initialDelayMs`／`maxDelayMs` 必須各為 0–2147483647 的有限毫秒數，允許小數與 0；無效值在建構時、建立或修改 audio 前同步拋 `RangeError`。預設仍為 500／15000；最大值小於初始值時照常以最大值封頂，0 表示立即排程重試而非停用重連。重連數值在建構時複製，後續修改原 options／reconnect 物件不會改變既有 client 的重試政策。

- 斷線韌性：ws 中斷時**不拆** PeerConnection——伺服器在寬限期內保留席位與媒體，音訊持續，重連回座後沿用同一條連線；協商中的 answer 遺失時立即解除等待，回座後直接替換尚未完成的 offer，保留其 MID，不以 rollback 產生額外 transceiver。只有身分改變（寬限逾時、被踢、關房、主動 `disconnect()`）才重建。`disconnect()` 會清理本機連線並嘗試以 close code 1000 告知伺服器「主動離開」。伺服器收到正常關閉後，非主控不保留 participant grace，會移除席位；主控仍遵循 `rooms.controllerGraceMs` 的斷線寬限，之後依原規則交接或關房，並非立即讓出主控或關閉房間。`disconnect()` 完成不代表伺服器已收到關閉；`pagehide` 以 4002 關閉，依各角色的寬限設定保留席位供返回頁面時回座。client 每 15 秒送 `ping`，35 秒沒收到任何訊息即視為斷線並重連（半開 TCP 不會卡住）。WebRTC 進入 `disconnected` 3 秒即 ICE restart，`failed` 則兩端重建。節流與舉手冷卻依伺服器 `hello.limits`（`rateLimits` getter）；請求排程、舉手冷卻與 keepalive 使用單調經過時間，不受系統時鐘向前／向後校正影響。

取消仍在連線中的 `connect()`／`createRoom()`／`join()` 時，`disconnect()` 會立即拒絕尚未完成的 hello 等待並清除其期限，舊操作以 `disconnected` 失敗，不等待底層 close handshake，也不會稍後偷偷進房；同一個 client 可重新連線。這只結束本機等待，不保證底層 socket 立即關閉。斷線會同時清除待回覆逾時與尚未到送出時刻的排程，立即釋放排隊 payload；成功、錯誤、逾時也走相同清理路徑。同步送出失敗會拒絕該請求，不會從 timer callback 拋出未捕捉例外。`closed`／`kicked` 事件發出前已清除待回覆請求、麥克風與測試、PeerConnection、自建 audio 及 `pagehide` 監聽，不自動重連。

自動重連的排程與錯誤處理綁定原本 session：若 `status: reconnecting` 或 `error` 監聽器同步斷線並切換房間，舊 timer／遲到的 hello 失敗／resume 拒絕不會再次加入或關閉新房間，也不向新 session 回報過期錯誤。直接 join／createRoom 成功安裝新 session 時也會取消舊重連 timer，新 session 之後斷線仍可正常重連。仍屬於目前 session 的暫時失敗照常退避重試；unauthorized／not_found／room_full 仍停止該 session。 hello 逾時或自動回座暫時失敗時，SDK 會先放棄該次 socket 的控制權再嘗試關閉，不等待可能延遲的 WebSocket close handshake 才開始退避；舊 socket 的晚到訊息／close 不會影響替代連線。這不取消已送達伺服器的操作，也不保證底層 socket 立即釋放；席位恢復仍受伺服器寬限時間限制。

WebSocket 建構失敗、hello 逾時或尚未進房的連線關閉，也會釋放 window 的 pagehide 監聽，不需要另呼叫 disconnect 才解除這個引用。新連線會重新安裝監聽；舊嘗試的遲到失敗不會移除新連線的監聽。尚未進房時，失敗／關閉連線也會移除 SDK 自建的 audio DOM 節點；再次 connect 會掛回同一元素並保留音量／靜音設定。同席自動恢復期間仍保留元素，呼叫端提供的 audioElement 不會被移除。 主動 disconnect 也會在派發 disconnected 狀態前完成舊 socket ownership、音訊節點與 pagehide 清理，因此可在該狀態 callback 立即 connect／join；舊 close 事件或同步 close 失敗不會移除新連線的資源。本機清理不等待底層 close handshake。

## 本機收聽音量

- `playbackVolume: number`／`setPlaybackVolume(volume: number): void`：本機收聽音量 0–1（線性比例）；接受端點 0 與 1，超出範圍、NaN 或 Infinity 同步拋 `RangeError`，保留原音量。
- `playbackMuted: boolean`／`setPlaybackMuted(muted: boolean): void`：僅將自己的揚聲器靜音，保留原音量；靜音時調整音量不會自動解除靜音。
- 兩者不傳控制訊息、不改麥克風、其他人音量或主控的 `setGain`。可於連線前使用，斷線回座、`disconnect()` 後重用同一 client 都會保留。
- 自訂 `audioElement` 的既有 `volume`／`muted` 原樣保留；getters 即時讀取該元件，因此外部變更也會反映。音量支援依瀏覽器而異（部分行動瀏覽器僅能使用系統音量）。不會繞過自動播放政策，仍須處理 `audioblocked`／`unlockAudio()`。
- 完整範例的「音訊設定」提供收聽音量滑桿與獨立的靜音收聽按鈕。

## 音訊裝置與麥克風測試

每人一個 PeerConnection，觀眾 recvonly；上台才索取麥克風（mono、48 kHz）、轉 sendrecv。權限失敗仍可收聽；修正權限／裝置後可明確呼叫 `retryMicrophone()`，或下台後重新上台。

`micready` 的 detail 為 undefined，是三條流程共用的擷取就緒通知：房間初次／重試擷取在 sender 安裝之前發出；已使用麥克風的 `setInputDevice()` 在成功 replaceTrack 並接管新串流後發出；`startMicTest()` 則是獨立預覽，不需要房間 sender。事件不附操作 ID，不能單憑它判定是哪個公開呼叫完成，也不保證後續協商或可聽音訊；需要辨識預覽／裝置操作時應沿用各自 promise 與生命週期。

- `listAudioDevices(): Promise<AudioDevices>`：回傳 `{ inputs: MediaDeviceInfo[], outputs: MediaDeviceInfo[] }`，授權前裝置名稱可能為空。取得權限後會觸發 `micready`（detail 為 undefined），可重新整理清單；裝置插拔可監聽 `navigator.mediaDevices` 的 `devicechange`。
- `setInputDevice(deviceId: string): Promise<void>`：選擇麥克風，空字串恢復設定的預設裝置。上台時透過 `replaceTrack` 即時切換、不重新協商，保留靜音狀態，停止舊裝置；替換 promise 尚未完成時，仍由最新房間狀態同步已安裝與候選音軌的靜音（含主控強制靜音／解除），獨立預覽不受影響；選擇會保留至重連。選定 ID 優先於 `micConstraints.deviceId`。
- `retryMicrophone(): boolean`：手動要求重試已失敗或自然中斷的房間麥克風擷取，保留台位與目前 PeerConnection。只有目前 live、信令 socket OPEN、仍在台上、沒有已安裝麥克風且擷取失敗或音軌已自然結束並清理時才回傳 `true`；健康／尚在等待擷取、已下台、重連中或斷線時回傳 `false`，不送控制請求也不丟出操作錯誤。`true` 只表示已排入既有媒體佇列，不保證已開始提示、完成擷取、安裝、協商或傳送；同一待處理重試的重複呼叫回傳 `false`。使用目前選定裝置並保留自我／強制靜音，不自動解除靜音。不新增自動提示或輪詢；當前失敗仍依既有 `micerror`／`error` 回報，需再一次明確呼叫才重試，原本的重新上台／peer 替換恢復路徑不變。下台、明確 disconnect 或替換 PeerConnection 會沿用 revision 取消／忽略舊工作；只中斷 WebSocket 而保留 peer 的自動回座，不會因此取消已接納的擷取，無法取消已送入瀏覽器的 `replaceTrack()`。房間初次／重試擷取的 `micready` 早於 sender 安裝；事件也用於獨立預覽及裝置替換，不能把任意 `micready` 當作此重試成功或可聽見傳送的證明。
- `outputDeviceSupported: boolean`：瀏覽器是否支援輸出選擇。`setOutputDevice(deviceId: string): Promise<void>` 使用 `setSinkId`，不支援時拒絕並拋出 `StageError('media_error', ...)`；空字串使用系統預設。音訊元件於重連重用，因此保留所選輸出。
- `micLevel: number`：目前上台麥克風的 RMS 振幅（0–1，非分貝），未上台、靜音或停用房間音量計時為 0；即使在同步 state／micready callback 中、實際音軌尚未套用最新靜音，也依目前房間狀態回 0。音軌仍停用時亦不讀取音量計；此 getter 不代表 sender 已安裝或其他人能聽見。可定期讀取以更新音量表。
- `startMicTest(): Promise<MicTest>`：不需連線或上台，使用所選麥克風，回傳提供 `level()`、`stop()` 與唯讀 `stopped` 的 handle；`level()` 同樣為 0–1 RMS，不會播放測試音訊。`stop()` 可重複呼叫，停止軌道並關閉 AudioContext；`disconnect()`、關房與被踢也會停止所有測試（包含仍等待授權的測試）。測試期間切換裝置後，請停止並重啟測試。

獨立預覽的麥克風音軌自然 `ended` 時，也會停止該預覽、關閉音量計並移除其 listener／SDK 管理記錄；既有 handle 的 `level()` 回 0，`stop()` 仍可安全重複呼叫。其他預覽與房間麥克風不受影響，不發出房間 `micerror`、不觸發房間重試或自動重新擷取。若取得音軌時或建立音量計期間已 ended，promise 以 name 為 `NotReadableError` 的錯誤拒絕且不發出 `micready`；同時取消／disconnect 仍優先使用既有取消結果。若 `micready` 監聽器本身使音軌結束，呼叫可回傳已停止、讀值為 0 的 handle；這不新增預覽結束事件或操作 ID。SDK 回傳的 handle 一律提供唯讀 `stopped`：尚未停止為 false，明確 stop、abort、disconnect 或自然 ended 開始清理後為 true，之後不再變回 false；不表示非同步 AudioContext.close 已完成，也不能以 level 為 0 推斷停止。介面將此欄位標為 optional，讓舊有只實作 level／stop 的結構型別保持相容；整合可檢查 `stopped === true`，未提供時沿用既有行為。受控測試只確認關閉／解除連接、listener 清理與不再讀取 analyser；呼叫端保留 handle 時，不保證相關物件／sample buffer 已被垃圾回收，也未量測原生 CPU 或硬體效果。

已取得的房間麥克風若發生瀏覽器 `ended` 事件，SDK 會退休該串流與音量計、發出 `micerror`（name 為 `NotReadableError`，表示擷取已中斷，不推斷硬體或權限原因），保留房間席位與收聽，並讓符合條件的 `retryMicrophone()` 可由使用者明確重試。同一 peer 的一般快照／靜音變更不因此自動重新擷取；既有 peer 重建或重新上台的擷取政策不變。已在進行的使用者裝置替換仍可完成，不會被舊麥克風的 ended 一併取消。若新候選軌道在替換完成前已 ended，裝置操作會失敗且不發出假的 micready，既有媒體佇列會重新同步仍存活的舊麥克風，或在沒有舊麥克風時切成只收聽；無法取消瀏覽器尚未完成的 replaceTrack，恢復本身也仍可能失敗。SDK 自己的停止／下台／離房會先移除 listener，不當成自然中斷；獨立預覽不採用這套房間重試生命週期。`micready` 仍是共用的擷取事件而非 sender 安裝或真實發聲證明。

不顯示房間麥克風音量表的整合可使用 `new StageClient({ url, enableMicMeter: false })`。省略或設 `true` 時保留原本建立音量計與相關失敗回報；`false` 則不為房間擷取／裝置替換建立 AudioContext、source、analyser 或取樣陣列，`micLevel` 固定為 0，但麥克風擷取、sender 安裝、靜音與停止串流仍照常。選項只能是 boolean（其他值在建構時拋 TypeError，尚未修改 audio），建構時複製，後續修改原 options 不會切換設定。明確呼叫 `startMicTest()` 仍建立自己的音量計並依原方式回報失敗；此選項不會停用預覽，也不繞過麥克風授權或自動播放政策。最小 embed 沒有音量表，會明確選用 false；完整範例與 Web Component 保留預設。這是省去未使用的圖節點與 buffer，不代表已量測 CPU、耗電或音訊延遲改善。

離開房間或建立替代 PeerConnection 時，舊媒體工作佇列不會阻塞新連線：仍在等待的麥克風授權結果會被忽略並停止遲到的串流，舊代等待授權的 `setInputDevice()` 以 `StageError('disconnected')` 拒絕，已排隊的舊工作在取得執行機會時同樣拒絕。這無法關閉瀏覽器原生授權提示；同一個有效 PeerConnection 內的裝置切換仍依呼叫順序執行。 已退場 peer 的本機 ICE 請求或套用遠端候選的遲到失敗不再派發 `error`；同席位重連若沿用 peer，其真正的 ICE 失敗仍會通知。伺服器明確送來的 error 與公開請求的拒絕語意不變，這不是一般錯誤去重機制。已送入瀏覽器的 `replaceTrack()` 無法由此取消，因此它可能延遲舊佇列內 promise 的完成，但不會阻塞新 peer，其遲到結果也不能取代新連線的麥克風。

收到下台狀態時，會在通知應用程式前停用並停止已安裝的房間麥克風，以及正在等待裝置替換的候選串流／音量計；不必等 `replaceTrack()` 完成才釋放本機擷取。下台時也會取消尚未完成的房間麥克風授權等待，讓同一 PeerConnection 繼續接收音訊的協商，不必等原生提示回覆。快速下台再上台會建立新的擷取嘗試，舊結果不會被安裝；獨立 `startMicTest()` 預覽不受這項取消影響。這仍不能強制關閉瀏覽器權限提示或取消已交給瀏覽器的 `replaceTrack()`；同一 peer 的後續裝置替換／接收協商仍可能等候該 promise，但已過期的替換不會再套用舊發送方向或啟動舊協商。伺服器仍獨立執行下台停止轉送與發送權限檢查。

## 取消麥克風預覽

`startMicTest({ signal?: AbortSignal })` 可將預覽綁定至 `AbortController`，原本的 `startMicTest()` 不變。

- 已取消的 signal 不呼叫 getUserMedia、不提出麥克風權限要求。
- 等待權限時取消，promise 立即以 signal.reason 拒絕（預設為 AbortError）；瀏覽器原生權限提示無法由此 API 自動關閉，但之後取得的串流會立即停止，不建立 meter 或發出 micready。
- 預覽已啟動後取消，只停止該預覽的音軌／AudioContext，不影響房間正在使用的麥克風，也不影響使用其他 signal 的預覽。
- `MicTest.stop()` 可重複呼叫；手動停止或取消都移除 abort listener。正常權限失敗仍保留原錯誤，disconnect 的既有清理行為不變。

例如建立 `const controller = new AbortController()`，呼叫 `client.startMicTest({ signal: controller.signal })`，在取消按鈕或視圖卸載時呼叫 `controller.abort()`，並在呼叫端處理取消拒絕。這不會取消已經送到伺服器的房間操作。

`disconnect()` 會立即以 `StageError('disconnected')` 拒絕仍等待權限的 `startMicTest()`，即使沒有傳入 AbortSignal；呼叫端應處理這個拒絕。它不會取消你自己的 AbortController，也無法關閉原生權限提示。遲到取得的舊串流仍會停止，遲到拒絕會被接住；同一 client 立即啟動的新預覽不受影響。在 meter 建立或 micready 監聽器中同步斷線，也不會回傳已失效的預覽。

## 音訊統計

`getStats()` 回傳 inbound/outbound 的 mimeType、clockRate、channels、bitrateKbps、packetsLost、jitter、rtt、lossPercent，inbound 另有 `bufferMs`（收到的音訊在瀏覽器 jitter buffer 等待播放的平均毫秒數，網路抖動越大越高）；位元率、inbound 的 lossPercent 與 bufferMs 從兩次呼叫間的差量計算（首次沒有），outbound 的 lossPercent 為伺服器最近一次回報的掉包比例；jitter/rtt 單位秒，瀏覽器未提供的欄位保持 undefined。觀眾可定期呼叫它顯示自己的連線狀態。 缺少、非有限值或重置的計數器不產生差量；重置樣本立即作為新基準，缺值後則由下一筆有效樣本建立基準；重複／倒退時間戳不覆寫基準。建議等待前一次 `getStats()` 完成再輪詢：已被較新結果取代的重疊呼叫，或舊 PeerConnection 的延遲結果，回傳 `{inbound: null, outbound: null}`；目前連線的 `getStats()` 錯誤仍會拒絕 promise。歷史只保留目前報告中的音訊 RTP ID，斷線清除。

## Web Component：`<stage-client>`

不寫 JavaScript 也能嵌入：載入 `stage-element.js`（會自動註冊元素，並重新匯出 `stage-client.js` 的全部 API）即可。

```html
<script type="module" src="https://host/lib/stage-element.js"></script>
<stage-client room="房間 ID" code="房間代碼" name="訪客"></stage-client>
```

- 屬性：`room`、`name`（兩者都有才進房）、`code`、`url`（ws 位址，預設為載入此模組的伺服器 `/ws`）。進入文件即進房、移除即離開（close 1000，席位依伺服器既有離線政策處理）；`room`／`name`／`code`／`url` 變更會重新進房。使用者按「離開房間」後例外：同一元素即使更換這些屬性或移除再掛載，也保持離房，直到明確按「重新加入」；新建元素仍正常自動進房。快速移除／重新掛載或更換屬性時，只讓最新一次掛載繼續進房，舊連線的事件不再更新畫面。
- 錯誤訊息可用旁邊的「關閉錯誤訊息」按鈕隱藏，只整理畫面，不取消請求、重試、離房、改變收聽或麥克風恢復資格。原文字保留，狀態列不變；後續錯誤仍會顯示，關閉不代表問題已解決。既有操作或麥克風恢復清除錯誤時，也會隱藏關閉按鈕。若 host 在 `stage-error` 同步回呼內關閉，同一請求稍後的 promise catch 仍可能再顯示；此操作不新增錯誤去重或因果判定。按鈕位於 alert 之外，可用 `::part(error-dismiss)` 設定外觀；受控測試不等同原生輔助科技驗收。
- 本人名稱：已進房的所有角色可在標籤輸入欄編輯並按「更新名稱」，使用既有 `setName()` 留席更新。另列「目前名稱」只依本人快照顯示，不由 ACK 推測成功；原始草稿交給伺服器清洗及驗證，不另設 maxlength。入席時以目前名稱初始化草稿，同席快照與重連保留編輯，失敗不清空；等待回覆與重連期間停用送出，快照先於 ACK 仍保持 aria-busy。離房、終止連線、移除或換房／換席會清除草稿與舊等待，晚到結果不影響新席位。此功能不反寫 `name` 屬性：SDK 自動重連使用已接受的名稱，但明確「重新加入」仍讀最新屬性，若 host 沒更新 name，會用原加入設定。舊伺服器的 `unknown_type` 照常顯示，不自動重入。測試為受控 DOM／SDK 控制流程，未驗收原生鍵盤、IME 或輔助科技。
- 房間名稱：只有目前主控可見房名輸入欄與「更新房間名稱」，台下主控也可使用既有 `setRoomName()`。另列「目前房間名稱」只採伺服器快照，不由 ACK 回寫；原始草稿不 trim、不加 maxlength，由伺服器既有規則判定。取得主控時從目前房名初始化；同席狀態更新、成功／失敗與暫時重連保留草稿，等待回覆或重連時不能重複送出。失去主控、終止連線、離房、移除或換房／換席即清除；再次取得主控重新初始化，舊結果不清新等待或錯誤。送出當下重查資格，伺服器仍作最終授權；`forbidden`、`bad_request`、`unknown_type` 等錯誤照常顯示，不自動重試。不反寫 `room` 或 `name` 屬性、不新增儲存或媒體操作。可用 `::part(room-name)` 設定外觀；受控測試不代表原生鍵盤、IME 或輔助科技驗收。
- 舉手主持：目前主控可展開「舉手申請」面板，依最新快照的佇列順序查看姓名，明確按「核准上台」或「婉拒」。台下主控同樣可用；只顯示舉手名單，不加入完整觀眾名單、踢人或移交控制功能。每個目標共用一個等待鎖，不能同時核准／婉拒同一人，其他目標仍可操作；即使快照先移除該列後又出現相同 ID，也等原請求完成才解鎖。沒有樂觀移除或自動選人／邀請，伺服器仍決定權限、是否舉手、連線與台位容量；滿台或目標離線可回 stage_full／conflict，婉拒不因此被本機一起停用。重連時標示上次收到的申請，保留展開狀態與等待但停用操作；失去主控、斷線、離房、移除或換房／席位會清空並收起。點擊舊列前重新核對目前目標與主控身份，舊 promise 不釋放新等待；SDK 既有全域 error 事件仍照常轉送／顯示，沒有 request ID 可完整判定舊操作歸屬。hand／role 事件本身不替代快照，競態仍由伺服器裁決；協定沒有每次舉手的 epoch，不保證辨識同 ID 的每次收回再舉手。姓名使用 decodeName 和 textContent，相同姓名仍按不同 ID 操作；不新增計時器、媒體擷取或自動重試。可用 ::part(hands) 設定外觀；受控 DOM／SDK／Hub 測試不代表原生 details 鍵盤、焦點、AT 或硬體音訊驗收。
- 舞台主持：目前主控可展開「舞台管理」，查看其他台上成員的姓名、靜音／鎖定與暫時離線狀態，明確按「鎖定靜音」、「解除靜音鎖定」或「移下台」。台下主控也可用；本人仍使用原有個人麥克風／離台按鈕。解除鎖定只撤銷主控限制，保留對方自己的靜音，不表示遠端開啟麥克風；移下台保留房內觀眾席，不是踢人。離線寬限期間的台上成員仍是合法管理目標，最終權限與狀態由伺服器判定。每個目標共用等待鎖，不能交錯送出鎖定／解鎖／移下台，其他目標不受影響；即使目標先離台再以同 ID 回台，也等原請求完成才解鎖。最新快照決定名單、姓名與鎖定文字，state-before-ACK 不提前解除 pending，沒有樂觀改名單或靜音狀態。role／transferred／stageleft 通知本身不改 SDK 快照；通知先到、快照尚未更新的短窗可能仍送出操作，伺服器按目前權限與台位回 forbidden／conflict。重連保留上次名單、展開與 pending 但停用操作；失權、斷線、離房、移除元件或換房／席位會退役並收起。舊列回呼不能管理重建的列，舊 promise 不清除新 owner 的等待；既有 SDK 全域 error 事件仍照常顯示，無 request ID 可完整隔離舊 wire 錯誤。可用 ::part(stage-management) 設定外觀。沒有新增 SDK／協定、計時器、自動管理或媒體擷取；受控 DOM／SDK／validator／Hub 測試不代表原生 details、鍵盤焦點、AT 或硬體音訊驗收。
- 婉拒回饋：SDK 的 `handrejected` 事件帶 `{roomId, participantId}`，只接受目前連線房間的本人、台下觀眾且已不在舉手狀態的明確通知，不改快照或原 `hand` 事件。Widget 另派發 `stage-handrejected`（原 detail），以 `::part(hand-rejection)` 的普通狀態文字顯示「主控已婉拒這次舉手申請。」；完整範例與 embed 同樣提供獨立提示。原錯誤與控制等待狀態不受影響。新舉手獲伺服器接受、上台／成為主控、重連、斷線、離房或更換身分會清除；失敗重舉不憑點擊抹除已知通知。這是成功 `stage:reject` 後僅送當前在線目標的暫時事件，不保存／補發、不自動重舉；普通收回不推斷婉拒。舊官方 SDK 忽略新事件，新 SDK 面對舊伺服器不產生猜測；沒有逐次舉手 epoch，也不保證第三方嚴格解析器相容。受控測試不代表原生 AT 宣讀或瀏覽器驗收。
- 麥克風選擇：進房後可手動「重新整理麥克風清單」，在具標籤的「麥克風選擇（草稿）」下拉欄選擇，再明確「送出麥克風選擇」。列舉只呼叫 listAudioDevices，不取得麥克風權限或開始擷取；元件掛載、micready、裝置插拔也不自動列舉／切換。空字串「預設（依 SDK 設定）」恢復原 micConstraints，未必是作業系統預設。未授權時名稱可能為空，以匿名序號顯示；裝置名稱採 textContent，ID 只供選項值，不顯示或持久保存。更新清單保留草稿，已消失的選擇以未列出項目保留，可明確送出嘗試或改選，不偷偷改用其他裝置。
  刷新與送出互斥並以 aria-busy 標示，等待中不重複呼叫；同席快照／重連保留清單、草稿與等待，重連停用新操作，離房／斷線／換席／移除元件清理，舊結果不覆寫新操作。當前失敗仍顯示原錯誤並可再次按鈕重試。台下送出只設定下次房間擷取偏好；健康台上透過既有 replaceTrack 替換並保留靜音。麥克風擷取已失敗時，選擇不代替既有「重試麥克風」，需另行明確重試。共用 micready（包括獨立預覽）不結束這個等待。
  草稿不是目前實際擷取裝置：公開 client 可另改設定，且離台／回台等生命週期可使 setInputDevice 正常完成卻未採用該選擇。完成只恢復按鈕，不顯示「已套用」或硬體成功；不新增 SDK API、預覽、儲存、屬性或自動重試。可用 ::part(microphone) 設定外觀。驗證限公開 SDK 與受控 DOM／socket／media，原生下拉鍵盤、AT、權限與實體音訊未驗收。


- 發言者摘要：所有已進房者可看到最近收到的伺服器發言偵測回報，按目前台上順序列出名稱與人數。尚未收到時顯示等待，明確空集合才顯示「未偵測到發言」；回報中的 ID 無法對應台上成員時另作說明，不公開未知 ID 或觀眾名稱。名稱依目前快照安全顯示，改名與移出台上會同步更新；已移除或當下無法對應的 ID 不會因之後上台而復活舊活動，須等新回報；控制連線暫時斷開但仍在台上的寬限席位不因此排除。重連、終止連線、離房或換席清除舊集合，恢復快照後須再收到新回報，不從 SDK 保留的 getter 還原。這是伺服器活動偵測（VAD），沒有時間戳，不保證即時或實際可聽見音訊；空集合也不是無音訊的證明。本機收聽靜音、音量、自動播放與傳輸狀態可能不同。不增加輪詢或媒體操作，原 `stage-speaking` detail 仍原樣轉送；摘要為普通文字，未新增頻繁宣讀的 live region。可用 `::part(speaking)` 設定外觀；原生畫面、輔助科技與實體音訊仍需驗收。
- 本人連線品質：台上者收到自己的 `quality` 報告後，顯示最近收到的上／下行掉包率及 RTT；缺失或無效值顯示「—」，0 仍顯示 0，不據此推斷健康。只取本人 ID，不顯示其他發言者資料；觀眾與台下主控隱藏。重連、下台、離房／換席及房間麥克風錯誤會清除，`micready` 不會還原舊值，必須再收到本人報告；一般同席快照保留已收到的數字。這是歷史回報而非即時狀態，RTT 不是端到端音訊延遲；事件沒有時間戳／peer 世代，麥克風錯誤後才到達的報告也不證明已恢復。伺服器無新報告時不自動推測過期或良好。沒有額外輪詢、媒體操作或控制請求，`stage-quality` 照原物件轉送；原生畫面、輔助科技與音訊仍需驗收。
- 舉手佇列位置來自目前 `state.hands` 的本人 ID；快照更新時重算，未找到本人則只顯示「已舉手」，重連期間標示「上次佇列」。保留寬限期的斷線者仍在佇列中；主控可任意核准人選，因此這不是保證的發言順序或等待時間。
- 輸出裝置選擇：已進房時可在「輸出裝置選擇（草稿）」手動重新整理揚聲器／耳機清單，再明確送出選擇；選單變更本身不呼叫 setSinkId。空字串沿用既有 SDK 的系統預設輸出，不支援 outputDeviceSupported 的瀏覽器顯示說明並停用此組控制。名稱以 textContent 顯示，匿名裝置有通用名稱；重新整理後缺失的草稿保留為未列出項，不偷偷改用其他裝置。重新整理與送出共用等待鎖，送出完成只恢復控制，草稿不表示目前實際輸出、已套用或可聽音訊；不會自動 enumerate、play、開麥克風或儲存裝置 ID，也不另呼叫權限申請 API；setSinkId 的裝置存取與權限仍由瀏覽器決定。
  輸出設定作用於同一 client 的 audio 元件，因此等待／草稿／清單按 client 生命週期保留，而非按 room／participant 重設。公開 client 斷線、關房、換席或重入相同／不同房間時，沒有有效房間便隱藏停用；重新取得快照仍要等原輸出操作完成才可再次送出。一般重連保留顯示但停用。真正更換 client 或移除元件才退役舊 UI，既有 setSinkId 無取消 API，不能取消已交給瀏覽器的操作；舊 client 的遲到完成不操作新 client 的控制。永不完成的操作持續等待，沒有新增 timeout／強制解除；目前有效連線且可見 owner 的失敗可明確重試，隱藏或重連等待期間的失敗不另冒出錯誤。宿主直接呼叫 element.client.setOutputDevice 不經此 UI 鎖，不能保證與宿主並行選擇的先後結果。可用 ::part(output-device) 設定外觀；驗證限公開 SDK 與受控 DOM／audio／socket，原生裝置、權限、鍵盤、AT 與實際播放未驗收。
- 內建介面：狀態列（房名．直播狀態．收聽中／已舉手／台上；舉手時顯示目前佇列第幾位）、錯誤列、`啟用音訊`（自動播放被擋時出現，失敗可重試、成功後隱藏）、觀眾的舉手／收回（含冷卻倒數）、台上的麥克風靜音／離開舞台、台下主控的返回舞台，以及所有已進房者的「靜音收聽／恢復收聽」。離開、關房與被踢後隱藏失效操作。除房名、舉手申請與舞台靜音／移下台以外的主控管理功能請改用 `element.client`（底層 `StageClient`，尚未建立實例、明確離房或元件已移除時為 null）。
- 所有已收到房間快照的參與者另有「離開房間」，初次 ACK 尚未到達或信令重連中也可使用。先退休目前 client 與舊請求／事件，再沿用 SDK disconnect 清理本機擷取、收聽及重連；顯示「已離開房間。」與手動「重新加入」，cleanup 等待期間按鈕停用並標示 aria-busy。屬性與收聽偏好保留，重新加入採用當時最新值；沒有自動重新加入，也不保證還原先前 participant、台位或主控身分。主控的伺服器寬限政策不變，離房不是關閉房間，不保證底層 socket 立即完成關閉。與元件移除相同，先退休的 client 事件（含 disconnect status）不再轉送，不另外產生合成 stage-status；`element.client` 在這次 teardown 後為 null。直接呼叫公開 `element.client.disconnect()` 仍採原本事件／提示行為，不會建立這個手動重入狀態。關房／被踢亦不新增重入按鈕。
- 個人舞台按鈕依目前快照切換：台上者「離開舞台」，台下主控「返回舞台」，一般台下觀眾隱藏。主控下台仍保留主控權限；返回沿用伺服器的主控席位與准入規則，可能依既有 SDK 流程再次要求麥克風。強制靜音不妨礙下台。快照早於 ACK 時可先切換文字，但同一按鈕仍保持 pending／aria-busy，直到原請求完成；錯誤保留原本回報，不自動重試。
- 台上麥克風擷取失敗或自然中斷後，提供「重試麥克風」，只在使用者按下時呼叫既有 `retryMicrophone()`。接納後顯示「正在要求麥克風…」與 `aria-busy`，直到 `micready`／`micerror` 或該房間／台位生命週期結束；boolean 回傳不是完成擷取。回 `false` 時恢復按鈕並保留目前錯誤，同步例外仍可回報。重連期間停用但保留同席待處理狀態；下台、換房、離線或移除元件清除。自我／強制靜音不阻止擷取準備，也不會因此解除靜音。只清除屬於該次麥克風失敗的舊提示，較新的其他錯誤保留。房間初次／重試擷取的 `micready` 早於 sender 安裝，且事件與裝置替換及 `element.client.startMicTest()` 的獨立預覽共用；它會結束這個 UI 的擷取等待，但不證明房間麥克風已傳送、協商完成或可聽見，後續安裝錯誤照常顯示。
- 本機收聽靜音：布林屬性 `playback-muted` 與反映它的 `element.playbackMuted` property。加入 `playback-muted` 可初始靜音；移除屬性或設定 property 為 false 恢復收聽。HTML 布林屬性只看是否存在，`playback-muted="false"` 仍表示靜音。變更立即套用於本機 audio，不重新進房、不送控制請求、不改麥克風；更換房間、移除再掛載與 ws 重連保留設定。建議透過此 widget property 控制收聽偏好；直接修改 `element.client` 的 audio 設定不會反映回 widget attribute。按鈕使用原生 button 與 `aria-pressed`，未進房時隱藏。
- 本機收聽音量：`playback-volume="0.5"` 或 `element.playbackVolume = 0.5`，範圍 0–1（預設 1）。property 反映到 attribute，非有限數值或超出範圍會拋出 RangeError 且不改原設定；attribute 缺省、移除、空白或無效時採 1。初始音量在 connect 前套用，執行中變更不重新進房，換房／移除再掛載／ws 重連保留偏好。音量 0 不會切換 `playback-muted`，調高音量也不會解除靜音；不影響麥克風或其他人，直接改底層 client 不會反映回 widget attribute。 進房後也可使用「收聽音量」原生滑桿，以 1% 為單位調整 0–100%，旁邊顯示百分比，信令重連時仍可調整。本機靜音保持獨立，調高音量不會自動解除靜音；外部 property 的更精細數值仍完整保留，滑桿只顯示最接近的整數百分比，不因重畫而回寫四捨五入的值。沒有新增儲存或自動播放要求。
- 進場進度：連線握手期間顯示「連線中…」，等待加入房間時顯示「正在加入房間…」。快照一到即顯示房間與操作，不等 ACK；沒有快照的當前進場失敗顯示「未連線」與原本錯誤。離開／關房／被踢的提示優先，舊進場回覆不會覆寫換房後的畫面。這只是 widget 文案，不新增 SDK status 或 `stage-status` 事件值。
- 初次握手／加入仍在等待且從未收到房間狀態時，提供「取消加入」。按下會立即停止本機等待、顯示「已取消加入。」並提供手動「重試加入」，保留屬性與收聽偏好；取消自己的等待不顯示成加入錯誤，其他當前錯誤照常顯示。快照到達（包括 ACK 前）、關房／被踢、換房或移除後會撤銷取消操作，自動重連不提供此按鈕。取消不保證撤銷伺服器已接受的加入，也不保證底層 socket 立即關閉。
- 初次連線／加入失敗且從未收到房間狀態時，顯示「重試加入」。按下會先清理舊 client，再使用目前 url／room／code／name 與收聽偏好重新加入；等待中隱藏並停用，避免重複送出。這是手動重試，不會自動重試錯誤；已收到房間狀態、正在自動回座、關房／維護或被踢後不顯示。若房間不存在或代碼錯誤，重試仍由伺服器判定，嵌入端需修正相應屬性。
- 信令重連時，舉手／收回、麥克風靜音／解除與離開／返回舞台按鈕暫停操作，直到回座狀態恢復；初次加入若快照已到、ACK 未到就斷線，SDK 雖可能暫留快照，這些按鈕也會停用。接納操作前以目前 status 重查，host 在狀態事件轉送期間同步點擊尚未重繪的舊按鈕，也不會進入等待或清除目前錯誤。離開房間仍可清理本機狀態；既有 pending、舉手冷卻與強制靜音限制仍適用。本機收聽靜音、音量與啟用音訊仍可操作。這只限制 widget 按鈕，不改 SDK 請求的送出／重試語意，也不自動改變麥克風狀態。
- widget 的「啟用音訊」只接受目前已進房的手動點擊；明確斷線、關房、被踢或元件退場會撤銷原本播放操作，先隱藏失效按鈕，再轉送事件。舊 promise 不會顯示前一席位的錯誤、隱藏同一 SDK client 再次進房的新提示，或解除新操作的 busy；同席位後來收到的新 audioblocked 提示也不會被較早的成功結果清掉。仍保留媒體的信令重連可繼續解鎖，目前操作的失敗可手動再試。點擊仍同步呼叫 SDK，不自動播放、不更改瀏覽器權限；fake DOM／socket／media 測試只驗證操作歸屬，未驗證原生播放 promise 排序或可聽音訊。
- 主控鎖定台上麥克風時，狀態列顯示「台上（主控已鎖定靜音）」，停用的麥克風按鈕顯示「麥克風已被主控靜音」，說明無法自行解除的原因。主控解除鎖定後，文字與可用性仍依當前靜音、重連與等待回覆狀態更新；自己原先的靜音不會因此自動解除。

- 舉手／收回與麥克風靜音按鈕在接納 click 前重查目前席位、重連、冷卻與強制靜音限制。即使主頁的 `stage-state`／`stage-status` listener 在畫面重繪前同步點擊舊的 enabled 按鈕，已失效操作也不進入 pending、不清除目前錯誤、不送請求或占用 SDK 舉手冷卻；隱藏的這兩種控制同時停用。有效操作仍沿用目前快照選擇 raise／withdraw 或 mute／unmute，並保留各自等待 ACK 與錯誤處理。
- 連線結束提示：呼叫 `element.client.disconnect()` 會顯示「未連線」並隱藏房內操作；一般關房、被移出與伺服器維護／重啟各有提示，收聽偏好變更不會清掉提示。換房或重新掛載後清除舊提示，舊 client 的遲到事件不更新或重新派發到新 widget。
- 事件：所有 client 事件以 `stage-<type>` 從元素派發（`bubbles`、`composed`，`detail` 相同），例如 `stage-state`、`stage-hand`、`stage-kicked`。
- 樣式：`::part(panel)`、`::part(status)`、`::part(error)`、`::part(error-dismiss)`、`::part(actions)`、`::part(playback)`、`::part(name)`、`::part(room-name)`、`::part(quality)`、`::part(speaking)`，以及 CSS 變數 `--stage-fg`、`--stage-bg`、`--stage-border`、`--stage-radius`、`--stage-button-bg`、`--stage-accent`、`--stage-accent-fg`、`--stage-error`。
- 自訂標籤名：`import { defineStageElement } from 'https://host/lib/stage-element.js'` 後呼叫 `defineStageElement('my-stage')`（`stage-client` 已於載入時註冊，多個自訂標籤可並存）。每個自訂標籤使用 `StageElement` 的獨立子類別，因此仍是 `instanceof StageElement`，但 constructor 不與預設／其他標籤相同；重複註冊同名標籤為 no-op，既有其他元件不被覆寫。

`<stage-client>` 的舉手、麥克風、離開／返回舞台與音訊解鎖按鈕在各自請求完成前保持停用並標示 `aria-busy`，不會被冷卻倒數或新 state 的重新繪製提前解鎖。失敗後顯示錯誤並重新套用目前冷卻／強制靜音限制；切換房間或移除元件時，舊請求不會改動新房間的按鈕狀態。

嵌入元件只在可見的舉手冷卻倒數需要更新時安排單一 timer，於顯示秒數邊界更新；舉手中、台上、主控、閒置或房間結束時不做週期重繪。狀態事件仍即時更新 UI，倒數結束也不會提前解除尚未完成操作的停用狀態。同席重連收到不同 `hello.limits` 時，若下一個倒數邊界提前，timer 也會提前；較晚的新邊界可保留一次原先較早的喚醒，之後按最新剩餘時間重排。

## 嵌入與瀏覽器政策

- 正式環境須 HTTPS/WSS；CSP `script-src` 允許函式庫來源，`connect-src wss://host`（視 WebRTC 部署增加允許來源），`media-src blob: mediastream:`。若自行傳入音訊元件，仍須允許串流播放。
- iframe 須上層 Permissions-Policy 允許 `microphone` 給嵌入來源，且 iframe 設 `allow="microphone; autoplay"`。跨站頁也須符合自身的 CSP。
- `audioblocked` 時顯示按鈕，在使用者點擊事件立即呼叫 `unlockAudio()`；不要在等待網路請求後才解鎖。
- 已退場 PeerConnection 的 `play()` 遲到失敗不會再發出 `audioblocked`，避免離房或新連線已播放後出現過期提示。目前 peer 的播放失敗仍照常通知；`unlockAudio()` 保留瀏覽器播放 promise 的成功／失敗結果，不繞過自動播放政策。
- 房間代碼及 resume token 僅保存在執行期記憶體，不要記錄到日誌。邀請 URL 含代碼，請當作敏感資訊分享，建議頁面設定 `Referrer-Policy: no-referrer`。

## 發佈靜態檔案

根目錄 `npm run build` 會為瀏覽器 ESM 產生 Brotli／gzip 副本，由 Stage.js 靜態伺服器自動協商。直接執行 client workspace 的 build 仍可使用未壓縮原檔；需要副本時再執行 `node scripts/precompress.ts packages/client/dist`。部署請一併保留原檔與副本，第三方嵌入 URL 仍為 `/lib/stage-client.js`，無需改成 `.br` 或 `.gz`。

## 信令整合測試

`npm test -w packages/client` 也會啟動獨立 Node 子程序的 loopback 伺服器，讓實際 StageClient 經真實 WebSocket 完成建立／加入房間、舉手核准、個人／主控靜音、下台、同席位與同媒體 peer 自動恢復、被踢與伺服器關閉。同一流程會分別使用預設 unlimited 與 maxPendingControlRequests=1，並檢查額外控制操作的本機拒絕、名額釋放與信令仍可完成；cap=1 的 child fixture 刻意延後初次 join ACK，確認名額仍占用時 SDP 已完成，再釋放 ACK。測試檢查個人化快照、ACK 錯誤、收聽偏好保留，以及終止後不重連；伺服器使用 MockMediaTransport，瀏覽器 PeerConnection／音軌／AudioContext 為 fake，不代表實際 ICE、音訊品質或瀏覽器權限驗證。需允許本機 loopback listener 與 Node 子程序；不使用外部服務。

`micNoopIntegration.test.ts` 另外以主控、發言者、觀眾三個實際 SDK 經 native WebSocket，檢查五種重複麥克風控制只刷新發起者的個人化 state，順序仍為 state → ACK → 公開 Promise 完成；底層 self／force mute 真正改變時仍廣播。觀察者的零額外快照以各自連線的 ping／pong 排序屏障確認，不以短暫 sleep 當作沒有訊息的證據。測試也涵蓋私人欄位、gain 正規化、既有 peer／mixer 身分、權限拒絕後恢復，以及延後 ACK 的逾時、名額釋放和舊 ACK 隔離；媒體仍為 fake／MockMediaTransport，不是實際音訊或效能測量。
