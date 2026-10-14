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

92. **範例收聽偏好本機保存（2026-10-13）：** 範例原本只保存 theme，重載會遺失使用者的收聽音量／靜音。新增單一 stage-playback localStorage record，version 1，完整驗證 finite 0–1 volume 與 boolean muted，raw 字串超過 128 字元不解析；無效或不支援的 version 整筆忽略。建立 client 後、加入與播放前還原，控制列以還原值初始化；只有明確 volume input／mute click 寫回固定欄位，不在 render／reconnect／restore 時寫入。read／write 例外不影響本機控制，缺少偏好維持 100%／未靜音；零音量不等同 muted。只改範例，不保存 mic／device／room／account 資料、不新增跨分頁同步或 SDK／widget API。測試使用全模組 VM／假儲存與音訊，不代表 native browser persistence／autoplay 驗證。

93. **靜音麥克風停止音量表輪詢（2026-10-13）：** sample 的 on-stage predicate 讓已靜音成員仍每 50ms 讀取已知為零的 micLevel；全模組 controlled-clock 在 10 秒記錄 200 次讀取與 5 次獨立統計輪詢。metering 改為 preview 或 on-stage 且 !me.muted；Room.view 的 muted 包含 selfMuted／forceMuted，SDK micLevel 依實際 track.enabled 回零。mute state 到達立即清 timer／歸零，unmute state 重啟單一 timer，同席 reconnect 保留目前政策，preview 與本機收聽靜音獨立。只減少假時鐘下的 200→0 次音量表讀取，不宣稱 browser CPU／電量或音訊延遲改善，2 秒 stats 排程未變。

94. **client 重連延遲的範圍驗證（2026-10-13）：** bounded public join＋fake socket/timer probe 證實 NaN／negative／Infinity／超過 signed-32-bit 的 delay 會直接進 setTimeout，破壞退避；Node24 native timer 建立後立即取消的驗證顯示這些值會轉為 1ms，沒有啟動真實重試迴圈。constructor 在 audio 副作用前檢查兩欄 finite 0–2147483647，保留 zero／fraction／max<initial 與預設值；也拒絕原本可被較小 finite max 偶然截斷的 Infinity／oversized initial。重連欄位複製成 validated snapshot，避免 caller 後續改 reference 繞過驗證；既有文件沒有 runtime mutation API，現在明示建構值固定，其他 options 行為不改。指數計算仍 capped attempt20 並先取最大 delay，有限值不送出 overflow timer。測試以有界 fake 重試／立即清理 native timer 的外部證據為限，不宣稱所有瀏覽器 timer coercion 或真實音訊驗證。


95. **範例初次連線的手動取消（2026-10-13）：** landing 建立／加入等待時兩表單皆鎖定，原本只能等 hello／request deadline 或重載。新增僅在 pending 且尚未觀察到房間狀態的「取消連線」按鈕，使用既有 SDK disconnect；操作 token 在同步斷線回呼前標為 cancelled，僅該次 entry 的錯誤在 UI sink 被抑制，其他操作錯誤照常顯示。共享鎖仍由原 entry settlement 釋放，不提前開放重試；取消後延遲完成的 create 結果不得重寫房間資料。state-before-ACK／帶 state 的 status／terminal event 永久撤銷該 entry 的取消資格，retired DOM callback 也須通過 connected 與現況檢查。這是本機等待取消，不新增伺服器取消協定或 rollback 保證。全模組假 DOM 與實際 SDK 測試不代表 native browser／真實音訊驗證。


96. **範例待授權預覽的手動取消（2026-10-13）：** 全模組 bounded probe 重現 pending startMicTest 沒有 signal，測試與裝置選擇都鎖定且只能離房取消。新增每次 preview capture 自有 AbortController 與「取消麥克風測試」控制；同步撤銷控制／ownership 後 abort，只吞掉該 capture 已取消的結果，普通失敗仍走原本錯誤顯示。直接測試與 setInputDevice 完成後的 preview restart 共用 helper，setInputDevice 本身不宣稱可取消。原操作 finally 仍負責釋放共享鎖，generation 保護離房／重入的新操作；上台與 reset 主動取消 pending preview，晚到成功結果只停止自身串流。呼叫 startMicTest 仍在使用者動作同步執行，房內 mic／收聽及 meter 政策不變。測試採假 DOM、實際 SDK 與 fake getUserMedia，無權限提示自動關閉或真實裝置驗證宣稱。


97. **最小嵌入範例的舉手等待鎖（2026-10-13）：** whole-module bounded VM probe 重現 embed.ts 的 250ms timer 與 state callback 在 withdraw ACK 未回時覆寫 disabled，使三次點擊送出三筆同時等待的請求。新增 current-client operation token 與 shared hand renderer，state、timer 與 settlement 都保留 pending 限制／aria-busy；handler 本身也拒絕重入，同步 throw 與 rejection 在目前 owner 下顯示並解鎖。離房、重加入、disconnected／terminal 撤銷 token，舊 finally／錯誤不得解鎖或污染新 client；會寫入 hand 狀態的事件回呼檢查 client identity。保留 state-before-ACK、角色／reconnect／cooldown 政策與原 250ms 排程，不擴大為 embed join/import 的完整生命週期重構。測試使用全模組假 DOM／SDK／timer，不執行外部動態匯入，不宣稱 native browser 或音訊驗證。


98. **最小嵌入範例的播放錯誤歸屬（2026-10-13）：** whole-module probe 使用 SDK 對應的 pause 後 srcObject=null／pending play 拒絕順序，重現 unlockAudio().catch(report) 覆寫 Leave、disconnected、closed 與 kicked 提示。新增 playback lifecycle generation，join start／Leave／目前 client 的 disconnected／terminal 撤銷舊回報；unlock 捕捉 client 與 generation，只限制後續 error sink，play 仍在原點擊同步呼叫，當前錯誤與未加入時 audio.play 失敗照常顯示。不新增 latest-attempt、成功後狀態寫入或 SDK 取消語意。以同步清理拒絕模型，稍後完成的 rejoin 會自行重畫，因此跨新 client 測試僅為 defensive ownership，不能宣稱 native rejoin bug。測試使用全模組假 DOM／play promises，沒有真實瀏覽器或音訊驗證。


99. **最小嵌入範例的按需冷卻更新（2026-10-13）：** bounded whole-module fake clock 在 idle audience 的 10 秒測得 40 次 timer callback、120 次內容不變的 hand DOM 寫入；10 秒倒數也只有 10 次必要文字變化。改成 offstage／未舉手且 cooldown>0 才持有一個 timeout，Math.ceil 對齊下一次顯示秒數邊界；以 performance.now 記錄 deadline，重複 state 不延後既有 timer；same-seat reconnect 的 hello 更新舉手間隔時，若下一個邊界變早則改排較早 timer，變晚可保留一次較早的 harmless wake。late wake 讀取當前剩餘時間，不重播漏掉的秒。raiseHand 同步保留冷卻後立即 sync，無需等待 ACK；status-only recovery 也同步刷新政策。join／Leave／terminal／倒數消失清除 handle，callback 檢查自己仍持有 slot，舊 timer 不得清掉新 timer。pending／角色／reconnect gating 與 SDK pacing 不改；不改其他模組 timer。量化只限 fake clock callbacks／DOM 寫入，不宣稱 browser CPU、電量或音訊改善。


100. **完整範例與 widget 的冷卻重排（2026-10-13）：** batch 76 的 retime 發現延伸檢查證實兩個既有 scheduler 同樣只在 timer 空白時安排。實際 SDK＋fake socket/peer：2000ms 間隔下 raise 後，同席自動 resume 的 hello 改為 1200ms，保留 lastHandAt 與 peer；+100ms 剩 1100ms，+200ms 剩 1000ms。兩個 UI 原 timer 仍等到 +1000ms，因而在 +200ms 顯示 2 秒而不是 1 秒。套用 embed 已審查的 performance.now deadline、較早邊界改排、owned callback guard；inactive／fire／widget leave 同步清 deadline。重複／較晚邊界保留既有較早喚醒，較晚 retime 可有一次 harmless extra wake。維持 idle 無 timer、pending/reconnect／角色限制與 SDK rate/pacing 語意；不宣稱目前伺服器提供 live config reload 或真實媒體重連驗證。測試採實際 SDK 搭配 fake transport，以及假 DOM／受控時間。


101. **主控換碼後的重連憑證更新（2026-10-13）：** actual SDK＋StageHub 的 bounded probe 與 real localhost WebSocket regression 均證實：rotateCode 的新 state.code 已顯示，但 session.code 仍是初次值，斷線後 resume 帶有效 token 仍被 Hub 的 code-first admission 拒絕。新增 SDK-only helper，只接納 matching-room／controller／codeRequired 的非空 code；incoming state 在 forwarding 前更新 session，installSession 也取最新同房 snapshot，防止 state-before-ACK 被舊 caller／created code 覆蓋。代碼省略、demotion、audience 或 open-room state 保留既有值，retired socket／其他房間不得污染新 session 的代碼。不改 Hub admission 或一般成員 resume policy；換碼後他們的現有連線保留，但未取得新代碼仍不能以舊代碼重連，README 明示此既有限制。測試以真實 localhost signaling＋MockMedia 與 deterministic fake socket 覆蓋，沒有 real ICE／音訊驗證宣稱。


102. **下台時立即釋放房間擷取（2026-10-13）：** public SDK＋fake socket／media 的 bounded probe 重現：setInputDevice 或 promotion 的 replaceTrack 未完成時，leaveStage 已收到 offstage state／ACK，原串流與候選串流仍存活；Room 下台清除 muted flags，還會使原本 muted 的 track 被重新 enabled。promotion continuation 也會以舊 sendrecv 方向發起 offer，遭現有 Hub 權限拒絕，並留下等待中的 dirty negotiation。收到 offstage snapshot 後先同步停止房間 mic／meter 與 ownership-tracked 候選替換，再轉送事件；同一 helper 用於 teardown，disposer 在成功安裝前轉移 ownership，舊 finally 不得停止新資源。syncMedia 的 replaceTrack 後檢查 mediaRevision，讓已排隊的最新狀態負責方向與協商。不取消 browser replaceTrack、不繞過 serialized queue、不改一般錯誤或伺服器 publish permission；獨立 mic preview 不受影響。原伺服器已在 state 前 unpublish 並拒絕 offstage sending offer，沒有證據顯示音訊授權繞過。測試只證明受控假媒體的本機資源與 signaling ownership，不宣稱實際裝置擷取時長或可聽見的洩漏。


103. **Widget 的初次加入取消（2026-10-13）：** 完整範例已有取消連線，但 widget 在 hello／join ACK 等待期間只能透過移除元素、改屬性或程式呼叫 client.disconnect 停止。新增 native「取消加入」按鈕，以 generation＋client-owned closure 限定目前尚未觀察到 state 的 initial attempt；同步撤銷 eligibility、清除進度、顯示「已取消加入。」後沿用 SDK disconnect。保留 current client 的事件轉送，僅取消的 attempt catch 不顯示錯誤，connect continuation 亦檢查 cancelled，防止取消後再偷偷 join。可立即手動 retry 建立新 client，舊 settlement／cancel finally 由 generation 隔離；不自動重試、不新增 SDK status。state（含 status callback 可見 snapshot）與 terminal 在對外 forwarding 前撤銷 cancel，舊 DOM callback 不得取消已進場房間。取消只結束本機等待，不能保證 server-accepted join rollback 或底層 close handshake 立即完成。測試使用 fake DOM／受控 promises 與 actual SDK＋fake socket，沒有 native browser／音訊宣稱。


104. **待完成裝置替換的靜音同步（2026-10-13）：** actual SDK＋fake socket/media 的六組 bounded probe 重現：replaceTrack promise 等待時，mute／force-muted state 只停用 installed track，candidate 仍 enabled；unmute 反向不一致，直到 promise 完成才修正。涵蓋 sender 尚指向舊 track 與已指向候選但 promise 未 settle；[WebRTC replaceTrack 規範](https://w3c.github.io/webrtc-pc/#dom-rtcrtpsender-replacetrack)先切換傳送、再排 sender.track 更新／promise resolution，這種窗口具 native plausibility，但未做實際 browser measurement。將既有 pending replacement ownership Set 改為 stream→disposer Map，在既有 snapshot callback／ownership guard 後的位置，同步已安裝與仍持有的候選音軌 enabled = onStage && !muted；正常安裝／失敗／下台／teardown 沿用刪除與釋放。保留 serialized queue、公開 promise／error、伺服器 mute／publish 政策與獨立 mic preview，沒有房間可聽見的靜音繞過證據，也不宣稱 disabled track 會停止實體擷取。


105. **CLI 停機失敗的後續清理與退出狀態（2026-10-13）：** bounded VM 執行原始 src/index.ts shutdown tail，使用 inert process/server/transport/logger，證實 server.close 拒絕跳過 transport.close 與 explicit exit，transport.close 拒絕亦跳過 exit；stopping 已設置使後續訊號無法重新完成。server.close 保留 hub.shutdown 拒絕是既有受測契約。worker 使用 unref，因此不宣稱每次失敗必然讓程序存活。改為 CLI-only 依序 best-effort close，各段失敗分別記錄並設定非零 exit intent，仍嘗試後段，最後 exit；不改 transport internals 或 timeout。共享 exitCode 在 stopping guard 前接收第一個非零意圖，讓普通停機等待期間的 uncaughtException 升級為 1，後續 normal signal 不降級，也不覆寫原先非零值。維持 cleanup/exit 一次、成功順序與 unrelated unhandledRejection 只記錄政策。測試只使用 VM stubs，不傳送真實訊號、不退出測試程序、不啟動音訊 worker。


106. **離線設定預檢（2026-10-13）：** 新增 src/check-config.ts 與 npm config:check，使用同一 loadConfig schema，無 startup／media imports，支援 source 與 dist entry。explicit path > STAGE_CONFIG > repo-root config.yaml，relative explicit/env 依 cwd，保留空 env 的既有 nullish 語意；help0／usage2／驗證錯誤1／成功0，不複製或改寫設定，不探測憑證、靜態資源、port 或 TURN。synthetic malformed token／alias／unknown tag／directive／complex-key probe 證實舊 yaml.parse error.message 與 warning 可含設定內容；共用 loader 改用 logLevel:error、prettyErrors:false、LineCounter，只輸出 parser code 與數字位置，read／conversion error 採靜態診斷，不印路徑或原文。不得使用 logLevel:silent，該 library 模式會丟棄 parse errors（例如多文件），已用對照確認。warning-only YAML 維持先前接受規則但不輸出原文 warning，schema field diagnostics 保留。測試只使用 example-derived synthetic fixture tree，default path 不讀真實 config.yaml；不啟動網路／worker 或讀取真實憑證。


107. **主控 gain slider 的重連限制（2026-10-13）：** whole-module sample＋actual SDK／fake socket probe 重現 retained room 在 reconnecting 時 slider 仍可操作：沒有 open socket 會產生離線錯誤，replacement socket OPEN 但 hello 尚未完成時會送出 mic:gain。將 slider 加入既有 data-room-action 同步停用路徑，採獨立 gain:<participantId> key，不建立 pending lock；change handler 同時檢查 disabled 與 reconnecting，避免程式化事件繞過 UI。state/status 重畫沿用現有恢復規則，已送出的請求照常 settle，多人與同人的並行 gain、目前房間錯誤、離房錯誤歸屬不變；本機 playback controls 不受影響。不修改 SDK admission／server policy，不宣稱 native browser、真實網路或音訊驗證。


108. **最小嵌入範例的加入回報歸屬（2026-10-13）：** whole-module VM＋actual StageClient／fake socket 重現 state-before-ACK 開放 Leave 後，正常 Leave 使 disconnect 拒絕 pending join，舊 catch 覆寫「已離開。」為離線錯誤。新增 entry generation：submit／Leave／目前 client terminal 撤銷先前初次加入的 continuation、catch 與 finally；離開／terminal 立即釋放舊 submit lock，新 attempt 的 pending 不受舊 finally 影響。disconnect／動態 import／connect 每個 await 後檢查 owner，使用 captured client 執行 connect/join；Leave 的完成提示也檢查 generation/client，避免重入新加入後舊提示覆寫。保留目前加入／一般 SDK error 回報、現有表單及播放／舉手政策，不新增 retry/progress UI，不取消已發出的 server 操作。terminal-before-ACK 是防禦性排序測試：目前 Hub 同步發 state 再 ACK，同一 socket 後續 terminal 通常排在 ACK 之後；不宣稱另有已證實的 server terminal 競爭。測試沒有真實瀏覽器、動態遠端模組載入或音訊驗證。


109. **release 替換的靜態驗證值（2026-10-13）：** native localhost HTTP＋synthetic release-root swap 重現：不同內容的 identity／gzip 資產具有相同大小與保留 mtime 時，舊 size+mtime ETag 不變，conditional GET 回 304 而 unconditional 已是新檔。改用所選 representation 的同一 stat/lstat snapshot，弱 ETag 納入 dev／ino／size／mtimeNs／ctimeNs，使用 bigint 避免大型 inode／奈秒資料的 Number 精度損失；壓縮 sidecar 比較亦採 bigint，Content-Length 輸出十進位字串。不新增每請求 hash、額外 stat、metadata cache 或跨請求狀態，保留 encoding discriminator、HEAD／ETag precedence 與 Last-Modified 行為。這不是內容等價保證：檔案系統若回報完全相同身分／時間／大小仍可能碰撞，ctime 變動可使相同內容重新驗證為 200；IMS-only 仍不能辨識保留 mtime 的更新。原有不可信 writer／TOCTOU 限制不變，不宣稱跨所有檔案系統的完整內容偵測。


110. **伺服器計時設定的有效上限（2026-10-13）：** native Node 24 timer handle inspection（立即 clear）證實 2147483647 保留原值，而 2147483648／MAX_SAFE_INTEGER 對 timeout/interval 均正規化成 1ms 並產生 warning；parseConfig 原本接受四個直接計時欄位的超大值。actual Hub/server 搭配 captured callbacks 的 bounded probe 依序重現 join 1008、主控移交／無繼任者關房、participant 席位與 peer 移除、兩次 heartbeat tick 後 terminate，沒有啟動 listener 或等待長 timer。只將 limits.joinTimeoutMs、rooms.controllerGraceMs／participantGraceMs／heartbeatIntervalMs 的 schema 上限設為 inclusive 2147483647，保留前三項 0 及 heartbeat 1000 的下限／預設，讓啟動與同 schema 的離線 checker 提早拒絕之前被接受但無法如意執行的值。elapsed-only handRaiseIntervalMs、TURN expiry timestamp 及已有更小 bounds 的其他 timer 不變；不新增分段長 timer 或改動服務執行順序。


111. **最小嵌入範例的初次加入進度（2026-10-13）：** whole-module probe 證實首次 submit 在動態 import、hello 與 pre-snapshot join 等待期間一直顯示「尚未加入」，重新進入時可能留在「未連線」。沿用 entry generation，依序顯示載入舞台元件／連線／加入房間，submit 的 aria-busy 與 disabled 共用既有 owner。共用 report 的 feedback revision 也讓手動 unlock 的當前失敗優先於後續階段；每個 attempt 的進度 eligibility 在 state、error／micerror／audioblocked 或 reconnect/disconnected feedback 出現時撤銷，async phase 不得覆寫已收到的快照或當前訊息；正常 Hub 先發 state 再 ACK；若防禦性 ACK-only 回覆仍成功，明確顯示請求已完成但未收到房間狀態，而不維持處理中的標籤。finally 不改 status，只有仍持有的 attempt 清 busy，Leave／terminal 立即退休舊 busy。保留 state-before-ACK 的即時房間顯示、舊 finally 隔離與目前錯誤；不新增 spinner／timer、取消／重試按鈕或 SDK 狀態。測試仍是 actual SDK 搭配假 DOM／socket／media，不宣稱 browser accessibility 或實際連線體驗量測。


112. **Web Component 舉手佇列位置（2026-10-13）：** compact widget 原本只有「已舉手」而無完整名單。以既有公開權威 state.hands 的 participantId 查找顯示 1-based 位置，僅 offstage／非主控且 handRaised 時計算；找不到本人則保留「已舉手」，不猜測或露出其他資料。重連保留快照時明示「上次佇列」，新 state 自動重算，withdraw／上台／身分替換沿用現有 UI 判斷。舉手按鈕、pending／cooldown／reconnect／controller gates、既有 status role 與 polite live region 均不改，不新增 SDK API／timer／cache。Room.handQueue 包含 grace 內斷線者，主控可任意核准，因此這是目前名單位置，並非發言保證或預估等待時間。測試使用假 DOM／受控 SDK 事件，不宣稱真實輔助科技朗讀或 browser layout 驗證。


113. **SDK 明確重試房間麥克風（2026-10-13）：** actual SDK＋fake socket/media 對 NotAllowedError／NotFoundError／NotReadableError 證實，初次失敗後 setInputDevice 只保存選擇、mute／unmute／普通快照及成功 preview 均不清 room micFailed；原本需重新上台或 peer 替換才恢復。新增 additive retryMicrophone():boolean，僅目前 live／OPEN 信令／有效 current peer／仍在台上／無 mic／micFailed 時接納，先同步清 latch 再沿用 syncMedia 排程，重複／不適用呼叫回 false。true 是 enqueue-only，既有 revision supersession 可取消工作，不能包裝 mediaTask 當作成功 promise，因為背景 path 會吞 capture/install failure 並派事件，也不等待 negotiation。保留選定裝置、mute／force-mute、台位／peer、獨立 preview 與原本 generation/capture ownership；不新增 automatic retry、UI 按鈕或協商流程。micready 是既有共享事件（preview 亦會發出，且早於 sender 安裝），文件不得宣稱它能確定該次重試／聲音傳送成功。驗證使用假授權／音軌／socket，真實 browser／ICE／裝置限制不變。


114. **完整範例的手動麥克風重試（2026-10-13）：** 沿用 SDK retryMicrophone boolean admission，在目前 onstage micerror banner 提供明確「重試麥克風」，不自動呼叫。獨立 available/pending flag 保留跨 notice/state 重畫的等待狀態，handler 檢查 room generation、DOM/current policy 與重入；先保留 pending，再依 true／false admission 處理，不把 boolean 當作完成 promise。false 保留既有錯誤、不永久鎖定；目前 micerror 恢復手動操作，micready 清除擷取提示但不宣稱 sender／negotiation 成功。reconnect 只停用新操作；offstage／disconnect／身分替換退休 UI 工作，舊 DOM 不得要求新房擷取。完整範例上台時已禁止／取消自己的 preview，仍不將共享 micready 描述為一般 API completion guarantee。保留裝置選擇、mute／force-mute、本機 playback、generic error sink 與 SDK generation semantics，不修改 SDK／server。測試使用 whole-module 假 DOM 加 actual SDK／fake media，不觸發真實授權提示或宣稱音訊 E2E。


115. **POSIX restart 停機前預檢（2026-10-13）：** strict shell mocks 重現原本 restart 先 TERM／移除健康 PID，才發現 Node 失敗／版本過舊、缺少 dist entry 或指定設定；invalid schema／空 STAGE_CONFIG 也在 stop 後才進入 launch。新增 restart-only preflight，先保留 timeout 與 PID 驗證／探測優先序，再檢查 Node、built entry 與 built checker，沿用 ensure_config，使用無 positional argument 的 built checker 驗證原始環境。checker 與 server 同樣 import dist config schema，缺少舊版 checker 時要求 build，不回退到可能不同版的 source。預設設定不存在時仍可由既有準備步驟複製範例；checker 本身唯讀。驗證成功後才沿用 stop/start，保留 start/run/dev 的既有條件；不宣稱零停機、runtime health、PID ownership 或 TOCTOU 保證，不讀使用者真實設定／憑證。測試只在 synthetic fixture 內使用受限程序 mocks，沒有真實訊號或 server 啟動，Windows 行為另行保留。


116. **未列出之已選擇裝置的顯示（2026-10-13）：** whole-module devicechange probe 證實選定 input/output 後，最新 enumeration 移除該 ID 時仍保存 selectedInput/selectedOutput，但 select options 不再有匹配項；native value setter 因而失去選取顯示，不能反映仍保留的選擇。新增 UI-only reconciliation，在 refresh、device-change finally 與離房 settings reset 復原選擇時，為非空且未列出的 chosen ID 建立停用的「已選擇的裝置（目前未列出）」option；不輸出原始 ID 標籤，不把缺席推論為裝置故障。重新列出即回正常 option，選其他裝置／default 即撤掉舊 placeholder；不主動呼叫 SDK 切換、不改 permission／capture／output promise 語意。測試補充受限 native select clamping 模型及 pending change／refresh 排序，不宣稱實際 browser/device 測試。


117. **自訂靜態掛載的 canonical slash（2026-10-13）：** native localhost HTTP＋synthetic HTML 重現 /demo 直接以 200 提供 /demo/ 掛載的 index，導致 ./asset.js 被解析成 /asset.js 而 404；/demo/ 則正確。只對 slashless configured mount root，在原本 realpath containment 與 index isFile 通過後回 308，保留 query 並以 no-cache 避免永久不再驗證；不將不存在／越界 index 重新導向。Location 採 ./ 加原始 URL 最後一段 encoded path 與斜線，避免 Host 衍生絕對網址、// 或 colon 變成外站 reference，保留 encoded slash/backslash 文字；GET/HEAD 無 body，沿用 nosniff 與 mount CORS。後續 canonical 請求仍走原有 encoding／validator 流程，預設 root及一般檔案不變，不新增目錄 listing／SPA fallback／任意 directory redirect。測試只使用本機 HTTP 與 public synthetic 檔案，沒有真實瀏覽器或外部站點請求。


118. **metrics provider 的未知拒絕值（2026-10-13）：** exported createStageServer 的 metrics callback 可同步拋出或非同步拒絕任意值；隔離 child＋native localhost HTTP probe 證實 null-prototype 物件或 throwing toString 讓 rejection handler 的 String(err) 自己拋錯，兩個共用 scrape 各產生 unhandled rejection 且未回應，下一次 collection 卻已恢復。只移除 metrics error 欄位的預先字串化，將原始 unknown 值交給既有 safe structured logger；empty 500、auth、singleflight 與失敗後取新樣本語意不變。Error log 欄位成為結構化診斷，nested secret key 沿用 redaction，不把細節放入 response。不宣稱內建 collector 已產生此值、外部攻擊事件或修復任意 custom logger/sink 拋錯；其他 error path 不擴張修改。測試採 synthetic diagnostics／本機 HTTP／明確 deadline，不讀真實秘密或啟動音訊。


119. **Web Component 的本機收聽滑桿（2026-10-13）：** widget 已有 playback-volume property／attribute，但使用者原本只能按收聽靜音。新增有明確 label 的 native range（0–100、step 1）與可見百分比／aria-valuetext，沿用 reflected property 調整本機 volume；已加入者在 reconnect 期間仍可調整，不參與 server control pending lock。無 current participant 或 detached widget 的 input 不接納，非有限／越界的防禦性 input 不改偏好；mute／microphone／server gain 不受影響。外部精細 fraction 保留原 property，UI 只顯示最近整數百分比；property 變更只同步 volume UI，不重畫 status live region 或清除其他 action error。沿用既有 rejoin/remount 偏好，不新增 storage、timer、autoplay 呼叫或權限。新增 part(playback) 讓 host 調整這一列樣式；驗證為假 DOM／SDK 控制事件，不宣稱真實 keyboard、layout 或輔助科技測試。


120. **最小嵌入範例的舉手角色限制（2026-10-13）：** actual Hub 自動繼任快照可合法包含台下主控（其他發言席仍保留）；whole embed fixture 證實舊按鈕對此身分開放 raiseHand，Hub 卻以 conflict 拒絕，原有 audience 冷卻 timer 也會繼續跑完再啟用無效操作。只將 syncHand 的 admission／remaining 共用台下非主控 predicate，promotion 當下取消倒數，程式化 onclick 仍先同步 policy 再決定是否呼叫 SDK。保留 audience 收回舉手在 cooldown 中可用、pending／reconnect gates 與原本 promise settlement；角色恢復後依既有 cooldown 重新排程。不新增主控管理／返回舞台 UI，不改 SDK／Hub 政策。驗證結合實際 Hub snapshot 與 fake DOM/library／受控時鐘，不宣稱真實瀏覽器操作或音訊測試。


121. **最小嵌入範例的麥克風靜音（2026-10-13）：** embed 的觀眾獲准上台後，SDK 依既有流程擷取麥克風，但原頁面只有 audio 本機收聽控制，沒有個人上行靜音操作。新增只對台上者顯示的 native button，沿用 mute／unmute，文字與 aria-pressed 依 authoritative me.muted／forceMuted；固定 aria-label 表達麥克風靜音，pending 以 aria-busy 標示。重連、強制靜音、無當前台位與待回覆均禁止 UI admission，handler 同步重查，不能藉改 disabled 或直接呼叫隱藏按鈕觸發動作。快照早於 ACK 時只更新呈現，不解除 pending；leave／終止／新加入撤銷舊 operation 的 error/finally 權限。保留伺服器拒絕與當前錯誤重試，不樂觀更新 muted，不新增 capture、權限要求、mic retry、計時器或 SDK／Hub 政策。測試範圍為 whole-module 假 DOM／受控 SDK 與既有實際 SDK 假媒體，不宣稱真實硬體或原生鍵盤驗收。


122. **停用 metrics 時不啟動程序延遲取樣（2026-10-13）：** CLI 原本無條件呼叫 processSamples，即使 server.metrics.enabled 為 false、HTTP 不使用 provider，仍 enable 10ms resolution 的 native event-loop histogram。以 exact CLI wiring／processSamples source 和 inert server／transport 作有界 probe，300ms 觀察中舊 disabled 路徑有 1 個 histogram／29 筆 samples，條件初始化後為 0／0；enabled 兩版仍為 1／29 且第一次 scrape 前即取樣。只在 CLI 依啟動設定決定是否建立取樣器，保留 enabled since-start 語意、原 provider、HTTP 關閉／授權政策、其他 counters 與正常停機，不改 processSamples 公開介面或新增動態設定。此證據只表示省去停用功能的 native 取樣，不宣稱 CPU、RSS、耗電或音訊效能提升。


123. **程序錯誤事件安全診斷（2026-10-13）：** exact production handler tail 的 inert VM probe 重現 unhandledRejection 收到 null-prototype value 時，原 String(reason) 在 log 前拋錯；uncaughtException 的 Error.stack getter 拋錯時，原診斷讀取甚至跳過 stop。兩個事件只改成將原始 error value 交給既有安全結構化 logger，沿用 getter／coercion 防護與 nested redaction；一般 Error 由 logger 呈現 name/message/stack。保留 rejection 只記錄、exception 呼叫 stop(...,1)、併發停機只執行一次及非零優先序，不註冊新事件或改全域失敗政策。測試使用 synthetic rejection 與 VM process／真實 logger 的受控 sink，不對真實程序送 signal、exit 或製造未處理 rejection；自訂 logger／sink 自身失敗及永不 settle 的 close 仍不在保證範圍。


124. **信令拒絕值不升級為房間失敗（2026-10-13）：** actual StageHub／MockMediaTransport probe 在 negotiate 建立部分 peer 後 reject null-prototype object，原 signal catch 的 String(err) 拋出 TypeError，handle 遂回 internal 並關閉整個房間，違反信令失敗應只影響該請求的契約。只將 SDP 與 remote ICE 兩個預期錯誤 catch 的診斷改為原始值交給安全 logger，仍回既有 generic bad_request；offer 失敗保留 negotiation token／participant／closed guard 的 peer cleanup，ICE 失敗不新增 peer 清理。不改 transport implementation、媒體／角色政策、serial queue 或真正 unexpected invariant failure 關房規則；任意自訂 logger 自身拋錯仍不在保證範圍。回歸以同步 throw／非同步 reject、一般及 hostile synthetic values 測試其他 peer／room survival、部分 peer 清理、後續恢復與舊 offer ownership，不宣稱真實 WebRTC 驗證。


125. **WebSocket 錯誤診斷不阻斷清理（2026-10-13）：** exact queue-error callback 的 VM probe 重現 null-prototype rejection 在 String(error) 拋錯，連 log 與 session.terminate 都未執行，會破壞停止佇列後終止連線的保證。只將 message-handler、detach 與 active-work-cleanup 三個錯誤 sink 改成原始值交給安全 logger，保留 session termination 及先 detach、等待 active work、再 detach 的兩階段順序。不改 static／TLS／一般 ws error 診斷，不更動入站上限、訊息排序或回座 ownership；自訂 logger／sink 拋錯不在本修正保證範圍。有界 native WebSocket regression 注入 mock Hub 失敗，驗證 hostile 與一般值、等待工作清除、正常終止及 post-drain 清理；無真實音訊或外部流量。


126. **最小嵌入範例的個人舞台操作（2026-10-13）：** embed 已提供上台後麥克風靜音，但原頁面無法自行下台而留房收聽。新增單一 native action button：台上者使用既有 leaveStage；台下主控使用既有 returnToStage；其他台下觀眾隱藏並沿用 hand 流程。依快照而非 ACK 樂觀切換文字／資格，獨立 pendingStage 防止重複請求，重連禁止操作，強制靜音仍允許下台。micClient 改名 controlsClient，共用新加入／leave／終止之前撤銷的 client eligibility；舊請求晚到 error/finally 不影響替換 client。保留主控保有控制權與額外席位、伺服器 capacity／error 政策及 SDK 下台 capture cleanup，無新增 timer／權限／自動 retry；返回舞台仍可能依原 SDK 流程要求麥克風。測試含 whole-module 假 DOM、實際 Hub snapshot 與 SDK 假媒體的 cleanup，不宣稱原生瀏覽器或硬體驗收。


127. **最小嵌入範例的明確麥克風重試（2026-10-13）：** 已上台者發生 micerror 原本只得到文字，必須離房或改變台位才有重新擷取途徑。新增 failed-participant-only 重試按鈕，沿用 retryMicrophone boolean admission；目前 client／controlsClient、同一 participant、onStage、live、未 pending 才接納，強制靜音不自動解除也不阻止使用者準備擷取。同步先保留 operation token，false／throw 只復原仍由該 token 擁有的 UI，micready／micerror／離房同步 reentry 優先。micready 清掉 pending 並只呈現「已取得麥克風」，不當作 sender install／SDP／真正發聲成功；後續 current error 仍顯示。micerror 與 micready listener 增加 current-client／controlsClient guard，退休 client 不能重建重試狀態；下台、participant 替換、離房、終止與重加清除，普通同席重連保留失敗／pending 狀態但暫停 admission。無自動 retry、新 capture API、SDK／Hub 政策或背景 timer。測試以 whole embed、實際 SDK 與 fake permission/track promises 驗證，原生權限 UI 與硬體音訊仍未驗收。


128. **完整範例主動離房的初次等待回報（2026-10-13）：** actual SDK／whole sample fake-socket probe 證實 create 與 join 在 room:state 早於 ACK 時，使用者可正常按離開房間，但 SDK disconnect 拒絕尚未完成的初次請求後，舊 runLanding catch 又顯示「連線已中斷。」；沒有 SDK error event。只在明確離房 action 呼叫 disconnect 前退休當前 landingEntry 的 feedback，沿用既有 cancelled 判斷阻止舊錯誤及 create continuation；不提早釋放 shared busy lock，不改 SDK／伺服器操作。普通建立／加入失敗、關房／被踢的既有診斷及其他 error listener 保留。測試驗證 state-before-ACK、主動離房、下一次失敗／重試與晚到 settlement；fake DOM／socket／media 不代表真實瀏覽器音訊驗收。


129. **重複麥克風控制的無變動快照（2026-10-13）：** bounded actual Hub／MockMedia probe 在 301 席、20 人舉手時，重複已生效的 mic mute／force mute／相同 gain 仍各產生 301 份、約 1.4 MB 的相同 room:state。只針對五種 mic command 比較將被設定的 selfMuted／forceMuted／gainDb 原值，仍執行各 Room method 既有的權限、台位、強制鎖與 invariant 檢查（setGain 本來沒有額外 invariant 掃描）；gain mixer setter 保留。確定底層值未變才略過全房 apply，發起者仍收到個人化 snapshot 然後 ACK，已有 coalesced state timer 不取消、不重排。空 events 不等於 no-op：selfMuted 在 force lock 下改變及 self mute 下 forceMuted 改變均走原完整廣播。真正變動、錯誤、stale session admission、私人欄位與媒體政策不變。同一 301 席／20 人舉手 fixture 的重複 mute：baseline 301 份／1,363,087 JSON UTF-8 bytes，候選 1 份／60,617 bytes，省去 1,302,470 bytes 的重複快照；僅計 snapshot payload，不含 WebSocket framing／ACK。測試以 bounded mock recipients 計數及序列化位元組比較，不宣稱實際網路、音訊容量、CPU 或延遲改善。


130. **最小嵌入範例的初次取消連線（2026-10-13）：** 原本 library import、hello、join ACK 等待時 submit 已 busy、Leave 尚未開放，只能等待逾時或離開頁面。新增 native「取消連線」按鈕，只在初次請求 pending 且未觀察到任何房間快照時可用；status callback 也檢查 SDK 已安裝的 state，避免 state event 前的重入開放取消。以 entry-owned closure 及取消旗標在 disconnect 前同步退休 feedback／controls，立刻開放明確手動重試；舊下載、connect、join、事件或 finally 不能接續舊操作或覆寫新 UI。actual SDK terminal 在 await disconnect 後才 emit closed／kicked，若同步 disconnected listener 已建立新 entry，舊 terminal listener 另以 generation 判斷退休，避免抹掉新等待或取消結果。已收到 state、ACK-only 完成、失敗或 terminal 後隱藏，不新增自動 retry、timer、SDK API 或媒體要求。取消僅結束本機操作意圖，不能保證取消 module 下載／底層 socket 關閉／伺服器已接受動作；cleanup 自身真正失敗仍可在同一取消世代顯示。測試使用 whole module／actual SDK 配合 fake socket、media、DOM，未宣稱原生鍵盤／瀏覽器權限與實際音訊驗收。


131. **最小嵌入範例的個人舉手位置（2026-10-13）：** embed 沒有完整參與者／舉手清單，觀眾舉手後原本只有「收回舉手」。只在台下非主控且 handRaised 時，從 SDK 當前 state.hands 依自身 participantId 找第一個位置，附加「佇列第 N 位」；同席重連顯示「上次」，缺席時保留原文字，防禦性重複資料取第一筆。不顯示他人名稱／代碼、推估等待時間或保證核准順序；withdraw 行為、pending／role／reconnect gates、aria-busy、錯誤與 status 區域不變，不新增 timer／API／storage。測試以 authoritative Hub／actual SDK 與 fake DOM 驗證，並非原生鍵盤／輔助科技或硬體音訊驗收。


132. **可選停用房間麥克風音量計（2026-10-13）：** actual SDK fake-media probe 證實未讀 micLevel 的 room capture／device replacement 仍各建立並 resume AudioContext、source、analyser 與 2048 個 float sample（8192 bytes），清理正常、並非 leak。直接改 lazy 會改變既有 capture 失敗／activation 時機，因此新增明確 opt-out enableMicMeter:boolean，預設 true 完整保留舊行為；建構前驗證型別並複製，不提供動態切換。false 略過兩個 room meter 建立點，初次擷取另在原 cleanup/catch 內拒絕沒有 audio track 的串流（裝置替換已有此檢查），避免移除 meter 連帶移除有效擷取檢查；預設模式的 meter failure timing 不變。micLevel 回 0，既有 capture、micready、sender／mute／revision／candidate disposal 流程不變；明確 startMicTest 仍 eager 建立獨立 meter／回報失敗。最小 embed 明確使用 false（沒有音量表），完整範例／widget 不變。測試 pin 預設 failure timing 並檢查 opt-out capture／replacement／retry／rejoin 不配置 graph、preview 獨立及串流所有權。資源避免以受控 constructor／node counts 證明，不宣稱 native CPU／電力／音訊延遲或硬體驗收。


133. **同步 callback 中的靜音音量讀值（2026-10-13）：** actual SDK／fake analyser probe 重現初次已靜音擷取的 micready callback，或既有發言者收到靜音的 state callback，me.muted 已 true 但實際 track.enabled 尚未同步，舊 micLevel 仍回 0.25，違反文件的 muted→0 契約。getter 現先檢查目前 me.onStage／muted，再保留實際 track.enabled gate；不在未上台／靜音時讀 analyser。沒有重排 event、capture、replaceTrack 或伺服器轉送政策，unmuted 但尚未 enable 的音軌仍回 0，獨立預覽 level 與 enableMicMeter:false 契約不變。驗證為公開同步 callbacks 配合受控媒體，僅證明本機 RMS getter，不宣稱曾有或修復網路音訊外洩。


134. **重複麥克風控制的原生連線契約驗證（2026-10-13）：** 決策 129 已用 actual Hub／mock recipients 驗證 requester-only no-op，但仍缺 SDK event 與真正序列化後的 ACK 順序覆蓋。新增 test-only 三個公開 StageClient／native loopback WebSocket 整合，檢查五個 command 的 requester state→ACK→Promise、其他連線無多餘 state、hidden self／force flag 變動仍廣播、私人欄位與 gain 正規化、peer／mixer 身分不變。觀察者負向斷言在 requester ACK 後逐連線使用唯一 ping／pong 屏障，避免 sleep 掩蓋晚到訊息。既有子程序 fixture 的 opt-in 控制 ACK 暫存用來驗證逾時後容量釋放、舊 ACK 不解鎖新請求與正常錯誤恢復；所有等待與 owned-child teardown 有期限。不改 production、SDK／Hub 政策或 media implementation；使用 fake browser media 與 MockMediaTransport，不宣稱真實 ICE、硬體音訊、吞吐或延遲改善。


135. **Web Component 的主控返回舞台（2026-10-13）：** actual Hub 自動繼任／八個保留發言席的快照，經實際 SDK receive 送入 widget 後，台下主控原本沒有舉手、麥克風或舞台操作；既有 SDK returnToStage 卻可合法使用主控額外席位。只重用個人 stage 按鈕，台上呼叫 leaveStage，台下主控呼叫 returnToStage，其他台下觀眾隱藏／停用。action 同步重查目前 client／participant／onStage／role／reconnecting 與掛載狀態，避免轉送事件先於 render 時舊 enabled 按鈕誤送操作；沿用同一 pending lock，state-before-ACK 只改文字不解鎖。強制靜音仍可下台，伺服器權限／容量／錯誤與 SDK capture cleanup／重新擷取不變，未新增管理介面、自動 retry 或權限 API。測試以 actual Hub／SDK 加假 DOM／socket／media 驗證，不宣稱 native keyboard／輔助科技或真實麥克風音訊驗收。


136. **品質統計拒絕值的 publisher 隔離（2026-10-13）：** actual Hub／MockMediaTransport／createLogger 的受控 timer probe 證實單一 getStats 拒絕 null-prototype value 時，reportQuality 在 log 前的 String(reason) 拋錯，整輪 healthy publisher 品質訊息被跳過；如果 healthy publisher 排在前面，其 uplink baseline 已前進卻未交付該區間資料。一般 Error／string 拒絕沒有這個問題，poll 仍排下一輪且房間／媒體存活。只把該失敗 publisher 的診斷改成 raw reason 交給既有安全 logger，保留 allSettled、generation guard、差量計算、recipient policy 與每房單一 timer；不擴張 outer catch 或任意自訂 sink 失敗的保證。回歸涵蓋同步／非同步失敗、publisher 順序、當輪 healthy loss／後續恢復、私人回報對象與既有 media identity；使用 mock transport／受控 PCM，不宣稱真實 WebRTC 或硬體音訊驗收。


137. **房間麥克風自然結束的明確恢復（2026-10-13）：** 公開 SDK／EventTarget 假音軌 probe 證實自然 ended 後仍保留 mic 與 sendrecv，沒有 micerror 且 retryMicrophone=false；已 ended 的初次擷取與 pending 裝置候選也可能被誤當成功。依 W3C Media Capture 的 ended／stop 差異（https://www.w3.org/TR/mediacapture-streams/#life-cycle-and-media-flow），只對目前 room stream／peer／capture revision 綁定 listener，先退休自身 ownership／meter、設定失敗，再排既有媒體同步與 micerror，允許 callback 明確重試；不猜測原生失敗原因，不自動呼叫 getUserMedia。自然結束不使用 stopRoomMic／不遞增 captureRevision，以保留使用者已在進行的健康裝置替換；成功替換重設 latch 並在 micready 前移交 listener。初次與候選軌道檢查 readyState，候選在 replaceTrack 完成／拒絕前結束時不取代健康舊 mic，後續同步恢復目前串流或 recvonly。正常 swap／下台／斷線先移除舊 listener，retired event 不影響新串流。保留 per-peer failure policy、既有 peer 重建擷取與 preview 共用 micready 邊界，不宣稱取消 browser promise、真實硬體移除／權限撤銷或 WebRTC 音訊驗收。


138. **完整範例重用相同房間畫面（2026-10-13）：** no-op mic 控制仍保留 requester 的權威 state-before-ACK，因此前端原本會為內容完全相同的新快照重新建出所有參與者列。只在完整 state、有效 fallback code、speaking／quality 與 client.status 的序列化 key 相同，且已渲染 gain input 未偏離權威值時略過主內容重建；仍執行 room identity／offstage retry reset、status、updateCooldown／pending gates 與 renderNotices。dirty gain 明確走 miss，以保留原本每次快照重設未確認拖曳值的行為，不新增 input handler。真正狀態變更完整重建，landing 清除單一 signature 與目前 gain 參照；事件 handlers 擷取所需 scalar，避免重用節點後，外部修改舊快照物件改變目前操作。speaking／quality 現有索引更新與冷卻 timer 政策保留。bounded fake-DOM probe：301 席 × 10 次 fresh identical snapshot，21,630→2,163 createElement、10→1 content replacement、3,010→301 constructed rows；一次 dirty gain 則共兩次 rebuild，值 7 回復 0。加入 20 筆舉手重複列時 clean 為 23,420→2,342 creations。代價為每次 O(B) 序列化／比較與一份 O(B) key，例子為 52,624／56,033 UTF-16 code units；命中另比較 O(G) gain 值（此例 8 個），不是快照歷史，也不寫 storage／log。只主張合成 DOM 操作減少，不宣稱瀏覽器 CPU／RSS／focus／延遲或音訊改善。


139. **Web Component 的明確麥克風重試（2026-10-13）：** actual widget／SDK 配合 fake socket/media 重現權限拒絕與自然 ended 後只剩靜音／下台操作，而公開 retryMicrophone 可保留 client／peer／席位恢復擷取。新增獨立 native retry button，不用一般 Promise action helper，因 boolean admission 會早於 permission promise 完成。以 current client、roomId、participantId 與 failure record identity 維護資格／pending，呼叫前先保留 attempt；false／throw 只在仍持有該 attempt 時復原，不覆蓋同步 callback 已建立的新失敗／新房間。error revision 讓擷取 ready／接納只清除自己擁有的舊 micerror，保留較新的 generic error；mic lifecycle 先同步資格再 forward stage-*，避免 callback 重入使用舊按鈕。台上 muted／forceMuted 可明確準備擷取，重連停用但保留同席 pending，下台／participant 或 room 替換／disconnect／terminal／移除清除；無自動提示、SDK API、裝置切換、timer 或伺服器變更。micready 仍是共用擷取事件（包括公開 preview），早於 sender 安裝；按鈕結束等待不是已協商／發聲證明，generic install failure 仍正常回報。測試使用既有 widget DOM 與 actual SDK fake-media 邊界，未驗收原生鍵盤／輔助科技、權限提示、硬體或實際語音。


140. **主控的本機觀眾名稱篩選（2026-10-13）：** actual Room／whole sample fixture 在 301 席有 292 個觀眾列、584 個移交／踢人按鈕，原頁面無名單縮小控制。新增主內容之外的固定 native search toolbar，只在 controller 且 snapshot 確實帶 audience 時顯示；query 留在 input／記憶體，trim＋toLowerCase 後 literal includes 已 decodeName 的顯示名稱，保留順序／重名，不搜尋 ID 或私人欄位。輸入只 toggle 已渲染 audience rows.hidden；保留 personRows 索引，因此被篩掉的副本仍接收 speaking／quality，hand／speaker 列不受影響。清除不經 run，不抹掉其他錯誤。每次快照在 cache hit／重建後同步權限與篩選，同室同人保留query；身份／room 改變、角色或 audience 欄位失去、landing 時清空query與舊列參照。既有全域 hidden CSS 足夠，無新增timer／server／SDK／storage。觀眾移交／踢人增加窄的 roomButton admission callback，要求列仍 connected／可見、目前 controller 且目標仍在目前授權 audience，confirm 返回後再驗；pending map／reconnect gate與其他kind操作保持原流程。這是本機呈現篩選，不代表伺服器 permission policy 或聲音容量變化；固定toolbar避免主內容重建時移動搜尋input，fake DOM identity／操作數仍不等於native focus、IME、accessibility、CPU或延遲驗收。


141. **觀眾篩選的 Unicode 正規等價（2026-10-13）：** actual sanitizeName 會把分解形式 Cafe\u0301 存成 NFC Café，但完整範例原 query 只 trim／toLowerCase，使用者輸入原本同一名稱卻找不到。只在 query 與 decodeName 後的觀眾名稱 key 加 NFC，再沿用原 lowercase／literal includes；不改 input 原文字、快照、顯示名稱、伺服器驗證或名單順序。NFC 只處理正規等價，不新增 NFKC、重音移除或語言特定大小寫折疊，重音／全形等非正規等價差異仍保留。回歸以實際 sanitizer／decoder 與 whole-module 假 DOM 驗證 Latin／Hangul、組合順序、原有中文／大小寫／空白及生命週期；既有權限、hidden-row admission、cache 與記憶體 query 政策不變，不宣稱原生 IME／鍵盤／輔助科技驗收。


142. **Web Component 的明確離房與手動重入（2026-10-13）：** actual mounted widget／SDK fake socket/media probe 證實已進房者只有收聽靜音、麥克風與離開舞台，無法從 widget 本身結束整個房間連線；公開 disconnect 可完整清理，但之後也沒有 UI 重入。新增獨立 room action，已取得 state/me 的任何角色（含重連、state-before-ACK）可主動離房，先遞增 generation、退休 current，再沿用既有 teardown。獨立 leftRoom 與 cleanup token 保留明確意圖，pending 時停用，settlement 僅能更新同一 token；同一元素改屬性／移除重掛也不自動進房，cleanup barrier 保留，明確重新加入才清除 left flag 並使用最新 attrs／偏好。新元素正常 autojoin，初次取消／失敗 retry、terminal／kicked、直接 SDK disconnect 保持既有資格。退休 client 的 SDK 事件不轉送，與原元件 teardown 一致，不合成新 status；舊控制／capture／初次 join 回覆不能覆蓋離房或新 client。伺服器既有主控寬限／席位政策不變，fresh join 不保證舊身分或台位，不宣稱立即 socket 關閉／房間結束。測試限定 actual SDK 與 fake DOM/socket/media 邊界。


143. **WebSocket upgrade target 解析隔離（2026-10-13）：** bounded native localhost raw HTTP upgrade 證實 URL parser 拒絕的 request target 可在 upgrade listener 直接拋出 TypeError，超出 request 邊界；CLI 的既有 uncaughtException policy 會啟動 fatal shutdown。只在原 new URL(...).pathname 周圍加 try/catch，失敗回固定空 HTTP 400／Connection: close／Content-Length: 0，再關閉該 socket；upgrade 已脫離 Node HTTP error listener，而此路徑不進入 ws.handleUpgrade，故僅對拒絕 socket 加一次性 error→destroy 保護。不解析 IP、不配置 session／per-IP quota、不進入 Hub、不記錄 target/error。停機判斷仍在前，合法 target 的原 path/query、capacity、Origin／握手政策不變，不擴大 outer catch 或改全域 fatal policy。回歸使用 native localhost HTTP/WebSocket 與 actual Hub／MockMediaTransport，檢查既有房間／peer、後續有效升級與有界清理；不測已部署主機、不宣稱 native WebRTC／音訊驗收。


144. **最小嵌入範例的自訂信令路徑（2026-10-13）：** actual localhost server 配置 wsPath=/control 時可正常建立房間，但 embed 固定 /ws，收到503而無法使用既有配置。僅在最小頁面加 ws-path 欄位與 wsPath query 預填，預設／空白沿用 /ws；host/path 在同步 submit 擷取，舊 client cleanup 與 module import 等待期間編輯不改目前 attempt。先驗證 rooted same-origin path，再載入同 origin 的既有 /lib/stage-client.js；拒絕 //authority、scheme、反斜線、query/fragment、raw control、內部空白與普通／encoded-dot segment，URL origin 再驗一次。不自行 decode path 的百分比序列，Unicode 採標準 URL 序列化，伺服器維持 literal pathname 比對，不改發現、認證、Origin、SDK、server 或完整範例邀請網址政策。query 解碼一次，encoded delimiter 仍受同主機 path 邊界限制；沒有複製房間code/token到信令URL。現有 generation／取消／錯誤／重試流程保留。回歸以 whole-module 假 DOM 與 bounded native localhost StageHub／SDK 控制面驗證，媒體仍mock，不主張部署站台或原生瀏覽器音訊驗收。


145. **信令路徑設定的 HTTP literal pathname 檢查（2026-10-13）：** parseConfig／actual offline checker 原本只要求 leading slash，會接受 /ws?x、/a/../ws 等無法成為相同 parsed pathname 的設定；native localhost handshake 對原值與正規化目標均503，health/ready仍200，實際無session。保留既有 startsWith 檢查，再以固定 HTTP absolute prefix 加原值取得 URL.pathname，必須逐字相等；失敗只報 ConfigError 欄位，不回顯輸入，也不自動修正。不可用 relative URL 驗證：//other/ws、/// 雖普通origin-form不同，仍可透過 /.//other/ws 或absolute-form到達，native101已證明，因此保留這些既有可表達路徑。/%zz、%2F、encoded Unicode／space等可匹配字面值同樣不解碼／重寫；runtime upgrade／Origin／quota政策不變。設定與server共用當前Node URL語意，以標準 HTTP／WebSocket path 拼法為契約，不宣稱保留每種過往可達設定：非HTTP scheme的特殊target（例如foo URL）可能保留原始反斜線，但這類設定現在明確拒絕，runtime解析政策不擴張。不宣稱完整部署可用性或任意路徑都能由embed欄位表達。測試含 direct parser、source/built checker 的無副作用／安全診斷與 bounded native localhost 路徑對照；不讀寫使用者實際設定。


146. **完整範例的進房輸入錯誤指引（2026-10-13）：** whole sample／actual SDK 配合實際validator重現33字roomName可由64的input提交，但預設nameMaxLength32只回Bad request；自訂64的server同一輸入合法，hello又未公布此limit，不能硬改UI上限或猜定失敗欄位。只對目前runLanding擁有的create/join promise拒絕加可選UI formatter，Error.code為bad_request且仍是同一landing revision／entry、尚未entered或取得state時保留原message與code，再加中文檢查輸入／server規則的指引，不回顯使用者欄位或假設精確長度。其他code／非Error／generic SDK event維持原行為，原error物件不修改；既有reportError/cancelled guard先於formatter，sharedlock/finally及state-before-ACK離房退休不變；state／terminal／同步error listener造成landing重建後，只撤銷新增指引，不擴大一般錯誤抑制。不改HTML maxlength、servervalidator、協定或media錯誤。測試以實際validator／SDK與fake socket/DOM驗證event-before-async-catch及生命週期，不宣稱原生輸入法／maxlength／硬體驗收。


147. **完整範例的同主機自訂信令路徑（2026-10-13）：** actual server /control 可供應sample／readyz且直接建立房間，但完整main.ts即使帶wsPath query仍固定/ws，actual SDK/native localhost join收到503。新增page-load query選擇，維持單一SDK與原生命週期；缺省／空白/ws，與embed一致拒絕authority、raw控制／反斜線／query／fragment、內部空白與普通／encoded dot segments。驗證後同origin再轉ws/wss，安全百分比序列保留、Unicode正常序列化。無效值不使整頁初始化中斷：SDK只取得安全placeholder URL，runLanding在create/join前以固定訊息拒絕，沒有fallback連線或自動發現端點。邀請只allowlist原room/code與已驗證非預設pathname，不複製其他query/hash。相鄰實證顯示server可供應//invite-destination.invalid/頁面，而原relative URL constructor會把pathname當authority後附帶房間code；改從目前origin建立URL再設定pathname，避免變成外站邀請，不修改server路由。測試以whole sample fake DOM、actual SDK與bounded native localhost／MockMediaTransport驗證create→invite→join與生命週期；不宣稱nativebrowser、實際媒體或部署站台驗收，不改Vite代理或SDK API。


148. **已套用 overlay 與房間重用 key 分離（2026-10-13）：** 現有speaking／quality事件已逐列就地更新，但完整combined signature仍停在上次room render，因此下一個完全相同的新快照又重建。先以scratch prototype跑90個既有回歸，再把structural[state,roomCode,status]與rendered speaking／quality signature分開；每個overlay handler只在自己的DOM更新迴圈完成後記錄相應key，speaking採實際套用的去重detail IDs，不盲信可被呼叫者改動的SDK Set。room render仍比較當前三種輸入，故漏事件／共用quality object mutation／另一種overlay偷偷改動仍造成cache miss，dirty slider也保留原authoritative重設。landing清除三key，角色／身分／狀態／code變更與pending／冷卻／notice／filter更新順序不變。100席×100個speaking+quality後相同snapshot的bounded假DOM工作量，原100次重建／75,701個新節點降成0次重建／1個warning badge；新增每event小型overlay序列化，沒有把full room序列化移入overlay事件，也無unbounded cache。只主張合成操作數，不主張瀏覽器CPU／layout／memory／音訊提升；不為無實際callback邊界的DOM monkeypatch重入加入production token。


149. **最小嵌入範例的整筆送出快照（2026-10-13）：** whole-module bounded probe在previous disconnect、module import與connect三個等待點修改五欄，原實作仍使用已擷取的舊host/path，卻在join時讀入新room/code/name。把join options與既有host/path在同步submit起點一起擷取；之後current.join只使用該attempt物件，保留原roomId/name/code trim與空白code undefined，不增加localStorage、diagnostic或URL欄位。輸入仍可編輯供下一次明確送出，既有取消／generation／terminal／state-before-ACK流程不變，不自動重試。這延伸原本host/path-only快照契約，修正無意的跨attempt payload混用；所選主機模組本來就在頁面執行且可讀DOM，不能把它宣稱為隔離惡意host的安全邊界。回歸以whole embed及actual SDK fake socket確認送出目的地與payload，只有syntheticcode、不接觸實際憑證或外部主機。


150. **完整範例的個人舉手位置提示（2026-10-13）：** whole sample probe中四個同名hands，自己ID排第三時只能看到完整佇列的「我」badge，個人區只有收回按鈕；status-only reconnect也沒有位置的新舊提示。新增單一重用role=status段落，從目前state.hands以me.participantId找第一個相符ID；僅offstage非controller且handRaised顯示（與既有embed/widget防禦性predicate一致），找不到自己只保留等待邀請訊息。updateCooldown同步更新此段落，使state／status-only reconnect／cache hit都使用目前資料；重連明示上次，landing清空，升台／主控／撤手隱藏，無timer或server request。保持原withdraw label／roomAction pending與所有permission policy，不把hand位置當邀請順序保證。實際Room證明hands對所有角色相同、code/audience仍controller-only，主控可越過前兩位先邀第三位；新增UI只顯示自己序位，不複製他人名字或私密欄位。驗證以whole-module fake DOM與模型／Hub快照為界，沒有原生assistive technology／語音驗收聲明。


151. **SDK disconnect 文件的席位寬限契約校正（2026-10-13）：** bounded整合文件／built artifacts審查發現client README舊連線段落聲稱disconnect立即讓位，漏掉Hub一直存在的controller例外。client README與root README同時明示此例外，只改文件：本機完成不等於server收到close，收到正常1000後noncontroller不進participant grace；controller仍照controllerGraceMs等待再沿原繼任／關房政策處理。pagehide4002也明示依角色寬限設定，不保證無條件回座。既有Hub departure／kick／close三個focused tests與額外in-memory角色probe確認：kick先移除／解除binding，不因後續detach復活grace；roomclose清理room／media／timers。另以NodeNext與Bundler消費built package declarations、核對widget SDK identity／aliases與八個compressed artifact byte roundtrip均通過，未發現其他具體mismatch。沒有runtime／SDK API／server policy或nativebrowser／media驗收變更。


152. **新加入／恢復信令連線的說話指示基準（2026-10-13）：** actual Hub、RoomMixer 與 public SDK 的 bounded in-memory socket probe 顯示：新觀眾在持續說話期間加入，25 個 active PCM tick 仍收不到 speaking；原觀眾斷線時漏掉釋放至空集合，恢復同一身分後25個silent tick仍保留舊指示。Hub 每房只保留一份獨立複製的最新 mixer full set，在原變動廣播前更新；成功create／join／resume於room state之後、ACK之前針對該session送出目前集合，空集合也送，既有觀眾不因加入而額外收到speaking。送出時以目前participant、onStage、self/force mute與publisher身分過濾，保留grace期間仍publish的disconnected席位，不把connected誤當media可用性；每次snapshot獨立陣列，closed callback不再更新，關房清空。沒有新增timer、週期廣播、protocol欄位或SDK／mixer／transport行為。驗證以受控PCM、真實model/mixer/SDK與mock transport為界，不代表native browser、ICE、麥克風或實際可聽音訊驗收。


153. **Widget 舉手／麥克風控制的同步准入（2026-10-13）：** unchanged element fixture上的actual SDK／fake socket探針確認：stage-state先轉送再render，host listener此時點擊舊enabled控制，升台／轉主控後仍送hand:raise且消耗10秒SDK冷卻，下台／forceMute後仍送mic:mute/unmute；真正socket失聯的status callback雖未送wire，卻先清除舊錯誤、進入pending再以disconnected覆蓋。這不是server權限繞過，模型仍拒絕無效命令。僅為hand/mic加入private button的可選准入predicate，在pending／aria-busy／error變更前重查connected、目前me、舞台／角色、reconnecting、handRaised/cooldown及forceMuted；render共用相同predicate，隱藏控制也disabled。有效操作仍讀當前handRaised/muted，pending與generation處理不改，沒有擴大SDK admission／server政策或本機收聽限制。測試使用同步轉送回呼與actual SDK fake wire，不靠篡改disabled製造主要重現，不宣稱原生browser／assistive technology／media驗收。


154. **說話指示 SDK declaration 註解補正（2026-10-13）：** 第129批已同步root/client README與shared protocol說明，但StageEventMap.speaking的JSDoc仍保留「only when it changes」，會出現在產生的公開型別文件。補成成功create／join／resume的state後、ACK前先同步完整集合，其後依變動更新。只改此註解與決策紀錄，runtime／protocol／測試行為不變；驗證declaration帶入新契約、built JS與前版相同，再沿用完整測試／型別／建置驗證。


155. **SDK create／join 參數的操作快照（2026-10-13）：** 透過 public API 與 fake socket 的測試確認，join 原本保留呼叫端的 options 物件：已送出 A 房間與代碼後，若在 ACK 前把原物件改成 B，狀態仍是 A，但自動 resume 會送出 B 與原本 A 的席位 token；create 也會保存未曾送出的新 name。兩個方法在原有即時 controlCapacityError 檢查通過後、第一個 await 前淺層複製參數，讓 hello 等待、pacing 送出與 ACK 後的 session 安裝使用同一份值。下一次呼叫可取得新值，不凍結或修改呼叫端物件，也不新增儲存或診斷輸出。保留原有容量檢查優先序、revision 取消、重疊 create 的結果所有權、伺服器錯誤與主控權威代碼更新；不新增輸入驗證或跨房授權政策。受控測試檢查各等待階段、實際 SDK 序列化與回座 payload，不代表原生瀏覽器、ICE 或可聽音訊驗收。


156. **只改觀眾數的完整範例重用（2026-10-13）：** source audit 確認 audienceCount 除了完整 signature，只用於觀眾標題；非主控收到單純進出房人數更新時，原本仍重建整個房間內容。先以 scratch prototype 驗證後，僅把 audienceCount 從 structural key 分離，保留所有其他 enumerable 狀態欄位、有效房間代碼、連線狀態及既有 speaking／quality key。cache hit 按最新人數與上限更新標題；完整替換成功後才保存新標題參照，landing 清除。保留 dirty gain 強制重建、pending／冷卻／提示／filter 更新和原本 handler scalar captures；正常主控觀眾名單變更仍使 structural key 不同。9 位台上者、20 筆舉手、50 次人數快照的 whole-module 假 DOM 工作量，新增節點 6,800→0、參與者列 1,450→0、內容替換 50→0，兩版標題均正確 50/50。只主張受控操作數；每次仍淺拷貝與序列化其餘狀態，並非零配置或原生瀏覽器 CPU／焦點／延遲驗收。


157. **widget 播放解鎖的席位所有權（2026-10-13）：** 以實際 SDK 與受控 socket／RTC／audio 重現：已出現的啟用音訊按鈕在直接 disconnect、關房、被踢及 shutdown 後仍可點擊無來源 audio；pending rejection 也會覆蓋終止畫面。同一 public client 明確斷線後再 join，舊成功可隱藏新提示、舊失敗可污染新席位。只替 widget unlock 設置 client／room／participant 與操作 token，失去 state 時在轉送事件前撤銷；handler 在任何 pending／error 改動前檢查當前所有權，且同步呼叫 unlockAudio 保留使用者手勢。成功、錯誤與 finally 只作用於自己的操作，新 audioblocked 記錄避免舊成功清掉新提示。信令重連仍保留 state／媒體與操作，舞台或麥克風變動不撤銷收聽。SDK promise、媒體擷取與一般控制動作不變；受控遲到結果是生命週期防禦測試，不宣稱原生瀏覽器排序、權限繞過或音訊驗收。


158. **隱藏頁面的診斷輪詢暫停（2026-10-13）：** scratch whole-module prototype 證明 document.hidden 時原本仍保有 50ms meter 與 2 秒 getStats timer，10 秒受控工作量為 200 次音量讀取與 5 次統計要求。只在完整範例加入 visibility gate 與單一 page-lifetime listener，隱藏時取消兩個診斷 interval、歸零 meter／清除統計，回到可見時依當前狀態恢復 timer 並要求新統計。timer identity 防止舊 callback 在 hide／show 後重入，既有 poll sequence 與 room generation 防止晚到結果寫入；不取消底層 getStats promise 或重設 SDK delta baseline，恢復第一筆可能涵蓋隱藏時間。mic lifecycle cleanup 在 hidden 時照常執行，visibility 本身不停止預覽、擷取、播放或 session。listener 與既有頁面事件同壽命，不每次 join 註冊；landing 預覽仍需要它，無新增獨立卸載契約。prototype 30 個無 socket 假時鐘案例及既有 focused compatibility 通過，可見工作量不變、隱藏計數為 0／0；只主張操作數，原生瀏覽器已有背景節流，未量測 CPU／電池／音訊效果。


159. **上台權限提示的擷取完成清理（2026-10-13）：** whole-module 完整範例搭配實際 SDK／受控 socket／media 重現 invite→role→state→micready 後，既有 invitation 仍顯示「請允許麥克風權限」，甚至 sender 安裝與受控 answer 完成後亦然。只為該固定提示記錄 room／participant／room generation；目前同席且 onstage 的 micready 清掉仍屬於它的文字，之後的複製／換碼／終止／離台文字及 errorBox 不受影響。landing 和自己的 stageleft 撤銷所有權；不同房間／身分或 generation 不可用晚到事件清除既有提示。保留既有 micNotice／重試與 capture／publish 語意，預覽共用的 micready 不代表房內 sender 安裝或可聽音訊。受控驗證保留 micready 時 sender 尚未安裝的順序，並檢查後續安裝失敗仍可回報；不可變前版 source 對照驗證提示缺陷，不宣稱原生瀏覽器權限或可聽音訊驗收。


160. **共用 micready 公開契約釐清（2026-10-13）：** 事件 detail 為 undefined，SDK 有三個發出位置：初次／重試房間擷取在 sender 安裝前、使用中裝置替換在 replaceTrack 與串流接管後、獨立預覽不需要房間 sender。既有 retry／widget README 使用未限定流程的「早於 sender 安裝」可能被誤讀為通用順序，改為明確限定，並補公開 StageEventMap 的 JSDoc，提醒事件不是可聽傳送或特定公開操作完成的證明。只改文件／註解與本決策紀錄；檢查 generated declaration、三個來源及既有生命週期測試，建置 JS 需與前版逐 byte 相同，無 runtime 或事件順序變更。

161. **SDK 連線目的地建構快照（2026-10-14）：** 實際公開 SDK 搭配受控 WebSocket／時鐘重現：呼叫端重用 options 建立第二個 client 或改寫 url，會讓第一個 client 的自動重連讀取新網址，並把原先房間的 name／code／resumeToken 送往新端點。只在建構時保存 url 字串，所有 connect／resume 使用固定目的地；新的 client 仍讀取當次傳入的網址。保留原有 immediate options 驗證次序、WebSocket 建構時的網址驗證與拒絕時機、連線／重連／取消與 controller code refresh 邏輯，micConstraints 仍依既有方式於擷取時讀取。測試使用 synthetic 資料與 fake wire，不對外傳送憑證或宣稱原生瀏覽器／音訊驗證。

162. **Widget 主控鎖定靜音的原因提示（2026-10-14）：** 實際 Hub 狀態搭配公開 SDK／fake DOM 重現：台上自己靜音與主控強制靜音原本都顯示「台上（已靜音）」和「取消靜音」，後者只有按鈕停用，未說明原因。只依目前 snapshot 的 forceMuted 在台上狀態改顯示「台上（主控已鎖定靜音）」、mic 按鈕改為「麥克風已被主控靜音」；主控解除後依仍有效的 self-muted 狀態恢復原有文字。既有准入、pending、aria-pressed、事件與控制請求完全不變，不新增解除鎖定功能。測試覆蓋真實模型／SDK 的 self／force 組合與生命週期，屬受控 DOM／信令驗證，未宣稱原生瀏覽器或可聽音訊效果。

163. **完整範例目前控制節點參照（2026-10-14）：** 已有結構重用仍在每次 updateCooldown 以兩種 selector 搜尋所有內容子樹，再逐一同步 pending／重連／policy／hand cooldown。scratch prototype 以 Room 產生合法 301 席、20 hands、707 controls，100 次相同快照的 selector 200 次／fake candidate visits 468800 降為 0，aria-busy 和 disabled 仍各寫 70700 次。只在成功 replaceChildren 後收集目前 room actions 與 return-stage 參照，重建替換、landing 清空；不快取可用性、不跳過條件或修復寫入。pending resolve／reject 跨重建或換身分只同步目前控制，filter 隱藏列與共享 key 仍照常。多保留 O(目前控制數) 參照，無歷史快照／節點保留；合成操作數不代表原生 selector、CPU、layout 或記憶體量測。

164. **初次加入遭拒的本機操作指引（2026-10-14）：** validator→Hub→公開 SDK→UI 的合成資料驗證確認：缺少／錯誤房間代碼與不存在的房間均回相同 unauthorized／Cannot join room，完整範例原本只有原文，雖可再次送出但缺少輸入檢查方向。只在現有 runLanding 仍擁有的初次 join、尚未收到 room state 且 landing revision 未變時，保留原 message／code 並附「請確認房間 ID 與代碼，或向主控索取最新邀請連結。」不推斷哪個條件失敗，不改伺服器 indistinguishability、SDK error event 或准入。createRoom 的建立 token 拒絕亦可能為 unauthorized，因此不套用加入指引；取消／已進房／terminal／重建 landing 的舊結果與其他 code 沿用既有顯示。受控 fake DOM／wire 驗證，不外傳真實代碼或宣稱瀏覽器／音訊驗收。


165. **完整範例可展開的舞台品質明細（2026-10-14）：** bounded whole-module／Hub 審查確認健康品質回報原本沒有可見文字，差品質僅在非互動 badge 的 title 呈現數值。新增原生 details／summary 面板，沿用既有品質事件，僅主控或台上者可見；只保存目前房間／參與者且目前仍在台上的報告，複製 primitive 欄位，不保留事件物件別名。每筆報告替換前筆，省略或離台者移除；以目前安全解碼名稱和 textContent 呈現，數值缺失／非有限／不合法比例顯示破折號。有效更新重用列並保留 open，landing、身分改變或資格喪失清空並收合；重連清空資料但保留展開，重連期間不接納明細，恢復後等下一則事件。協定無時間戳／epoch，文案僅說最近收到，不能保證收集始於重連之後；RTT 不是端到端音訊延遲。沒有新 API、timer、polling、媒體或既有 badge policy 變更。測試以實際 Hub 收件政策與 whole-module fake DOM 為界，不宣稱原生鍵盤、輔助科技或音訊驗收。


166. **完整範例播放解鎖的跨通知 pending（2026-10-14）：** whole-module 與未替換公開 SDK 的受控 audio／socket probe 重現：第一次 unlock 的 play promise 未完成時，同席 room state 或上台邀請會重建 notices，新的按鈕恢復 enabled，再點可同時留下兩個 play promise。以目前房間 generation 綁定單一 symbol pending，建立每個提示按鈕時同步 disabled／aria-busy；handler 在 pending 或 error 改動前檢查目前節點、generation、room state、blocked 與 pending。維持手勢內同步 unlockAudio，只有自己的 finally 清 token 並更新目前提示，原有 run 保留 current error 與世代失效抑制；新身分重設 token，信令重連不撤銷仍存在的媒體操作。沒有改 SDK、autoplay policy 或自動重試；未把僅 synthetic event injection 的舊成功遮蔽新 notice 假設擴入修正。證據限受控 promise／DOM／信令，不能視為原生播放、權限或音訊驗收。


167. **完整範例初次進房等待文字（2026-10-14）：** actual SDK／fake wire 與 whole-sample DOM 確認 create、join 在 hello 及 ACK 等待時，頁首仍為「未連線」，只有停用／aria-busy submit 與取消按鈕表示進行中。替既有 landingEntry 增加 operation 與送出時 revision，syncLandingActions 更新獨立 role=status／aria-live=polite 段落，不改 header、errorBox 或 notices。僅尚未 cancelled／entered、沒有 client state 且仍 busy 的原 landing revision 顯示；不能只共用 canCancelLanding，因 pre-state reconnecting 後 error listener 同步 disconnect 會先重建 landing，舊 promise 尚未 finally 時 cancel 仍可見。較嚴格的 progress revision guard 避免誤示重啟，原取消准入與 request lock 不變。收到 state 前的 hello／ACK 不細分，取消／失敗／終止／重建清空，新的明確操作採新 owner；無 timer、額外請求或輸入內容回顯。受控 DOM 與 SDK 事件順序證據，不宣稱原生螢幕閱讀器或音訊驗收。


168. **獨立麥克風預覽的自然結束清理（2026-10-14）：** actual SDK 搭配 EventTarget track／受控 AudioContext 證明 preview natural ended 後原本保留 SDK 記錄、abort listener 與開啟 graph，後續 100 次 level 仍讀取 analyser；已 ended grant 或 meter construction 中結束亦可能發出 micready。只在 startMicTest 為取得的第一條 audio track 加入預覽專屬 ended cleanup，沿既有 idempotent stop 移除 listener、停止 graph／tracks 與自身記錄，不影響其他預覽或 room capture。保留先檢查 abort／revision 的次序，再於 meter 前後與 ready 前檢查 ended；setup 失敗以 promise 拒絕並清理，不發房間 micerror 或自動擷取。ready listener 內自然結束或直接 track.stop（不派發 ended）後，回傳已停止的 level-zero handle；取消／disconnect 仍沿原 promise 拒絕優先序。公開 shape 不變，沒有新完成事件；第一音軌假設與現有 getUserMedia／room capture 一致，不聲稱任意多軌串流支援。僅主張 graph／listener／ownership 清理與停止 analyser 呼叫，不主張仍被呼叫者保留之 handle 的 sample buffer GC、原生 CPU／硬體或可聽音訊效果。


169. **TLS 憑證監看目錄的原型名稱隔離（2026-10-14）：** parseConfig 接受的相對路徑 __proto__/cert.pem、constructor/cert.pem、toString/cert.pem，在真實 createStageServer 載入有效測試憑證後，原本因一般物件繼承屬性而於分組 .push 拋 TypeError。只將分組字典改為 Object.create(null)，保留 Object.entries 的既有數字鍵順序、同／不同目錄分組、filename 過濾、2 秒 debounce、reload 失敗保留 context、watch 失敗記錄與 shutdown 清理。這是可信設定路徑的啟動健全性修正，不主張遠端可利用性。原生 factory 測試以已安裝 werift helper 產生暫存 synthetic 憑證，僅建立／關閉，無 listen；受控 whole-factory 測試驗證 watcher／timer 語意。不新增依賴、不修改 TLS 政策或使用真實私鑰，不宣稱原生 TLS handshake、ACME 更新或部署驗收。


170. **可觀測的預覽停止狀態與完整範例退役（2026-10-14）：** 第168項已清理自然 ended 的 SDK 資源，但 actual SDK／whole sample 受控重現 UI 仍保留 handle，顯示停止測試與 aria-pressed=true，可見10秒繼續200次 meter DOM 寫入且必須兩次點擊才能重測；hidden 期間零 polling 仍正常，返回後卻重開無效 timer。MicTest 新增 optional readonly stopped，SDK public handle 恆以 getter 回報既有 stop latch；true 表示清理已開始，不承諾 AudioContext.close promise 完成。optional 保留舊 structural 實作者／mock 與 startMicTest 回傳型別，不用 level=0 判斷靜音或停止。sample 僅在 stopped===true 清 handle／重設按鈕，使用原有 syncMeter、可見50ms callback與換裝置 await 後同步；保留健康裝置替換、自動stage cleanup、取消／generation、hidden 與 callback token guard。無新事件、timer、權限提示或自動重試；測試涵蓋 callback 內結束、下一tick前重測、hidden後恢復及裝置等待結束，僅聲稱受控DOM工作量，不聲稱原生音訊／CPU。


171. **不離席的本人顯示名稱更新（2026-10-14）：** 原模型名稱不可改，沒有對應wire／SDK／UI操作；再次join會already_joined，合法resume保留原名，而widget name attribute會重入。新增participant:rename僅含requestId/name，validator沿用sanitizeName與設定長度，Room只更新綁定本人並檢查不變量，Hub保留queue/stale-session guard；改變時送既有personalized snapshots再ACK，同名只refresh requester且不消耗pending broadcast。無新name事件，以免曝光隱藏觀眾；ID/token/角色/台位/排序/mute/gain/媒體資料不變。SDK setName純既有request，state callback前複製decoded accepted-name與room/pid/revision，初次create/join以before-record界線接納後續新狀態，避免late ACK覆蓋pre-ACK改名或沿用舊entry；disconnect清紀錄，不以request continuation樂觀寫回。完整範例使用個人prompt與既有pending map，dialog前後核房間/世代/身分/重連，取消不送；同席redraw可繼續，異席不送。協定v1 additive，舊server unknown_type無自動離房fallback，widget attribute原語意保留。受控模型／SDK／DOM驗證不等同native prompt、硬體或音訊驗收；一般state仍執行既有媒體reconciliation，不宣稱零媒體方法呼叫。


172. **私人觀眾改名的必要收件者更新（2026-10-14）：** 第171項的全房snapshot對一般未舉手、未上台觀眾改名多數是冗餘：實際Room完整snapshot比較證實301席中的其他299人所有欄位逐byte不變。Room.rename與invariant仍先執行；僅role=audience、offstage、未舉手、無stateTimer且lastStatus等於目前room.status時，使用既有snapshot分別刷新本人及rt.sessions中的目前主控，ACK仍在本人state之後。主控離線不留新buffer，恢復時由正常snapshot取得名稱；其他changed場景保持原broadcastState，包含pending presence/hand的立即flush與status轉換，no-op仍不消耗timer。沒有新cache/event/periodicbroadcast或媒體層變更。受控301席/20hands profile（256MiB heap限額）stateframes301→2；1台上席bytes1319402→62426，9席1746570→63834，均不含ACK/framing/壓縮。兩次target snapshot使shared view構造1→2，但personal構造301→2；只主張JSON與工作計數，不推論CPU/網路容量/音訊效能。省略冗餘state也省略其他SDK接收callback與既有媒體同步觸發，不能稱所有可觀測callback數完全不變；正常目前狀態、隱私與requester ACK契約維持。


173. **嵌入頁明確更新本人名稱（2026-10-14）：** 第171項已有 SDK setName，但嵌入頁的名稱欄只在新加入時讀取，無法透過畫面留席改名。新增 form 外的 type=button 更新名稱，不改 join submit 選取與表單行為；僅當 controlsClient 對應目前快照時顯示，所有角色允許，重連與自有 pending 停用。點擊同步擷取原始字串，沿用伺服器驗證與 authoritative snapshot 顯示，不樂觀改名、不覆寫輸入草稿。pending 綁 client、entry generation、room/pid，狀態先於 ACK 不解鎖，同席重連保留；retireControls 在 disconnect 前撤銷，晚到 Promise 不覆蓋新操作。舊server錯誤正常保留，不以重新加入作fallback；不更改協定、SDK、server政策或媒體流程。受控DOM／SDK／Hub測試不代表原生鍵盤、輔助科技或硬體音訊驗收。


174. **主控留房更新房間名稱（2026-10-14）：** 原name僅constructor設定，room:rename/set-name/update均unknown_type；增加v1 additive room:rename{name}、既有sanitizeName/config長度與白名單。Room.renameRoom先requireController再比對與assign，changed/no-op均assertInvariants；Hub沿用room queue與stale binding，changed broadcastState更新所有可見標題並flushpending，noop僅requester snapshot且保留timer，兩者state先於ACK，無新event/name日誌或apply媒體操作。SDK setRoomName純request，無title cache或ACK回寫，初次entry晚ACK不覆蓋新snapshot。完整範例在room summary提供主控prompt，動作前檢查目前node，前後均核room/pid/generation/role/reconnecting，同席redraw可繼續；pending跨state-beforeACK，退役結果不影響新操作。邀請URL/code/席位/排序維持，server執行時授權覆蓋transfer/grace/succession競態；舊版錯誤無close/recreate fallback。名稱只以decodeName+textContent顯示，沒有額外client長度政策。驗證為受控模型/SDK/DOM與本機控制面，非原生prompt/AT/硬體音訊。


175. **名稱欄位採伺服器的 Unicode 長度契約（2026-10-14）：** 標準/source與實際sanitizeName證據：HTML maxlength計UTF-16 units，而server先NFC/去控制字元/trim再計codepoints；32個補充平面emoji與32組分解重音均64units但預設32下合法。移除完整範例create/join本人名與embed共享name三欄的32，以及create房名一欄的64；房名原64足以容納預設32個emoji，但仍限制更大custom上限及清洗後有效的較長原文；field helper只在明確提供時設maxLength，required/trim、ID128/code16/token256與所有entry/pending/lifecycle維持。沒有client codepoint猜限、truncate、normalize或新增hello/SDK API，custom deployment限額仍由server判定；frame上限不變，極大貼上可能導致原有拒絕/斷線。名稱prompt原已無此硬限，現在表單不再額外排除server有效文字。回歸包含authored DOM、實際SDK wire/validator/Hub及原genericerror/cancel/snapshot流程；fakeDOM不冒充native keyboard/paste/IME，未做該驗收。
