# Stage.js 多人音訊舞台系統 企劃書 v1.7

> 本檔為企劃書全文匯入之定案稿（AGENTS.md／README.md 以此為準，更新時同步）。
> v1.7（2026-10-09 裁示）：取樣率由 44.1kHz 改為 **48kHz**——Opus 原生取樣率，擷取→混音→編解碼全程 48kHz，不再重取樣。實作決策與協定擴充見文末「十二」。

一句話：以 **WebSocket** 為控制平面、**WebRTC** 為音訊平面的多人音訊舞台系統（**Stage.js**）——一位主控與一到多位發言者在台發言，觀眾只可聆聽、可舉手爭取上台；多人同時發言由伺服器端混音成單一 Opus 串流分送全場。

### 基本資料

| 欄位 | 內容 |
|---|---|
| 本作品名稱 | **Stage.js**（多人音訊舞台系統） |
| 程式語言 | **TypeScript** |
| 執行環境 | **Node.js v24**（裁示；本機實測 `node -v` = v26.10.0、`npm -v` = 11.19.1，2026-10-09；本機 nvm 未裝 v24，見假設 1） |
| 通訊/介面 | **WebSocket**（控制平面：角色、舉手、上下台、控制權移交、WebRTC 信令）＋**WebRTC**（音訊平面） |
| 音訊規格 | **Opus mono、VBR 32–128kbps、48kHz**；多人同時發言由伺服器端混音 |
| 本作品倉庫 | https://github.com/JS-PACKAGE/Stage.js（main） |
| 本作品授權 | **Apache-2.0**（以倉庫根 `LICENSE` 為準，實作不得改寫） |
| 前置檔案 | `LICENSE` **已在 main**（2026-10-09 經 GitHub API 驗證，見 Gate 0） |

結構：〇 概述 → 一 需求總表 → 二 系統架構 → 三 媒體層與混音 → 四 通訊協定 → 五 資料模型 → 六 安全性 → 七 必要文件 → 八 倉庫與部署 → 九 風險 → 十 里程碑與 Gate → 十一 已知假設與未定項。全程以「執行 Agent」泛指實作方，不綁定特定工具。

---

## 〇、專案概述

### 目標
- 以 TypeScript／Node.js v24 建置多人音訊舞台系統 **Stage.js**：一位**主控**＋一到多位**發言者**在台發言，**觀眾只可聆聽、不可發話**。
- 控制面（角色、舉手、上台、下台、控制權移交）走 **WebSocket**；音訊面走 **WebRTC**（SDP／ICE 信令亦走同一 ws 通道）。
- 多位發言者同時發言時，**伺服器端混音**成單一串流分送觀眾；音訊 **Opus mono、VBR 32–128kbps、48kHz**。
- 觀眾可舉手表示願意上台，由**主控核准**；台上主持可隨時下台（主控下台僅停止發言、**保有控制權**）；主控可移交控制權給其他人。
- 單一 process 支援**多房間**（多個舞台並行、房間建立／關閉）；進場驗證＝**房間代碼**（建立時產生、可關閉；裁示 2026-10-09）。
- 前端交付＝**可嵌入的瀏覽器 client 函式庫**＋**完整範例前端**（響應式手機版、主題化、多人列表管理介面）；實際應用由其他網站程式整合（裁示 2026-10-09）。
- 交付必要文件四件（README／AGENTS／CLAUDE／PLAN）後才收尾實作。

### 範圍外
- 影片、螢幕分享、文字聊天室。
- 錄音存檔與回放、直播轉推（RTMP／HLS）。
- 帳號系統與持久化（使用者、舞台、操作紀錄均記憶體保存，重啟即失）。
- 套件發布（npm）：只開源倉庫供 clone，不發套件（見假設 6）。
- 其他網站的整合案本身（各站程式）；本專案交付 client 函式庫＋範例前端。

### 硬性要求

| 編號 | 要求 |
|---|---|
| R1 | TypeScript 開發；執行環境 Node.js **v24**（裁示） |
| R2 | 控制面走 **WebSocket**；音訊面走 **WebRTC**（信令 SDP／ICE 走 ws） |
| R3 | 音訊編碼 **Opus mono、VBR 32–128kbps、48kHz**；多位發言者同時發言由**伺服器端混音**成單一串流分送 |
| R4 | 角色與流程：一位**主控**＋一到多位**發言者**在台發言；**觀眾只可聆聽、不可發話**；觀眾可**舉手**表示願意上台（主控核准）；台上主持可**隨時下台**（主控下台僅停止發言、保有控制權）；主控可**移交控制權**給其他人 |
| R5 | 安全：對外強制 wss/TLS；輸入驗證與每連線限流；角色由伺服器狀態機強制（觀眾端無上行音軌授權）；憑證不入日誌（詳第六節） |
| R6 | 必要文件四件：`README.md`／`AGENTS.md`／`CLAUDE.md`／`PLAN.md` |
| R7 | 實作順序：Gate 0（倉庫根檔＋必要文件）達成後才寫程式 |
| R8 | 前端交付：**可嵌入的瀏覽器 client 函式庫**＋**完整範例前端**（響應式手機版、主題化、多人列表管理介面）；實際應用由其他網站程式整合（裁示） |
| R9 | 多房間：單一 process 同時承載多個舞台（房間建立／關閉）；進場驗證＝**房間代碼**（建立時產生，可關閉；裁示） |

---

## 一、需求總表

| 面向 | 需求 |
|---|---|
| 角色與流程 | 主控 1 人＋發言者 1 到多人在台；觀眾只聽不講；舉手→核准→上台；隨時下台；控制權移交（詳「五」狀態機） |
| 房間 | 多房間：`room:create`／`room:close`；各房狀態獨立；每房上限＝發言者 ≤ 8、觀眾 ≤ 300 |
| 連線 | ws 以 `join`（roomId＋房間代碼）註冊身分並收 `room:state` snapshot；斷線自動重連並重送 snapshot；WebRTC 連線以 ICE 保活維持 |
| 音訊上行 | 僅主控與在台發言者可上行 Opus mono 音軌；觀眾端 SDP 僅 accept `recvonly`（伺服器強制） |
| 音訊下行 | 全體收**單一混音串流**（Opus mono、VBR 32–128kbps、48kHz）；台上者收不含自己的混音（避免回音，見假設 4） |
| 伺服器混音 | N 路 Opus 解碼 → PCM 48kHz 線性疊加＋limiter → 單路 Opus 編碼；每房同時發言者 **≤ 8**、觀眾 **≤ 300**（裁示） |
| 控制面 | 舉手／收回、核准／婉拒上台、下台、靜音（含主控強制靜音）、移出舞台、控制權移交；全部經 ws JSON |
| 前端 | client 函式庫（ESM，可嵌入其他網站程式）＋完整範例前端（響應式手機版、主題化、多人列表管理介面） |
| 安全性 | 全部依 R5；細則見「六、安全性架構」 |
| 專案文件 | 四件必要文件（R6）；安全性章節完整寫入 `AGENTS.md` |
| 部署 | **部署後定**（裁示）：程式先完成，細節另案裁示、不影響程式實作；預期形態＝Node 程序＋wss＋STUN/TURN |

---

## 二、系統架構

```
[瀏覽器｜主控/發言者/觀眾]
   ├─ ⇄ wss:// 控制平面：join、舉手、上下台、移交、狀態推送（JSON frames）
   └─ ⇄ WebRTC 音訊平面：發言者上行 Opus mono；全體下行混音流
          （SDP／ICE 信令由 ws 轉送）
[Stage.js 伺服器｜Node v24｜TypeScript]
   ├─ src/ws/         控制平面：房間管理、連線管理、角色狀態機、舉手佇列、限流
   ├─ src/rtc/        音訊平面：PeerConnection 管理、信令中繼、ICE 設定
   ├─ src/mixer/      伺服器混音：Opus decode → PCM 48kHz mix → Opus encode
   ├─ src/model/      Room／Participant/Role DTO 與不變量
   ├─ src/transport/  MediaTransport 介面＋實作（選型見未定項 1）＋Mock
   └─ config.yaml     埠號、編碼參數、上限、STUN/TURN（程式不得寫死）
[client 函式庫 packages/client｜ESM，供其他網站程式整合]
[範例前端 web/]  完整 UI：響應式手機版、主題化、多人列表管理介面（建於 client 之上）
```

- **語言與建置**：`tsc` → `dist/`（Node ESM，目標 Node v24）；`npm run typecheck`（`tsc --noEmit`）、`npm test`（`node --test`＋MockMediaTransport）。
- **依賴策略**：控制面僅 `ws`＋`yaml`；媒體層＝`werift`＋Opus 編解碼（3.3 裁示定案）；前端 vanilla TypeScript＋Vite（假設 5）。全部釘選版本。
- **狀態儲存**：記憶體（不持久化，與範圍外一致）。
- **部署形態**：自架 Node 程序，wss 對外（見「八」）。

---

## 三、媒體層契約與伺服器混音

> 本節定**本系統需要的最小契約**；媒體層已裁示為 **werift**（2026-10-09），實作一律經 `MediaTransport` 介面＋Mock，選型升版時**只換 adapter 實作**，不動核心狀態機與混音契約。

### 3.1 MediaTransport 最小契約（實作含 MockMediaTransport，無 WebRTC 環境可開發測試；所有方法帶 `roomId` 語境，多房間見 R9）

| 契約方法 | 說明 |
|---|---|
| `addPublisher(participantId, onAudioFrame)` | 接收發言者上行 Opus，解碼後以 PCM frame（48kHz、20ms＝960 samples）回調 |
| `removePublisher(participantId)` | 移除上行來源 |
| `setMixedStream(pcmSource)` | 接上混音輸出，向全體訂閱者編碼為單路 Opus 下行 |
| `subscribe(participantId)`／`unsubscribe(participantId)` | 下行訂閱管理（台上者取得「不含自己」的混音） |
| `getStats(participantId)` | 位元率、RTT、丟包（Gate 驗收用） |

### 3.2 混音管線契約
- 輸入：N 路 PCM float 48kHz（Opus 解碼後）→ 線性疊加 → soft-clip／limiter（防爆音）→ 單路 **Opus mono、VBR 32–128kbps** 編碼。
- 編碼參數值入 `config.yaml`：bitrate 上下限（32／128）、VBR 開啟、frame 20ms、complexity、取樣率 48kHz（程式不得寫死）。
- 技術註記：WebRTC 的 Opus RTP 時鐘固定 48kHz（RFC 7587），與擷取／混音／編碼取樣率一致，**全程無重取樣**（v1.7 裁示；libopus 僅支援 8/12/16/24/48kHz，`config.yaml` 取樣率限此五值）。
- 每個訂閱者只收**單一混音串流**（R3），發言者與觀眾下行規格一致。

### 3.3 選型定案：werift（2026-10-09 裁示）

- **werift**（純 TypeScript WebRTC for Node.js，npm）：全 TS 疊層（ICE/DTLS/RTP），npm 公布相容 Node ≥22（v24 相容）；RTP 可達 JS 層，混音在 Node 內 decode→mix→encode，語言純淨。
- 未採用候選（備查）：mediasoup（純 SFU 不混音，需 GStreamer／RTP 疊層）、外部媒體伺服器（Janus／LiveKit，多一層部署整合）。
- werift 釘選版本於 Phase 2 安裝時定案並記入 `package.json`。

---

## 四、通訊協定（控制平面 wss，JSON frames；WebRTC 信令同走 ws）

### Server → Client

| type | 負載 |
|---|---|
| `hello` | `{ protocol: 1, serverVersion }` |
| `room:state` | `{ roomId, controllerId, speakers: [...], hands: [...], me: Participant }`（snapshot，連線即送、變動重送） |
| `room:created` | `{ roomId, code? }`（僅建立者收到 code） |
| `room:closed` | `{ roomId }`（房間關閉，全員離場） |
| `role:update` | `{ participantId, role, reason? }` |
| `hand:raise`／`hand:withdraw` | `{ participantId }` |
| `stage:invite` | `{ participantId, byId }`（核准後邀請上台） |
| `stage:joined`／`stage:left` | `{ participantId, role, reason? }`（`left.reason`：`"leave"`｜`"removed"`） |
| `control:transferred` | `{ fromId, toId }` |
| `mic:muted`／`mic:unmuted` | `{ participantId }` |
| `rtc:offer`／`rtc:answer`／`rtc:ice` | WebRTC 信令中繼 `{ fromId, payload }` |
| `error` | `{ requestId?, code, message }`（generic） |
| `status` | `{ state: "waiting"｜"live"｜"reconnecting" }` |

### Client → Server

| type | 負載 |
|---|---|
| `room:create` | `{ requestId, name? }`（建立者成為第一位主控） |
| `room:close` | `{ requestId }`（僅主控） |
| `join` | `{ requestId, roomId, code?, name }` |
| `hand:raise`／`hand:withdraw` | `{ requestId }` |
| `stage:approve`／`stage:reject` | `{ requestId, targetId }`（僅主控） |
| `stage:leave` | `{ requestId }`（下台；主控下台行為見狀態機） |
| `control:transfer` | `{ requestId, targetId }`（僅主控） |
| `mic:mute`／`mic:unmute` | `{ requestId }`（自我靜音） |
| `mic:force-mute`／`mic:force-unmute` | `{ requestId, targetId }`（僅主控） |
| `stage:remove` | `{ requestId, targetId }`（僅主控，移出舞台→觀眾） |
| `rtc:offer`／`rtc:answer`／`rtc:ice` | `{ requestId, payload }` |
| `ping` | `{}` |

### 限制
- frame ≤ 64KB（音訊一律走 WebRTC，不走 ws）；控制訊息 ≤ 20/秒/連線；`hand:raise` ≤ 1 次/10 秒；`rtc:ice` ≤ 30/秒；name ≤ 32 字元、code ≤ 16 字元；未知 type 忽略並回 `error`。

### 流程範例（Gate 驗收依據）
1. **舉手上台**：觀眾 `hand:raise` → 全場收到 `hand:raise` → 主控 `stage:approve` → 雙方交換 `rtc:offer/answer/ice` → `stage:joined` → 該員成為發言者、上行音軌啟用。
2. **下台**：發言者 `stage:leave` → `stage:left` → 上行拆除、改訂閱純觀眾混音；主控下台僅停止發言、**控制權保留**（裁示），移交另以 `control:transfer` 為之。
3. **控制權移交**：主控 `control:transfer` → `control:transferred` → 新主控取得核准／移交權限，原主控降為發言者（在台）或觀眾（不在台）。
4. **開房／關房**：`room:create` → `room:created`（含房間代碼）→ 以 `join`＋代碼進場 → 主控 `room:close` → `room:closed` 全員離房、資源釋放。

---

## 五、資料模型與角色狀態機

```
Rooms       = Map<roomId, Room>
Room        { roomId, name, code?: string, codeRequired: boolean, controllerId,
              speakers: Set<participantId>, handQueue: participantId[], createdAt }
Participant { participantId, name, role: "controller"｜"speaker"｜"audience",
              handRaised: boolean, muted: boolean, joinedAt }
```
- **不變量**：每房 `controllerId` 恰 1 人；`speakers` 皆在台；audience 無上行音軌；`handQueue` 不含在台者；各房間狀態獨立；每房上限＝發言者 ≤ 8、觀眾 ≤ 300。
- **房間生命週期**：`room:create` 建立（建立者為第一位主控，代碼隨機產生、可關閉）；`room:close`（僅主控）→ 廣播 `room:closed`、全員離房、資源釋放。
- **生命週期**：連線 `join`（roomId＋代碼）即註冊（預設 audience）；斷線後席位保留一段寬限（主控 **60 秒**、其他人 `rooms.participantGraceMs`，皆可調整），以 `resumeToken` 回座；**主控下台不觸發移交**，主控斷線逾寬限才自動移交（台上最早發言者 → 最早觀眾，見假設 4），其他人逾寬限即移除（見「十二」18）。
- **狀態變更**：全部經單序事件佇列原子套用，同一 participant 的上下台／移交不得交錯（安全節 6）。
- **持久化**：無（記憶體，重啟即失；與範圍外一致）。

---

## 六、安全性架構（**須完整寫入 `AGENTS.md` 作為撰寫硬規則**）

1. 對外強制 **wss/TLS**；明文 ws 僅限本機開發模式（`config.yaml` 顯式開啟）。
2. 角色由伺服器狀態機強制：觀眾端 SDP 僅 accept `recvonly`，未經核准不得上行音軌；違規訊息 **fail-closed** 拒絕。
3. 輸入驗證＋尺寸上限：frame ≤ 64KB、name ≤ 32 字元並轉義、`targetId` 限既有 participantId、未知 type 忽略。
4. 每連線頻率限制：控制訊息 ≤ 20/秒、`hand:raise` ≤ 1 次/10 秒、`rtc:ice` ≤ 30/秒；超過斷線並記 warning。
5. STUN/TURN 憑證（coturn）不入版本控制、不入日誌；`config.yaml` 個人值不入庫（`config.example.yaml` 入庫）。
6. 競態保證：控制權移交與上下台以單序事件佇列處理，狀態變更原子套用；「雙主控」為不變量違例即 fail-closed。
7. 資源防護：每房同時發言者 **≤ 8**、每房觀眾 **≤ 300**（裁示）；混音 PCM 緩衝上限、limiter 防爆音；超過上限拒絕新上行／新連線（fail-closed）。
8. 對外一律 generic 錯誤；內部原因只入本地日誌；使用者可控文字（name）一律轉義後輸出。
9. 依賴釘選版本；`npm audit` 無 high 以上（Gate 5 驗收）。
10. 進場驗證＝**房間代碼**（裁示）：建立時隨機產生、可關閉；代碼不入日誌；client 需嵌入第三方網站，ws **不採 Origin 白名單封鎖**，改以房間代碼＋連線限流與上限防護。

---

## 七、必要文件規格

| 檔案 | 內容要求 |
|---|---|
| `README.md` | 用途、系統架構圖、需求（Node v24）、安裝啟動、ws 協定摘要、`config.yaml` 說明、**client 函式庫整合方式（嵌入其他網站）**、測試指令、授權宣告（Apache-2.0） |
| `AGENTS.md` | 撰寫方式：語言規範、建置測試指令、結構對應、**安全性章節＝第六節全部規則逐條編號**、媒體層一律經 MediaTransport adapter |
| `CLAUDE.md` | 僅**引用 `AGENTS.md`**（一行指向＋摘要），不重複內容避免雙真值來源 |
| `PLAN.md` | **本企劃書全文匯入之定案稿**（更新時同步） |

---

## 八、倉庫與部署

- **前置檔案**：`LICENSE`（Apache-2.0）——**已在 main**（2026-10-09 經 GitHub API 驗證；倉庫具 admin／push 權限）。不得改寫。
- **倉庫**：https://github.com/JS-PACKAGE/Stage.js（main）——公開開源供 clone，不發布 npm（見假設 6）；必要文件與程式碼入庫；`config.yaml` 個人值不入庫（`config.example.yaml` 入庫）。
- **服務部署**：**部署後定**（裁示 2026-10-09）：程式先完成，部署細節另案裁示、**不影響程式實作**；預期形態＝Node 程序＋wss＋STUN/TURN（coturn 或既有服務），TLS 終止與平台另案定案；STUN/TURN 與 TLS 配置值入 `config.yaml`，程式不得寫死。
- **介紹頁**：無公開介紹網址（範圍外）。

---

## 九、風險與因應

| 風險 | 影響 | 因應 |
|---|---|---|
| 伺服器混音 CPU（N 路 decode/mix/encode） | 延遲、爆音、成本 | 同時發言上限＋limiter；werift 混音管線 CPU 監控；Gate 3 壓測案例 |
| 對稱 NAT／防火牆穿透失敗 | 觀眾無聲 | TURN（coturn）必備；部署後跨網路實測（Gate 5 ⑤） |
| 混音與傳輸延遲 | 體驗劣化 | 20ms frame＋jitter buffer；延遲量測列入 Gate 3（目標 ≤ 300ms，可調整） |
| ws 中斷／信令遺失 | 控制失靈、上台卡住 | 自動重連＋snapshot 重送；WebRTC 連線獨立存活並 ICE 保活 |
| 狀態競態（同時移交／上下台） | 雙主控、權限錯亂 | 單序事件佇列＋原子狀態機；不變量測試列入 Gate 1 |
| 瀏覽器自動播放／麥克風權限限制 | 無聲、無法發言 | 互動解鎖＋權限引導 UI；列入前端驗收（Gate 4） |
| client 嵌入他站（CSP／權限政策差異） | 整合失效 | 函式庫不綁框架；整合指南列入 README；各站 CSP／權限要求文件化 |
| 主控斷線 | 舞台無人管理 | 短暫斷線不移交（重連即恢復）；逾 60 秒自動移交（假設 4）；移交事件全場廣播 |
| 房間代碼外流 | 未授權者進場收聽 | 可關閉代碼或重新開房；代碼不入日誌；進場限流 |

---

## 十、里程碑與 Gate（逐關通過才進下一階段）

### Phase 0 — 前置交付
倉庫根檔（**已達成**：`LICENSE`，2026-10-09 驗證）＋必要文件四件。
**Gate 0**：`gh api repos/JS-PACKAGE/Stage.js/contents/` 含 `README.md／AGENTS.md／CLAUDE.md／PLAN.md／LICENSE`，且 `LICENSE` 仍為 Apache-2.0。

### Phase 1 — 專案骨架＋ws 控制面＋角色狀態機
npm 專案（TS、目標 Node v24）、ws 伺服器、`join`／舉手／上下台／移交協定、狀態機單元測試（Mock 連線）。
**Gate 1**：`npm run typecheck` 通過；`npm test` 覆蓋流程範例 1–4 與不變量案例（雙主控拒絕、觀眾上行拒絕、主控下台保有控制權、兩房互不干擾、關房全員離場）全過。

### Phase 2 — WebRTC 單人上行→觀眾收聽
MediaTransport 以 **werift** 實作、單一發言者上行、觀眾下行單流。
**Gate 2**：雙瀏覽器實測 1 發言者→N 觀眾可聽；`getStats` 確認下行 Opus mono、取樣率與位元率落在 32–128kbps VBR 區間。

### Phase 3 — 伺服器混音＋多人同時發言
N 路混音管線（decode→mix→encode）、不含自己的台上混音、limiter。
**Gate 3**：3 位發言者同時發言，觀眾端收到單一混音流、無爆音；模擬 300 觀眾訂閱下混音端到端延遲 ≤ 300ms（可調整）；同時發言達上限（8）時拒絕行為正確。

### Phase 4 — 完整控制流＋最小前端
舉手核准、上下台、移交、靜音全 UI 化；**完整範例前端**（響應式手機版、主題化、多人列表管理介面）建於 client 函式庫之上。
**Gate 4**：以完整範例前端（含手機版）走完流程範例 1–4；client 函式庫可被外部頁面以 ESM 匯入啟用；麥克風權限拒絕時有明確提示；斷線重連後狀態一致。

### Phase 5 — 安全加固＋文件＋回歸
**Gate 5（交付關）**：①乾淨 clone → install → build → start → 走完流程範例 1–4 ②`npm audit` 無 high ③`AGENTS.md` 安全節對照第六節逐條存在 ④`README.md` 指令逐條可複製執行 ⑤跨網路（不同 NAT 環境）實測收聽成功——**部署後定**（裁示）：交付時先以本機雙瀏覽器實測替代，部署後另補此項。

---

## 十一、已知假設與未定項

1. Node **v24** 為裁示目標；本機實測 v26.10.0（2026-10-09），nvm 未裝 v24；建置以 v24 相容為準，如需 v24 實測以 `nvm install 24` 建立。
2. 上台核准＝**主控核准**（觀眾舉手 → 主控 `stage:approve`；裁示確認 2026-10-09）。
3. 主控亦在台發言（依「一位主控及一到多位發言者發言」）。
4. 台上者下行混音**不含自己**（避免回音）。**主控下台僅停止發言、保有控制權遠端管理**（裁示 2026-10-09），移交由主控自行決定；主控**斷線逾 60 秒**（可調整）才自動移交給台上最早發言者（無則最早觀眾）。
5. 前端＝vanilla TypeScript＋Vite、UI 繁體中文；client 以 **ESM 函式庫**交付（可嵌入其他網站程式）；Web Component 包裝 `<stage-client>`（`/lib/stage-element.js`，見「十二」21）；完整範例前端建於其上（裁示 2026-10-09）。
6. 不發布 npm 套件：倉庫公開供 clone（沿用前作裁示慣例）。
7. 新創數值（限流、延遲目標 300ms、frame 64KB）標「**可調整**」，值入 `config.yaml`；同時發言者 ≤ 8、觀眾 ≤ 300 為裁示定值（見未定項 2）。
8. Opus 編碼參數（mono、VBR 32–128kbps、48kHz）依 R3 為硬性；WebRTC Opus RTP 時鐘亦為 48kHz（RFC 7587），全程無重取樣（v1.7 裁示）。
9. 房間代碼預設 8 碼隨機英數（**可調整**）；主控可關閉代碼要求（改為有連結即可進場）。

### 未定項（待裁示，逐題確認中）
1. **媒體層技術選型**——已裁示（2026-10-09）：**werift 純 TypeScript**（見 3.3）。
2. **規模上限**——已裁示（2026-10-09）：同時發言者 **≤ 8**、觀眾 **≤ 300**（壓測案例以此為目標）。
3. **前端範圍**——已裁示（2026-10-09）：以完整前端為基礎做**範例**；實際應用套用在其他網站程式 → 交付可嵌入 client 函式庫＋完整範例前端（見 R8、假設 5）。
4. **房間與進場模型**——已裁示（2026-10-09）：**多房間**（單一 process 多個舞台、建立／關閉）＋進場**房間代碼**（可關閉）（見 R9、假設 9）。
5. **部署形態**——已裁示（2026-10-09）：**部署後定**，程式先完成、細節另案裁示（**不影響程式實作**）；STUN/TURN 與 TLS 配置值入 `config.yaml`，程式不得寫死。
6. **台上互動細節**——已裁示（2026-10-09）：主控核准上台；**主控下台不自動移交**（保有控制權遠端管理，移交自行決定；主控斷線逾 60 秒才自動移交）；主控可強制靜音／移出發言者（見假設 2、4）。

以上未定項逐題裁示後同步落實至相關章節並升版；未定前依本文件預設值規劃，不阻塞 Phase 0–1。

---

## 十二、實作決策與協定擴充（2026-10-09，實作同步）

以下為實作時補足、未違反上文之決策；協定型別單一真值來源為 `shared/protocol.ts`。

1. **協定擴充**（第四節之外）：S→C `ok {requestId}`（請求成功回覆）、`pong`、`rtc:config {iceServers}`（join／開房後下發，TURN 憑證僅給已進房者，為每人簽發的短期憑證）、`speaking {participantIds}`（伺服器混音端 VAD，集合變動時廣播）、`hello` 增 `limits {controlPerSecond, icePerSecond, handRaiseIntervalMs}`（client 據此節流與舉手冷卻，不再寫死）；C→S `room:create` 增 `roomName?`、`codeRequired?`（假設 9：代碼可關閉）；`join` 增 `resumeToken?`（主控斷線寬限期內回座）；`room:state` 每人帶 `onStage`／`forceMuted`，另有 `audienceCount`、`status`、`limits`，`audience` 全名單與 `code` 僅主控收到，`resumeToken` 僅本人收到。
2. **信令方向**：一人一條 PeerConnection 連伺服器，**一律由 client 發 offer**、伺服器 answer；伺服器收到 `rtc:answer` 回 `bad_request`。上台（`me.onStage` 轉 true）→ client 掛麥克風改 `sendrecv` 重協商 → 伺服器 `stage:joined`；下台反向改 `recvonly`。
3. **主控返回舞台**：主控下台後以 `stage:approve` 指定自己即回台（不需舉手；主控不可舉手）。
4. **強制靜音**：`mic:force-unmute` 只解除主控鎖定，保留本人的自我靜音狀態（不遠端打開他人麥克風）。
5. **上限算法**：「主控以外的人數 ≤ 300」、「主控以外的台上者 ≤ 8」，使觀眾數與發言者數在上下台、移交等所有轉換中恆守上限；每房實際容量＝300＋主控、台上＝8＋主控。主控在台時把控制權移交給台下者會使主控席位變成受上限的發言者席位，台上已滿時回 `stage_full`（先下台再移交）。
6. **進場錯誤**：房間不存在與代碼錯誤一律 `unauthorized`（不洩漏房間是否存在）；代碼不分大小寫、以常數時間比較。
7. **name 轉義**：伺服器儲存並輸出 HTML 轉義後的名稱（`& < > " '`）；client 提供 `decodeName()`，範例前端以 `textContent` 顯示。
8. **限流**：任一限流違規（含 `hand:raise` 10 秒內重複）即以 close code 1008 斷線；client 函式庫在本地先擋舉手冷卻並對送出節流且**保持送出順序**（ICE 不得超前其 offer）。
9. **單序事件佇列**：每房一條 `SerialQueue`，狀態變更全經此佇列；每連線另保證訊息依序處理。信令的傳輸層工作（套用 offer、加入 ICE candidate，可能跨 worker 往返）在房間佇列**之外**依連線順序執行，避免大量同時進場時互相排隊、卡住控制命令；政策檢查（觀眾只能 recvonly）與協商後的效果（登錄 publisher、`stage:joined`）在房間佇列內原子套用，並於協商完成後重新檢查台上狀態。不變量違例 → 關房（fail-closed）；單一 client 的信令錯誤（壞 SDP、過早 ICE）只回該請求 `bad_request`，不影響房間。
10. **明文 ws**：`server.allowInsecure: true` 且 host 為 loopback 才允許；否則必須提供 TLS 憑證，啟動即檢查。
11. **werift 注意**：伺服器 transceiver 於套用 offer **之前**須先設成政策方向，否則 werift 不登錄瀏覽器重協商時新出現的 SSRC（觀眾升發言者後上行被丟棄）；`scripts/werift-loopback.ts` 以「去除 recvonly offer 的 SSRC」模擬瀏覽器並驗證此情境。werift 在 answer 為 recvonly 時仍可能送出 RTP，故上行一律以 publisher 註冊＋政策雙重把關。
12. **踢人與更換代碼**：C→S `participant:kick {targetId}`（主控限定，不可踢自己）把參與者移出房間（台上者等同下台並移除），對方收到 S→C `kicked {roomId}` 後伺服器以 close code 4001 關閉連線，client 不自動重連；`room:rotate-code`（主控限定、需代碼的房間）換發新代碼，舊代碼立即失效、已在房內者不受影響。兩者合用＝封鎖鬧場者（無帳號制度下的「ban」）。
13. **連線品質回報**：有人上行時，伺服器每 `rooms.qualityIntervalMs` 以 S→C `quality {participants}` 把每位上行者的上行掉包（伺服器重排緩衝實際判定遺失的比例，逐區間計算）、下行掉包（對方 RTCP 接收報告的平滑值）與 RTT 送給主控與台上者；觀眾不收，改由 client `getStats()` 的 `lossPercent` 自行顯示。
14. **開房權杖**：`rooms.createToken` 非空時，`room:create` 須帶相同的 `token?`（常數時間比較），否則回 `unauthorized`、不建立房間；防止匿名者占滿 `limits.maxRooms`。空字串維持任何人可開房（本機開發預設）。
15. **停機通知**：伺服器停止（SIGTERM／SIGINT）時對每個房間送 `room:closed {roomId, reason: 'shutdown'}`，再以 close code 1001 優雅關閉連線（最多等 1 秒完成關閉握手，逾時才強制切斷），確保通知送達；client 據此顯示「伺服器維護／重啟」而非一般關房。房間狀態只存在記憶體，重啟後不保留（第〇節範圍外）。
16. **手動音量微調**：C→S `mic:gain {targetId, gainDb}`（主控限定，`|gainDb| ≤ MAX_GAIN_DB`＝20，伺服器取到 0.1 dB）設定某人在混音中的增益，疊加在 `audio.loudness` 自動正規化之後、限幅器之前；新值在下一個上行幀內線性過渡避免爆音。設定隨參與者保存到離開房間為止（上下台不重置），`ParticipantView.gainDb` 對全員可見。
17. **下行省工**（效能決策）：(a) 台上者靜音、斷流或持續全零 PCM 超過 1 秒時，其 mix-minus 就是完整混音，改收共用的完整混音編碼並釋放自己的 encoder，一出聲立即換回（切換時該台上者的下行換一個 encoder 串流）；(b) 全房無聲超過 1 秒（且 `opus.dtx` 開啟）時不再編碼，主機收到空 payload 即按 DTX 處理（時間戳前進、不送包，與 DTX 的差別只在不再送週期性靜音更新幀）；精確全零 PCM 正常消耗 jitter queue，但沒有可減去的 contribution，低於 VAD 門檻的非零音訊仍完整播放；(c) 分送計畫（誰收哪個編碼）只在路由變動時重建；(d) werift 每包把 SRTP 金鑰以 Buffer 交給 node:crypto、每次重新匯入，改由 `src/transport/srtpKeys.ts` 在 cipher 建立時換成 `KeyObject`（輸出逐位元相同，由測試守住；werift 版本固定 0.25.0）。
18. **斷線韌性**（落實第九節「WebRTC 連線獨立存活」）：ws 斷線時伺服器**不關 PeerConnection、不停混音**，席位、台位、舉手順位保留 `rooms.participantGraceMs`（主控 `controllerGraceMs`），`ParticipantView.connected` 對全員顯示 false；`join` 帶 `resumeToken` 回座即清除寬限計時並沿用既有媒體；逾時才移除（台上者等同下台）並關閉 peer。client 以 close code **1000 表示主動離開**（`disconnect()`），非主控者立即移除、不保留席位；其他關閉（`pagehide` 用 4002、網路中斷 1006 等）一律保留。client 端：ws 斷線不拆 PeerConnection，只有身分改變才重建；每 15 秒送 `ping`、35 秒無任何訊息即視為斷線；`pagehide` 主動關閉；WebRTC `disconnected` 持續 3 秒即 ICE restart（werift 以 ufrag 變更辨識遠端 restart），`failed` 時伺服器丟棄該 peer、client 以新 PeerConnection 重發 offer。
19. **連線准入**：`limits.joinTimeoutMs` 內未開房／進房的連線以 1008 關閉；`limits.maxConnectionsPerIp` 限制同一位址同時連線（反向代理後 `server.trustProxy` 改讀 `X-Forwarded-For`）。
20. **程序層錯誤**：`unhandledRejection` 只記 error 不中止（werift 關閉 peer 後的計時器可能漏 rejection，Node 預設會讓整個 process 連同所有房間一起死）；`uncaughtException` 走優雅停機（`room:closed {reason:'shutdown'}`）後以非零碼退出。TLS 憑證檔變更後約 2 秒自動 `setSecureContext`，失敗則沿用舊憑證。
21. **Web Component**：`/lib/stage-element.js` 註冊 `<stage-client room code name url>`（shadow DOM 小工具：狀態、錯誤、啟用音訊、舉手、台上靜音／下台），進入文件即進房、移除即以 1000 離開；client 事件以 `stage-<type>` 派發，`element.client` 暴露底層 `StageClient` 供主控功能；它從穩定檔名 `stage-client.js` 匯入，嵌入頁同時使用兩者時只載入一份。
22. **狀態與 codec 生命週期**：房間不變量以同一個舉手集合檢查所有參與者，避免每次轉換重複掃描整條佇列；未知／重複舉手、旗標與佇列不一致、觀眾在台及多主控皆 fail-closed。移除 publisher 時依 codec 工作順序釋放 encoder 與 decoder，再上台不得沿用先前上行的解碼預測狀態。
23. **client／UI 取消安全**：`disconnect()` 使尚未完成的開房／進房失效，清除連線 promise 後可重用；關房／被踢在派發終止事件前完整清除媒體、mic test、待回覆請求及頁面監聽。ws 遺失 answer 時立即拒絕協商等待，回座後替換 pending offer 而非 rollback，避免首次 offer 的 MID 改變讓既有伺服器 peer 多出 transceiver。下台 snapshot 立即清除麥克風權限失敗旗標，再上台可重試；過期授權失敗不得污染新狀態。Web Component 以掛載 generation 忽略舊操作及事件，操作失敗解除 disabled，音訊解鎖成功隱藏按鈕；完整前端同步停止不再適用的 mic test、清除舊權限提示，最小嵌入頁在終止及重連時停用操作。

24. **慢速 WebSocket 讀取端防護**：`limits.maxSendBufferBytes` 限制每條 ws 已排隊資料加上下一則 JSON 的 UTF-8 位元組；超限立即 terminate，避免關閉握手卡在待送佇列。保留既有非主動離開的席位／媒體寬限與回座流程，其他連線不受影響；Prometheus `stage_ws_backpressure_disconnects_total` 計數。範例為 1 MiB，舊設定省略時以 `maxFrameBytes × 16` 相容。

25. **本機收聽控制**：client 提供 `playbackVolume`／`playbackMuted` getters 與 `setPlaybackVolume(0–1)`／`setPlaybackMuted(boolean)`，只操作本機 audio，與麥克風／伺服器混音增益分離、不發控制訊息；音訊元件重用讓偏好保留至回座與同一 client 重用。自訂 audio 的既有音量／靜音不覆寫，非法音量同步拒絕；範例前端附繁中滑桿與獨立切換鈕。

26. **media worker RPC 期限**：`rtc.mediaWorkerTimeoutMs`（預設／舊設定 30000 ms）為 SDP、ICE、統計與關閉的期限。逾時拒絕該 worker 的所有 pending，清除期限、停止舊 worker、重生並通知受影響 peer；舊 worker 回覆／候選／上行等事件以 worker 身分隔離。成功、失敗、postMessage 例外與 exit 都清掉期限及 pending，未送出的協商不占 peer；停機拒絕新工作，close 可重複且被同一期限約束，不重生。其他 worker 不受影響，主執行緒模式不套用；正常協商需預留足夠時間。

27. **靜態資源預壓縮**：根建置以 Node 內建 zlib 產生較小的 Brotli／gzip sidecar（原子替換、不追 symlink、不重複壓縮）；HTTP 依 Accept-Encoding 權重、wildcard、identity 與 q=0 協商，版本獨立 ETag、Vary、HEAD／304 及原 MIME／CORS 一致。舊於原檔或 symlink 的 sidecar 不使用；沒有可接受版本時回 406，其餘退回原檔，不在請求期間壓縮。mtime 比較用 stat 原始精度，避免 Date 的毫秒四捨五入誤判新副本。開發模式不變，部署原檔與 sidecar 一起更新。

28. **client 統計生命週期**：音訊 RTP 差量只採有效、遞增時間戳及可用計數器；計數器重置先重新建立基準，不產生 NaN／負 jitter buffer 延遲。舊 peer 與被較新完成結果取代的輪詢回空統計，不污染新連線；歷史只保留當前 RTP ID，避免同一 PeerConnection 多次換 SSRC 後無限累積。單位與現有 getStats API 維持，當前 peer 的實際錯誤仍向呼叫端拒絕。

29. **監控收集去重**：每個 HTTP server 僅共用同時進行的 metrics promise，授權檢查仍逐請求先執行，成功／拒絕後立即清除。不跨伺服器共用、不設 TTL，新的 scrape 重新收集；同步 throw 也轉成既有 generic 500。重疊請求不再各自掃描房間與發出 worker counters RPC。

30. **輸入工作上限**：每條 ws 以可清空的明確佇列取代逐訊息 promise closure，等待工作受 maxPendingMessages／maxPendingBytes 雙上限約束，單一執行中工作另受 maxFrameBytes 限制。超限立即 terminate 並清除等待 payload，所有關閉均停止接收／執行新工作，實際 socket close 時先 detach 既有綁定，執行中工作完成後再清理遲到綁定（見第 75 點）；正常 FIFO 不變，其他連線不受影響。觀測 inbound queue disconnect counter，舊設定採有界預設。

31. **停機准入與 readiness**：server.close 開始時同步標記 draining、停止所有 session 輸入工作；新 upgrade 回 503，不再接受排空期間新增連線／控制操作。新增 GET／HEAD /readyz（正常 200、排空 503、no-store），/healthz 繼續表示程序存活；不是 WebRTC 健康探針。close 共用同一 promise，房間通知／關閉握手維持原順序，避免重複停機。

32. **單調間隔計時**：伺服器 token bucket 與 client 請求排程、舉手冷卻、keepalive 只使用 performance.now 的經過時間；系統牆鐘校正不得造成額外配額、誤斷線或長時間延後送出。房間事件與日誌的絕對時間不改。注入 clock／timer 回歸測試覆蓋正負一小時校正及真正的靜默逾時。

33. **client 延遲送出清理**：每個 pending 同時保存 ACK 期限與 pacing send timer，所有 settle／斷線路徑統一清除兩者，避免已取消請求的 payload 被未來送出 slot 保留。逾時透過 finish 清理；同步 stringify／ws.send 失敗拒絕該請求，不從 timer 拋出例外。

34. **client 可調期限**：StageClientOptions.requestTimeoutMs 可設定 hello／ACK／SDP answer 期限（1–300000 整數毫秒，省略維持 15000），建構時先驗證。ACK 仍預留 pacing 排程時間，answer 期限改從 offer 實際送出開始，並綁定 peer／answer waiter 身分，過期 peer 不得送出排隊 offer 或改動新期限。不改 keepalive／重連／server watchdog，也不宣稱取消已送出的伺服器操作。

35. **遞迴日誌遮蔽**：敏感欄位名稱防護延伸到巢狀物件與陣列，透過 own descriptor 複製不修改來源；不呼叫 getter／toJSON／Proxy traps，循環、深度與遞迴複製／輸出欄位數有界（不是 Object.keys 列舉或字串位元組的固定成本保證）。Error 資料欄位／cause、Date、bigint 保留可用診斷，accessor 明確標記。這不是任意字串秘密偵測，原本不得傳入憑證／原始 SDP 的規則不變。

36. **可取消麥克風預覽**：startMicTest 可選 AbortSignal；預先取消不要求權限，等待中取消立即拒絕且停止遲到串流，啟動後取消只停止該 preview。原生 permission prompt 不能自動關閉；signal reason 保留，正常失敗保留原錯誤，stop 冪等並清除 listener，不觸及房間 microphone 或其他 preview。

---

開始執行。

37. **300 位觀眾控制面煙霧測試（2026-10-12）：** 新增 local-only `bench-control-plane.ts`，真實 WebSocket 搭配 MockMediaTransport、不送音訊，驗證 300 位進房／SDP、滿房拒絕、10 位原席位與 peer 保留、301 位 shutdown 通知及 1001 關閉碼；可用的 overflow 指標須為零。30 秒硬期限、連線／伺服器清理，輸出同程序 ACK／CPU／RSS／event-loop 數據。初版主線與改善分支各三次均通過；join p95 範圍主線 1.93–3.24 ms、改善分支 1.99–2.46 ms，RSS 高點約 96–100 MiB。因本機共用程序、presence 視窗與排程變異，不宣稱吞吐提升或實際音訊容量。

38. **舉手突發的完整快照合併（2026-10-12）：** 300 位同時舉手的本機控制面探測揭露反覆傳送成長中 hands 陣列：原始主線耗盡約 2 GiB Node heap，已有輸出保護的分支則觸發 301 次 backpressure 斷線。不得提高上限掩蓋。現在保留逐筆 hand 事件與發起者 state-before-ACK，其他完整快照以每房單一 0ms 計時器合併；較慢 presence timer 被取代，後續 hand 不重置期限，即時台位變更／關房取消待送；觀眾正常離開或寬限期到期的純 hand:withdraw 同樣合併，避免另一條群體離場突發路徑。首輪修正探測 300/300 ACK、0 斷線，收到的資料約 385.8 MB → 32.0 MB（失敗舊版未完成所有工作，並非等量完成吞吐比較）；RSS 結束取樣約 618 → 192 MB。以 ordered events／最終狀態／混合收回／回座／關房測試及 `bench-control-plane.ts --hands` 驗證，無實際音訊容量宣稱。

39. **Web Component 請求中的按鈕狀態（2026-10-12）：** 原本 onclick 暫設 disabled，但每秒 cooldown render／任何 state render 都會提早重新啟用按鈕，慢速 ACK 可造成重複提交。以每按鈕 pending set 守護，render 合併 pending 與冷卻／force-muted 政策，操作期間 aria-busy=true；同步 throw 與非同步拒絕都收斂到錯誤呈現與清理。generation 隔離舊房间操作，leave 清空 pending。6 個原生最小 DOM fake 測試涵蓋重繪、重入、失敗、政策、代際隔離及獨立按鈕；不等同瀏覽器版面／鍵盤／真實麥克風驗證。

40. **媒體工作佇列的 PeerConnection 代際隔離（2026-10-12）：** 重現舊 getUserMedia 未回覆時 disconnect／再加入的新 peer 無法協商，因 mediaTask 尾端仍連到舊 permission promise。destroyMedia 取消該代權限等待並建立新佇列；helper 停止遲到串流，setInputDevice 在排隊時捕捉代際，過期工作拒絕而非改動新偏好。保留同一 peer 裝置切換序列與既有跨 await 身分檢查。9 個 fake-media 測試涵蓋新 peer 不等待舊授權、新麥克風不被舊串流清理誤停、遲到拒絕、排隊／執行中裝置切換及 replaceTrack continuation（含舊 peer 遲到錯誤不污染新連線）；不宣稱已解除瀏覽器原生 permission prompt，也不等同真實音訊端到端驗證。

41. **同一 peer 下台取消擷取等待（2026-10-12）：** 重現未回覆的 getUserMedia 阻塞同一 peer 下台後 recvonly 協商。房間擷取新增單一 permission token，連到 peer 代際，並在下台中止；完成／失敗／取消清除連結 listener。captureRevision 防止授權成功與安裝間的快速下台／再上台競態採用舊串流，正常權限拒絕仍走 micerror，獨立 preview 不受影響。同 peer 工作仍序列化；不取消已進瀏覽器的 replaceTrack。增加 7 個 fake-media 測試，包含 listener 清理、快速往返、裝置切換、preview 隔離與 acquisition→installation 競態，以及拒絕先排入 microtask 後才下台／再上台的舊錯誤。

42. **靜態掛載 canonical containment（2026-10-12）：** synthetic 測試重現 lexical path 檢查仍會透過來源檔／父目錄 symlink 送出 mount 之外內容。每請求解析實際 root/source 路徑並驗證目錄邊界，選中的 sidecar 亦須在 canonical root 內；讀取解析後的檔案路徑。保留 mount 內 symlink、部署 release-root symlink、啟動後建立輸出目錄與 root 切換。測試含相似前綴 sibling、外部 directory→內部來源回鏈但外部 sidecar、dangling/cycle、GET/HEAD。增加 metadata I/O，無加速宣稱；不宣稱防禦惡意本機 writer 在檢查與開檔間替換檔案的 TOCTOU。

43. **嵌入元件本機收聽靜音（2026-10-12）：** `<stage-client>` 增加「靜音收聽／恢復收聽」原生按鈕（aria-pressed）與 playback-muted 布林 attribute／playbackMuted property，清楚區別台上麥克風靜音。只改本機 audio，不傳控制面訊息、不重新進房；偏好在新 client 開始 connect 前套用，保留於 rejoin／重掛載／信令 reconnect，未進房隱藏操作。增加 4 個 DOM fake 測試（含實際元件 lifecycle callbacks，SDK connect/join 以 stub 取代）；不宣稱瀏覽器鍵盤／版面／實際音訊 QA。

44. **自訂嵌入標籤 constructor 唯一性（2026-10-12）：** README 原先承諾 default/custom tag 可共存，但 defineStageElement 重用同一 constructor，違反 CustomElementRegistry.define 的 constructor 唯一性規則（WHATWG HTML Custom elements：https://html.spec.whatwg.org/multipage/custom-elements.html）。以遵循該規則的 registry fake 重現 NotSupportedError。每個 custom alias 改用獨立 StageElement 子類別；預設 stage-client 保留原 export constructor。同名 no-op／第三方既有定義不覆寫／原生無效名稱錯誤不吞掉；3 個測試涵蓋 default-first、custom-first、多 alias、instanceof／繼承 attributes 與獨立狀態。實際瀏覽器 registry QA 仍受環境限制未執行。

45. **SDK 真實 WebSocket 控制面整合（2026-10-12）：** 補足既有 SDK fake socket 與容量工具自訂 participant 之間的缺口：實際 StageClient 連到獨立子程序的 createStageServer／StageHub，伺服器使用 MockMediaTransport，瀏覽器媒體 fake。涵蓋建立／加入、個人化快照、舉手／核准、個人／主控靜音及禁止解除錯誤、下台、強制斷線後自動同席位／同 client PC／同 server peer identity 恢復、收聽偏好保留、kick／shutdown 清除 session 與 reconnect timer。失敗清理具有 child kill deadline；IPC／狀態等待有界。不改生產碼，不宣稱真實 ICE／麥克風／音訊 E2E 或效能增益。

46. **嵌入元件按需冷卻排程（2026-10-12）：** probe 以控制時間量到無狀態變更的 mounted widget 每模擬分鐘仍觸發 60 次 render，關房也不停止原 interval。改為只在觀眾未舉手且可見倒數尚未結束時保留一個 timeout；對齊下一個顯示秒數邊界，重繪不延後已排程 wake，失去倒數需求／卸載立即取消。6 個測試涵蓋遲到 wake 不重播舊 tick、小數毫秒期限向上取整避免過早重繪、idle 60→0 callbacks、1.5 秒冷卻只做 2 次必要 tick、raise／stage／controller／closed／disconnect 清除與 pending action 不提前解鎖。這是 controlled-clock 工作量比較，不宣稱真實瀏覽器 CPU／電量或頁面延遲改善；既有 DOM fake 範圍不變。

47. **斷線即取消待授權麥克風預覽（2026-10-12）：** scratch regression 重現 startMicTest 無 signal 時，disconnect 後 promise 仍等原生權限回應，原測試先 grant 才 assert 而未覆蓋。每個擷取請求使用自己的 AbortController，加入 pending set；disconnect 同步 abort／clear，完成或失敗 finally 移除 caller listener 與 set entry。保留獨立 caller signal 及 active preview stop，晚到 stream 停止／reject 接住；revision 檢查補 meter 建立與 micready 回呼重入斷線。6 個新測試涵蓋多 pending、立即 reuse、外部 signal ownership／cleanup、兩種重入及同步 getUserMedia throw。僅 fake browser media，不提出真麥克風權限、不宣稱能關閉原生提示。

48. **舉手冷卻的身分生命週期（2026-10-12）：** controlled-clock probe 重現 raise 後 explicit disconnect 仍保留 10000ms 冷卻，重用 SDK 進新房間會無故無法舉手。disconnect 與新 participantId 快照將 lastHandAt 重置為 -Infinity；同身分快照／自動同席恢復不重置。增加 2 個 clock regressions，並擴充真實 WebSocket SDK 整合測試：同席恢復保留起點、明確離房再 join 得新身分且立即 raise 成功。保持 monotonic clock 與伺服器限流不變，無媒體層修改。

49. **room:state 回呼重入取消保護（2026-10-12）：** read-only probe 與 4 個 failing regressions 重現 status／state listener 同步 disconnect 後舊 handler 仍建立未關閉 PC，或重入新快照後舊 handler 再次建立 PC 並關閉新 peer。setStatus 與 state event 各返回後比對目前 snapshot identity；已被 disconnect 清除或新快照取代即停止。review 發現舊 peer A→外層 B→重入 B 會跳過必要替換，另記錄 PC 實際綁定的 participantId，不以暫時 snapshot 推論 ownership；destroyMedia 清除。6 個測試涵蓋兩個事件位置的取消／替換及同新身分重入，驗證不發 stale state、不建立舊 peer／permission、不停止新 mic。維持同步事件順序及正常同席恢復；client-only，browser media 使用 fake。

50. **自動重連 session ownership（2026-10-12）：** 4 個獨立 probe 與 9 個 failing regressions 重現 reconnecting listener 換房後舊 timer 重複 join 新房、舊 hello 失敗關閉新 socket，以及 resume error listener 換房後 stale catch 再報錯／disconnect。setStatus 前捕捉 session／revision；排程前、timer entry、connect await 後、catch report 前後確認 ownership，timer handle 也需相符；已排程不再重複建立。review 補正成功 public join/createRoom 替換 session 時取消舊 timer，owned callback 先清 slot 再判 session，避免殘留 handle 阻止新重連。15 個 tests 涵蓋新 session 在舊期限前／後再斷線、disconnect-only、立即 public join、三種 terminal code 在兩個 error callback 時機換房、延遲 hello failure，另保留正常 resume／退避／目前 terminal cleanup。client-only，無傳輸／混音層變更。

51. **SDK 文件按使用情境整理（2026-10-12）：** 將連續功能批次累積在 README 尾端／測試章節之後的 lifecycle、冷卻、widget、preview 說明移回相應 API 章節，增加快速導覽與房間／事件／連線／統計標題。保留每一原始內容 block 與既有 caveat；逾時文字明確標示可配置的預設值，統計欄位 codec 說明改為實際公開名稱 mimeType。不改生產碼；檢查章節連結及來源 API 對照。

52. **連線品質 polling 失敗恢復（2026-10-12）：** read-only probe 重現任一 getStats reject 使 Promise.all 失敗且不再安排下一輪。將 reschedule 移至 finally，並以 qualityInFlight 保持每房一輪；allSettled（含 sync throw 包裝）略過個別失敗，保留健康報告，整輪失敗仍重試。publisher set 改為 id→generation token map，防止下台再發布的舊結果播送或回填新 baseline。9 個 tests 含失敗後沿用上次成功 counter baseline、部分／全 async／sync failure、關房／最後 publisher 離開期間 pending、新 publisher 不重疊收集、同 id 再發布與停用設定；其中 5 個 before-fix 失敗。只改 hub 控制面，不改 transport／mixer。

53. **失敗／未進房連線的資源清理（2026-10-12）：** 3 個 failing regressions 重現 WebSocket constructor throw、hello timeout、未 join socket close 仍由 window listener 保留 client（8 次失敗留下 8 個 listener）。socketLost 在派發狀態前移除舊 listener；connect promise finally 僅清理仍屬於自己的失敗嘗試，補沒有 close event 的 constructor failure。另 2 個 failing regressions 重現自建 audio 節點殘留；無 session 才移除 owned audio，自動同席 resume 保留，reuse 掛回同一元素／偏好，custom audio 不移除。9 個 tests 含 reconnect callback 立即替換、舊 close 在新 CONNECTING 期間遲到、新連線 pagehide 仍作用、audio ownership／reuse；不宣稱實際瀏覽器 GC／heap 數值改善。

54. **完整範例前端個人操作 pending ownership（2026-10-12）：** production-function probe 重現返回舞台 promise 未完成時，250ms updateCooldown 將原按鈕解鎖，第二次點擊重複送出；既有 §39 只修嵌入元件。個人 mute／stage／hand 操作以 logical key 追蹤 token，跨快照重建 DOM 保留 disabled／aria-busy；同 roomId＋participantId 保留，landing／身分切換增加 generation 並清除 pending，舊 settlement／舊 DOM callback 不影響新房。完成時重新套用 reconnect／force-mute／cooldown 政策。8 個 Node VM 測試直接取 production handlers／renderRoom，以 DOM／SDK doubles 驗證 timer／重建／拒絕重試／換房／政策；未執行實際 browser click／accessibility QA，不擴及主控管理列或 slider。

55. **完整範例倒數按需排程（2026-10-12）：** production scheduler 的 controlled-clock probe 量到房內無倒數時每分鐘 240 次 cooldown 更新（另 30 次 stats）。移除固定 250ms interval，只有 connected 舉手按鈕的剩餘冷卻才安排單一 timeout，向上取整至下個顯示秒數邊界，不因重繪延後已排定 wake；landing／舉手後／上台取消，late wake 直接重算。5 個新增 VM 測試涵蓋 landing／重入與 controller 轉換、idle cooldown 240→0、stats 30 不變、1500.75ms 倒數 2 callbacks、小數／延遲／角色切換與 pending ACK 保護。不宣稱實際 browser CPU／電量或 latency 增益。

56. **完整範例主控操作 pending ownership（2026-10-12）：** read-only production renderRoom／personRow probe 重現 8 種管理按鈕在 snapshot 重建後重複送出；Room 模型確認 rotateCode 可連續有效換碼，舊成功通知也會寫進新房。沿用 roomButton：核准／婉拒／移除以 stage:target 共用、強制靜音切換共用、kick 依 target、transfer 全房、rotate／close 各一 key；generation 保護換碼後 success notice。12 個新 VM tests 使用實際 panelList／personRow，涵蓋 9 種按鈕、對向狀態、跨目標 transfer 與舊房成功隔離。保留確認對話框與伺服器政策；slider 不變。僅 DOM／SDK doubles，無實際 browser 或控制生產房間。

57. **HTTP 停機排空期限（2026-10-12）：** 單一本機 paused 靜態下載／deferred metrics probe 重現最後 server.close callback 無限等待；既有 1 秒契約僅 WS handshake，並非 HTTP／總停機期限。新增 server.httpShutdownDrainMs（legacy default 1000，整數 0–60000），保持 hub／WS／readiness 原順序，最後 HTTP listener close 後才啟動 timer，到期 closeAllConnections，finally 清 timer。4 個 real HTTP regressions 覆蓋 deferred metrics 晚到成功／失敗、正常完整回應、8MiB paused download、primary hub error 與 0ms；另測 config default／bounds。不取消底層工作、不宣稱 hub 或整體 shutdown 有界；無媒體層變更。

58. **完整範例統計顯示 ownership（2026-10-12）：** production refreshConnectionLine＋fake RTC probe 重現新版 40ms RTT 顯示被較舊 SDK empty 結果清空，離房／重入亦會被舊 peer 完成覆寫。僅在 sample 更新前比對 room generation 與最新 request sequence，landing 不啟動收集；保留每 2 秒與新請求不等舊 pending 的行為。5 個 VM regressions 涵蓋同身分經 landing 重入、同房 snapshot、empty 最新／舊結果、rejection recovery、舊 pending 不阻塞與 retired tick。SDK §28 的 supersession／result ownership 完全不變；不做 synthetic single-flight 數字的效能宣稱。

59. **完整範例麥克風設定操作 ownership（2026-10-12）：** production VM probe 重現 active preview 換裝置時 test button 仍可點，兩個 pending preview 都賦值 micTest，Stop 只能停止最後一個。toggle／input onchange 共用 testingBusy 入口 guard，開始即 syncMeter；landing 增加設定 generation、停止 active preview／清 busy，await 後舊 result 自行 stop，舊 finally／failure 不解鎖或覆寫新操作。10 個 fake SDK／DOM tests 涵蓋互斥、兩種晚到順序、拒絕重試、舊 device-change completion、on-stage 政策；其中 2 個 before-fix 失敗。SDK 獨立 preview 語意不變，未要求真實麥克風權限或執行 browser QA。

60. **完整範例全模組 lifecycle 測試（2026-10-12）：** 原 VM regressions 只取 production function fragments，不能驗證頂層 event registration 與 status→landing→同身分 rejoin 串接。新增 bounded fake DOM／SDK fixture，assert 並移除唯一 3 個 imports 後 strict-evaluate 全 main.ts，保留全部 initializer／subscription／landing；不暴露內部 helper。3 個場景經真實表單／按鈕 handler 與符合 SDK 的 snapshot→status→state、disconnect→terminal 順序，驗證 pending preview reject／已 fulfill 但 UI continuation 晚到、stats／cooldown／ACK 交互、reparent／detach、50ms preview→stage→offstage meter、quality／speaking badge 和 shutdown／kick。cleanup settle 所有 deferred／停止 preview 並清 fake timers，advance 最多 1000 callbacks；不修改 production／dependencies，不宣稱 native browser 或 real SDK interoperability。

61. **根目錄操作文件導覽與事實校正（2026-10-12）：** 將誤置授權章節下的輸入佇列／日誌／控制面煙霧測試／靜態邊界段落移回設定、驗證與靜態資源章節，保留全部行為與驗證限制，授權維持最後。增加導覽與操作小標題，依 config parser 補齊五個相容 fallback 與設定表，修正範本註解、開發 TS 與建置 start 區別、frame size 1009／rate limit 1008 說明；只改文件，不改執行碼或設定值。

62. **逾時重連不等待舊 close handshake（2026-10-12）：** actual SDK＋本機 ws probe 重現 hello 不回覆與 resume ACK 不回覆後 close handshake 卡住，40ms 請求期限後仍停在第二次連線，直到遠端恢復讀取才嘗試第三次。沿用 socketLost 的 ownership／session 清理，先放棄 failed socket 再 best-effort close；hello timeout 在 callback 前解除舊 connecting promise，自動回座捕捉實際嘗試的 socket，避免舊 catch 關閉替代連線。4 個 controlled-clock regressions 守退避、晚到事件、同步 callback reuse 與 close throw；2 個 real localhost ws tests 暫停遠端讀取，驗證舊 socket 仍 CLOSING 時第三次已回座，並在 finally 終止所有 transport／清理 timer。測試期限採 250ms，5 秒場景上限；ACK-only session 不代表實際媒體整合。保持終止錯誤、退避、取消與媒體保留語意；不宣稱底層 socket 立即釋放，不修改 transport／mixer。

63. **disconnect callback 重入前完成資源清理（2026-10-12）：** asynchronous-close probe 重現 disconnected listener 立即 connect，舊 disconnect 的尾端隨後移除新 pagehide listener 與 owned audio；replacement hello 成功但 pagehide 無作用。將 socket ownership 先清空、所有本機清理置於 status 派發前，最後 best-effort close 舊 socket；同步／遲到 onclose 不可重新進入舊 cleanup，close throw 不阻止終止狀態。5 個 public-callback regressions 覆蓋 owned／custom audio、晚到 close、立即 connect／join、同步／非同步／throwing close 與再次正常清理；最初兩個回歸在修正前失敗。不改媒體 transport／mixer，不宣稱原生 browser 驗證。

64. **可選的 SDK 呼叫端控制 backlog 上限（2026-10-12）：** bounded fake-clock probe 共 1000 次 public setGain：600 次 burst 保留 600 pending／1200 request timers，250ms ACK 設定下最後送出仍在 59900ms；另 400 次以 20/s 產生、10/s 排空後累積 200 unsent。這是既有 pacing 契約，不是 timeout cleanup bug。新增 maxPendingControlRequests 正安全整數選項，省略保持 unlimited；只計 public controls 的 queued＋unacked，超限本機 queue_full，先於 UUID／timer／pacing admission，raiseHand／createRoom 副作用也先 guard。finish 統一釋放 counter。否決 all-request cap：未 ACK join 占滿後拒絕已 setLocalDescription 的 offer，可能留下 orphan ICE；因此內部 RTC 與 automatic resume 明確豁免，但保留同 scheduler／順序。18 個 deterministic regressions 涵蓋所有 settlement、pre-hello concurrent create／join、既有 session／created／cooldown 保留與 cap=1 的 signaling／resume 豁免；1000 次 burst 在 omitted 時保留 1000 entries／2000 request timers，cap=3 時為 3／6 並拒絕 997 次。不宣稱總記憶體、payload byte 或真實效能上限，不改 server config／wire ErrorCode。

65. **控制容量的真實信令整合驗證（2026-10-12）：** 將既有 actual SDK＋本機 real WebSocket／MockMediaTransport 完整流程參數化為 omitted 與 maxPendingControlRequests=1，保留原預設 coverage。cap=1 的 child fixture 明確 gate 初次 guest join ACK，但不阻塞 server 工作佇列；先確認 SDK remoteDescription／server peer 與 pendingControlRequests=1，再經 IPC release ACK，避免只靠 incidental ordering。其後在 raise pending 時立即 withdraw 必須本機 queue_full，原舉手與後續 state-before-ACK 媒體協商／管理操作／same-peer resume／reuse／kick／shutdown 仍通過，終止後 control counter 為零且無額外 error event。僅新增驗證，browser media 仍 fake，不宣稱真 ICE／麥克風音訊。

66. **重疊 createRoom 的結果 ownership（2026-10-12）：** unchanged real localhost SDK/server 重現 created／state listener 立即再開房，使第二次 this.created=null 清掉第一次已收到的結果；第一個 internal、第二個 already_joined，但 server 為 live controller／SDK session=null，斷線不回座。改為每次 request 前記錄 created identity，ACK 後要求 fresh identity，不清共享結果；保留 server rejection、revision cancellation 與無新 created 時 internal。8 個 deterministic tests 守兩種 callback reentry／concurrent creates／error-ACK ordering／stale result／disconnect-reuse／cap=1，其中 3 個 baseline 失敗；2 個 native WS baseline-failing scenarios 修正後繼續整段 lifecycle，並新增 host 斷線後的 seat／browser peer／server MockPeer identity assertions；更新 cap regression 的舊 reset-write 假設。無新鎖、排隊策略或 wire 變更。

67. **滿台時的主控到期自動接任（2026-10-12）：** deterministic／native timer probe 重現 8 位 speaker 全在 disconnected grace、只剩 connected audience 可接任時，Room.transfer 將即將移除的舊主控暫時計為第 9 位 speaker，stage_full 被 timer catch 視為內部錯誤而關房。只在 on-stage departing／off-stage successor／speaker cap 已滿的 expiry 分支，先用既有 leaveStage 釋放舊主控舞台狀態，再 transfer＋remove，於同 room queue 一次 apply events／snapshot。5 個 deterministic tests 覆蓋原本失敗的滿台 audience 接任、manual rejection、7 人邊界、connected speaker 優先、無 successor 關房；驗證單次 snapshot／ordered events、8 個同一 peer／grace timer、old media 清理與新 controller 私有資料／權限。保留 manual transfer guard、正常 successor 選序、其他 peer／grace timer、不自動開接任者麥克風；不修改 model invariant 或 transport／mixer。

68. **主控接任依事件順序而非牆上時鐘（2026-10-12）：** model 與實際 hub grace-expiry probe 重現時鐘回撥後，較晚加入的觀眾／較晚上台的發言者反而優先接任。既有 participants Map 與 speakers Set 已記錄加入／本次上台的 insertion order，改為回傳第一位 eligible connected speaker，否則第一位 connected audience；不新增序號，不改公開 joinedAt 或內部 stageSince 時戳。resume／角色移交保留順序，下台再核准與移除再加入重新排尾；保留 speaker 優先、controller 排除、滿台與無 successor 行為。12 個 regressions（baseline 9 fail／3 pass）涵蓋 rollback／同時戳／斷線回座／reentry／transfer 與 hub 到期的實際 transfer event，不宣稱效能或真媒體驗證。

69. **遲到 offer failure 的清理 ownership（2026-10-12）：** gated MockMediaTransport 重現舊 socket 的 negotiate 尚未完成時，同席 resume 的新 socket 已成功協商；舊 promise reject 後 hub catch 仍 unpublish／closePeer，刪除新 peer、subscriber 與 publisher。以 Participant 為 WeakMap key，通過 queued policy check 才替換 latest-offer token；catch 只清理仍存在且 object／token 相同的席位。單純 detach 或 resume 未發新 offer 保留既有 failed-peer 清理；新版 offer 即使仍 pending、已失敗或其 socket 再 detach，舊 callback 都不重新取得 ownership。11 個 bounded MockMedia regressions（baseline 4 fail／7 pass）守 retained／recreated peer、新 offer pending／failure、detach-only／resume-without-offer、policy rejection、removed seat／closed room 與 old success。WeakMap 不保留 Session／socket／promise，removed participant 不需額外 map 清理；不改底層 WebRTC 工作的取消／串行語意或 transport／mixer。

70. **範例裝置列舉的最新請求 ownership（2026-10-12）：** whole-module VM probe 重現慢速初始 listAudioDevices 回覆覆蓋較新的 micready 清單，也可移除已成功選取的 deviceId 選項而 SDK 未切換裝置。refreshDevices 在 await 前遞增／捕捉 sequence，回覆後先檢查再更新兩個 select；selectedInput／selectedOutput 維持在 await 後讀取，不回填舊選擇。最新失敗保留現有顯示、較舊成功不再覆蓋，後續新成功仍恢復。7 個 whole-module regressions（baseline 3 fail／4 pass）經實際 init／micready／devicechange wiring 驗證雙清單、選擇保留、失敗恢復與 default／empty／label fallback。只改 sample UI，不改 SDK 列舉、權限或 polling 語意；whole-module fake DOM／SDK coverage 不宣稱 native select 顯示、實際瀏覽器或音訊驗證。

71. **嵌入元件的宣告式收聽音量（2026-10-12）：** 新增 playback-volume attribute／playbackVolume property，沿用 SDK 0–1 範圍與預設 1；嵌入者不必等待 .client 建立即可設定初始音量。有效 property 反映 attribute，invalid property RangeError 且不改設定；missing／empty／invalid attribute 採預設 1。建立 SDK 後、connect 前套用，runtime attribute callback 只改 local audio、不 rejoin／控制麥克風；和 playback-muted 獨立，remove/remount／room change 保留元素偏好。8 個新增 widget tests 加 alias assertions 守 attribute/property parsing、runtime types、反映、mute/mic 獨立、connect pending／reconnecting、room change／remount 與 retired connect；27 個 widget tests 通過。不增加 UI 或改 SDK／wire；原生 browser 音訊與自動播放限制仍適用。

72. **範例發言標示依索引／差量更新（2026-10-12）：** cap-compliant whole-module fixture（controller＋8 speakers＋292 audience）量到 100 次交替 speaking events 在 20 hands／321 rows 時掃描 100 次並 toggle 32100 次，全體 292 hands／593 rows 時 toggle 59300 次，只有 199 次 class 值變化。每次 renderRoom 建立 participantId→rows 索引並從 SDK speaking 初始化、landing 清除；speaking event 僅處理前後 set 差集，保留同人多列，quality 路徑不變。相同 workload 降至 0 次全列查詢／199 次 toggle，重複不變 set 為 0 toggle；8 個 whole-module tests 守每步 class、duplicate／unknown IDs、多列、SDK render seed／mutable set isolation、departures／landing／rejoin 舊列隔離、quality badges 與 row／slider identity；數字是受控 fake DOM 操作次數，不是 browser CPU／latency／native focus 或媒體效能量測。

73. **嵌入元件的斷線／停機提示（2026-10-12）：** actual StageClient receive／disconnect＋StageElement subscriptions 的 fake-DOM probe 確認 ordinary closed／kicked 提示原本保留正常，但 public .client.disconnect 後仍顯示舊 live 房間文字，shutdown 也未依第 15 項區別維護。current-client status=disconnected 時先更新未連線文字，再轉派 stage-status；SDK 隨後的 closed／kicked 仍覆蓋為終止提示，closed reason=shutdown 使用維護／重啟文案。保留 render 在 current client 無 snapshot 時不覆蓋提示，以及 generation／client guard，不新增 UI 狀態機；文件釐清 .client 是實例存取器、不能用非 null 判定已進房。9 個新增 actual SDK／fake DOM tests（baseline 5 fail）守 explicit disconnect、reconnect／live、ordinary closed／kicked／shutdown、原 detail 轉派、room change／remount、retired events 與 stage-status reentrant replacement；不宣稱真實 browser／音訊驗證。

74. **有界 seeded 房間狀態屬性測試（2026-10-12）：** read-only 6000-action 探查未發現新 production defect，提交 test-only sparse success ledger 而非複製 Room 全套 validation branches。12 seeds×500 actions、17 operations、caps 2/8 與 8/19（最多 20 participants），以獨立 entry ordinals／角色推導／FIFO hand order 比對 public/shared/personal snapshots 與 successor；每次 StageError 以保留 Map／Set 順序的完整 state clone 比對拒絕原子性，fixed boundary prefix 守容量／權限／forced mute，failure 附 seed／action trace。每 seed 要求有意義的成功操作／錯誤類別與三種 clock directions 覆蓋，不鎖定偶然 aggregate 數字；mutation probes 僅在外部驗證，不修改或注入已提交 production／並行測試。6 個隔離 subprocess mutants（timestamp succession、audience code leak、錯誤 recipient token、拒絕前 mutation、hand FIFO reversal、gain no-op）皆由最終測試的 12 seeds 偵測到，無 survivor。

75. **socket 關閉與未完成信令分離（2026-10-12）：** 真實本機 WebSocket＋MockMediaTransport 重現已建立的 controller／speaker 在 offer 卡住後斷線，舊綁定仍 connected，使同 token 的重連誤入新觀眾席。close handler 先停止等待工作並立即 detach 既有綁定，既有房間佇列維持 disconnect／resume 順序；活躍工作 settle 後再 idempotent detach，涵蓋已接受但尚未取得房間佇列的 join。兩次清理獨立處理錯誤，前次失敗不略過後次。Hub 原有 session identity guard 防止舊 cleanup 移除替換連線，latest-offer token 防止舊 failure 清掉新媒體。寬限計時／主控接替可在底層 offer 未完成時進行；不取消已開始工作，不改 close code 的主動離開語意。測試包括原 controller／speaker 身分與 peer 回座、舊成功／失敗、新綁定隔離、正常離開、實際 queued join 與明確標示的延遲 create dispatch 模型；不宣稱真實 WebRTC 音訊驗證。

76. **入口表單共用 pending 的呈現（2026-10-12）：** 全模組 fixture 重現 create／join 共用 busy guard，但只停用送出方按鈕，另一側看似可按卻被靜默忽略。兩個 submit 標記為同一入口操作群組，由目前 DOM 的 helper 同步 disabled／aria-busy；開始與 finally 更新，landing 重繪也繼承既有 busy，不提早解鎖。沿用原本單一鎖、請求 payload、錯誤處理與 SDK 語意；不再把已退場的單一按鈕交給 run 的 finally 更新。六個全模組 VM cases 守雙向 pending、直接 form submit（鍵盤提交 handler）、失敗重試、state-before-ACK 成功、依 SDK 順序的斷線與重入、退場節點不被修改。fake DOM 不等同瀏覽器原生鍵盤／accessibility 驗證。

77. **自動播放錯誤的 peer ownership（2026-10-12）：** deferred fake audio 重現 ontrack 啟動 play 後 disconnect 或替換 peer，舊 promise 的 AbortError 仍發 audioblocked，讓 landing／新房出現過期啟用音訊提示。catch 沿用 ontrack 的 peer 身分檢查，僅目前 peer 能發此事件。owned／custom audio 共 12 cases，baseline 4 fail，涵蓋離房、替換已成功播放、目前拒絕、退場 track callback 與 public unlockAudio 成功／失敗相容性。不引入 same-peer attempt token；未以 native browser 證實同 peer 多次 play 的遲到順序，不擴大變更或聲稱實際權限／自動播放驗證。

78. **answer continuation 的協商 ownership（2026-10-12）：** FIFO fake PeerConnection 重現 queued ICE 超過 answer 期限，正常 ICE restart 的新 offer／waiter 與舊 candidate continuation 交錯；舊成功可在新 answer 尚未收到時完成新協商，舊失敗亦可能拒絕新 waiter。receive 捕捉 peer 與 answerWait，僅在兩者仍相同時 settle 捕捉的 waiter；peer 替換／離房後停止剩餘批次。同 peer 的 SDP／ICE drain 與 splice 時機沿用 baseline，避免在 SDP 逾時後把 shared remoteIce 留到下一輪 answer，導致舊候選錯誤拒絕新 waiter（review 發現並排除的初版 regression）。typed regressions 從真實 SDK connect／snapshot／negotiate／timer 路徑建立 waiter，fake 嚴守 SDP／ICE FIFO；包括同 peer restart、peer replacement、disconnect、expired SDP 與目前協商成功／失敗。不改 protocol，不宣稱能關聯一開始就在新 waiter 建立後才收到的舊 wire answer；不取消已送入瀏覽器的操作，不宣稱 native browser 發生率或 real ICE 驗證。

79. **ICE 錯誤通知的 peer ownership（2026-10-12）：** 真實 SDK connect／receive／自動協商搭配 fake socket／peer，重現斷線拒絕 queued／sent ICE 請求後，舊 catch 仍在 landing 發 error；舊 addIceCandidate 遲到拒絕亦能污染替換身分。outbound request catch 檢查捕捉的 peer，inbound rtc:ice 在同一 guarded catch 直接 report，避免檢查後 rethrow 到 generic socket handler 之間再發生替換的 microtask gap。12 regressions，baseline 7 fail／5 pass，守 teardown、replacement、listener 同步斷線／替換、目前 inbound 一次通知、同 peer socket resume／socket loss，以及目前 server ICE error 原有兩次通知。公開 request promise 與 server error handler 不變，並非全面 dedup；listener 若已移除 peer，僅略過之後的退場 callback。不改信令 pacing、answer batch、ICE restart 或 reconnect 語意；fake 測試不代表 native browser／real ICE 發生率。

80. **觀眾計數改用既有集合大小（2026-10-12）：** Room 支援的狀態機轉換保證恰有一名主控，其他非 audience 成員皆為 on-stage speaker，因此 audienceCount = participants.size − speakerCount − 1；主控離台仍另扣一席。用此式取代每次 sharedSnapshot 的 participant scan，不增 cached counter／mutation path。既有 12-seed oracle 在 in-memory candidate 下 83,813 次 getter 比較一致，另有 focused 邊界／轉移／斷線／closure 與 constant-work regressions。bounded benchmark 使用 1／9／301 人、四種舞台配置、三次 warm-up、七輪交錯 100,000 reads，checksum 驗證；提交版腳本的三個獨立 Node 程序滿房 median 約 960–994 ns → 8–10 ns，僅 getter 約 0.95 µs 的節省，不代表整體請求／廣播加速。每次 broadcast 原已只建一次 sharedSnapshot，主控名單與 invariant 掃描未優化。公式不承諾任意外部直接破壞公開 Map／Set／role 的狀態；所有正式 membership／role 變更仍經 Room 方法。

81. **stop 期限輸入的有界驗證（2026-10-12）：** stage.sh 的 if 整數比較遇到 STAGE_STOP_TIMEOUT=abc／1.5／溢位時只印錯誤，不會觸發 set -e，讓 stop 永遠略過 SIGKILL 期限。新增 stop 起始驗證，restart 也先經此路徑；只接受非負十進位整數至 2147483647，未設定／空值仍為 15，0 保留 TERM 後立即檢查／KILL 的語意。範圍選 signed 32-bit 以相容 POSIX shell 整數比較；無效輸入在 running_pid 前結束，PID 檔與目標程序不受影響。Node tests 複製 script 至暫存 fixture，kill／sleep 全以有界 shell mocks 記錄，守無效 stop／restart、預設／零／leading-zero／最大值、graceful exit、缺少／stale PID 與其他指令；不對實際使用者程序送訊號。PowerShell 與 PID ownership 設計留在本批範圍外。

82. **PID 檔格式與失敗傳遞（2026-10-12）：** 嚴格 mocked shell fixtures 重現 stage.sh 將任意非空 PID 檔字串傳入 kill，包含 0／負數 process-group selector；空檔亦會被當作 stale 刪除。review 證實 shell command substitution 會丟棄 NUL，故 running_pid 用單次 POSIX od 讀取 byte tokens，只解碼 ASCII digits 與尾端 LF，再檢查 1–2147483647 範圍；不把二進位原文放入 shell 字串，也不重讀檔案。讀取失敗／格式無效回內部 status 2 並保留檔案，四個呼叫端將其傳遞為 exit 1，不誤認為 absent/stale（內部 status 1）。start 先判定 PID 再檢查 Node，restart 不在 invalid stop 後啟動；正值 stale 清理與正常 TERM／KILL 流程保留。既有 51 個 deadline tests 與新增參數化 PID cases 均使用隔離暫存 fixture、kill／sleep／node／nohup mocks 和有限 liveness budget，沒有實際訊號。只驗證格式與範圍，不宣稱辨識程序 ownership、解決 PID reuse 或涵蓋任意檔案替換競態；PowerShell 不在本批範圍。

83. **範例品質警示的索引更新（2026-10-13）：** speaking 已有每次 render 重建的 participant→rows 索引，quality handler 卻仍掃描全部人員列。有界全模組 fixture 在 301 人／593 列、100 次單人報告重現 100 次全列查詢與 59,300 次 badge 查詢；改為前次／本次 quality ID 聯集查索引，分別降至 0／100。保留 applyQuality 與每次報告重寫行為，不用 object identity 或欄位 dedup，避免忽略共用 quality object 的修改；缺少項目亦更新以移除舊 badge。新 render 仍從目前 quality map 初始化，landing／重繪清索引，不修改退場 DOM。測試涵蓋重複列、omission／empty／unknown、門檻／title、mutable reports、重繪／離房／重入與 speaking／gain 控制保留。只宣稱 fake DOM 操作數下降，不代表 native browser layout／CPU／延遲或實際音訊改善。

84. **退場 gain 請求的錯誤呈現（2026-10-13）：** 全模組 fixture 依 SDK 的 pending rejection → disconnected status 順序重現，主控調整音量後立刻離房，generic run catch 會在已成功呈現的 landing 顯示「連線已中斷。」；shutdown 也會在維護通知旁附上舊請求錯誤。只有 gain 呼叫傳入當次 room generation，run 在 catch 實際寫入錯誤 UI 的同一同步步驟檢查 ownership，避免 guarded rethrow 再交給外層 catch 的 microtask 間隙。其他 generic run 呼叫的行為不變。沒有共用 busy／遺失 gain 命令的證據，不加 pending lock 或 coalescing；同人／不同人連續放開均照常送出，state-before-ACK 的伺服器權威音量重繪與當前房間錯誤保留。fixture 為 fake SDK／DOM，不宣稱 native browser 或真實音訊驗證。

85. **邀請複製完成的 UI ownership（2026-10-13）：** deferred clipboard stub 的全模組 probe 重現舊 copy 成功／失敗在 leave、rejoin、role loss、shutdown 與 code rotation 後覆寫新通知；失敗也會 focus／select 已退場 input。另在無關快照重繪後按第二次 copy，可讓舊拒絕覆寫新成功，或反向覆寫新 fallback。完成後同時檢查 captured room generation、latest copy attempt sequence 與目前 connected invite input 的 exact href；當前連結未變的重繪仍能呈現成功，失敗選取目前 input。只更新應用程式提示／fallback，不取消或還原已發出的 clipboard write，不保證瀏覽器寫入完成順序。沒有新 pending lock、DOM cache 或 clipboard 權限要求；缺少 API、同步 throw 與目前失敗仍採原本手動選取提示。fake SDK／clipboard／DOM 的測試只證明應用程式呼叫與目標，不宣稱 native focus、真實剪貼簿或實際完成頻率驗證。

86. **嵌入元件的進場進度（2026-10-13）：** 既有 DOM fake＋實際 SDK 的 controlled-clock probe 證實 hello／join ACK 各等待至 15000ms 期限時，configured widget 狀態列均為空，失敗也只有 error 列。新增 widget-only connecting／joining phase，在既有 role=status 區域呈現「連線中…」／「正在加入房間…」，沒有 snapshot 的當前失敗改顯示「未連線」。room snapshot 立即優先於 phase，state-before-ACK 不延後 room controls；晚到 ACK 失敗保留已知房間狀態。disconnected／closed／kicked 在轉發事件前移除 phase，leave／rejoin 清除，async continuation 同時檢查 generation 與 current client，避免舊結果污染新房。保留原有錯誤列行為，不新增 SDK status／事件、aria-busy、計時器、重試或媒體操作。測試使用 fake DOM／WebSocket 與控制時間，不代表瀏覽器 layout／accessibility／音訊驗證。

87. **重連中的 widget 控制准入（2026-10-13）：** 實際 SDK＋fake socket/DOM probe 重現 reconnect backoff／CONNECTING 仍可按舉手、收回、mic mute/unmute 與離台，前述請求會拒絕；failed raise 還會保留 10000ms 本機冷卻，500ms 後成功回座仍剩 9500ms。replacement socket OPEN 但尚未 resume 時也可能提早送到未綁定的 Hub 而得 not_joined，因此不宣稱所有 reconnecting 請求都拒絕。widget render 對三個 server-dependent 按鈕加 reconnecting predicate，與原 pending／cooldown／force-muted 條件合併；本機 listen／volume／unlock 保持可用。測試驗證 socket phases、state-before-ACK 回座、disabled click 不呼叫 SDK／消耗冷卻、pending settlement／冷卻到期不提早解鎖及復原後政策。不改 SDK request、重試／排隊或 microphone fallback；fake 測試不代表瀏覽器或 real media 驗證。

88. **未准入舉手不保留冷卻（2026-10-13）：** batch 64 的實際 SDK probe 同時揭露直接呼叫 raiseHand 在無 socket／非 OPEN 時，request 立即拒絕卻已寫入 lastHandAt，同席位自動恢復後仍被這次未送出的操作阻擋。raiseHand 保留既有 cooldown → control capacity 錯誤優先順序，再以與 request 相同的 socket OPEN 檢查拒絕，之後才保留時間戳。僅排除進入 request 前即可確定的 disconnected；不依 ClientStatus 限制 OPEN 連線，不新增握手／回座可用性判定，不回滾已准入後 send failure、timeout 或 server rejection 的冷卻，也不改伺服器 rate limit。測試以公開 API、控制時間及 fake socket 覆蓋 absent／CONNECTING／CLOSING／CLOSED、同席恢復、錯誤優先權、pacing／pending／timer 未變與後續失敗仍冷卻。無 native browser／真實音訊驗證宣稱。

89. **主動斷線取消 hello 等待（2026-10-13）：** bounded localhost WebSocket probe 暫停 server reads 後，disconnect 雖清除 socket／connecting 引用，connect／join／createRoom 的 closure-owned hello promise 仍等待 transport close 或 deadline，最後回 timeout 而非既有文件承諾的 disconnected。新增屬於該次 hello 的 cancel hook，在主動斷線同步清除 deadline 並 reject；hello／close／timeout 僅清除自己持有的 hook，避免舊事件取消 replacement。維持既有正常 error／timeout、回座退避及已完成 hello 的語意，不新增事件監聽或伺服器取消協定。測試以控制時間、fake socket 與有界 localhost ws stalled-close 情境覆蓋共享等待者、同步 close throw、立即重用與 late old events；本機 promise 取消不保證底層 socket 立即釋放，亦不代表真實音訊驗證。

90. **嵌入元件手動重試加入（2026-10-13）：** widget 初次 hello／join 失敗後雖有錯誤與狀態列，使用者沒有內建恢復入口，只能重載或由嵌入端改屬性。新增「重試加入」原生按鈕，僅在該次尚未收到任何 room state、沒有 closed／kicked 且 connect／join 已失敗時提供；點擊沿用 rejoin 的 generation、舊 client 清理與屬性／收聽偏好設定。等待、room state、自動回座與 terminal 事件均隱藏／停用，不將 state-before-ACK 的晚到失敗變成重新加入提示。status 先於 state 轉發時也先記錄已安裝的 snapshot；terminal／state 事件轉發前同步停用按鈕，點擊另檢查當前 eligibility，避免重入 callback 開啟新連線。沒有自動重試、SDK API／status 或伺服器授權變更，伺服器仍決定房間／代碼是否可用。fake DOM＋實際 SDK／fake socket 測試涵蓋失敗恢復與生命週期，並非 native browser layout／鍵盤或真實音訊驗證。

91. **退場音訊解鎖的提示隔離（2026-10-13）：** sample 全模組 fixture 重現 pending unlock 被 disconnect／audio pause 拒絕後，generic run 在已清理的 landing 顯示舊播放錯誤。只有音訊解鎖按鈕把 render 時的 room generation 傳至既有 run 錯誤寫入點，成功後清除 audioBlocked 也檢查相同 generation；其他 generic buttons 與 SDK unlockAudio promise 不改。保留同步使用者點擊內呼叫 play 的時序、當前錯誤與重試，不新增 latest-notice token 或瀏覽器播放取消機制。證據僅支持被 pause 的 pending play 拒絕；不把 fake 成功延後至完整新房的情境當作 native browser 問題，成功 guard 只作跨身分的 defensive ownership。測試使用 fake SDK／DOM／play promise，沒有真實瀏覽器權限或音訊驗證。
