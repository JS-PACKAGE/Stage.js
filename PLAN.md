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
- **生命週期**：連線 `join`（roomId＋代碼）即註冊（預設 audience）；斷線即移除；**主控下台不觸發移交**，主控斷線逾 **60 秒**（可調整）才自動移交（台上最早發言者 → 最早觀眾，見假設 4）。
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
5. 前端＝vanilla TypeScript＋Vite、UI 繁體中文；client 以 **ESM 函式庫**交付（可嵌入其他網站程式；Web Component 包裝為延伸項，**可調整**）；完整範例前端建於其上（裁示 2026-10-09）。
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

1. **協定擴充**（第四節之外）：S→C `ok {requestId}`（請求成功回覆）、`pong`、`rtc:config {iceServers}`（join／開房後下發，TURN 憑證僅給已進房者，為每人簽發的短期憑證）、`speaking {participantIds}`（伺服器混音端 VAD，集合變動時廣播）；C→S `room:create` 增 `roomName?`、`codeRequired?`（假設 9：代碼可關閉）；`join` 增 `resumeToken?`（主控斷線寬限期內回座）；`room:state` 每人帶 `onStage`／`forceMuted`，另有 `audienceCount`、`status`、`limits`，`audience` 全名單與 `code` 僅主控收到，`resumeToken` 僅本人收到。
2. **信令方向**：一人一條 PeerConnection 連伺服器，**一律由 client 發 offer**、伺服器 answer；伺服器收到 `rtc:answer` 回 `bad_request`。上台（`me.onStage` 轉 true）→ client 掛麥克風改 `sendrecv` 重協商 → 伺服器 `stage:joined`；下台反向改 `recvonly`。
3. **主控返回舞台**：主控下台後以 `stage:approve` 指定自己即回台（不需舉手；主控不可舉手）。
4. **強制靜音**：`mic:force-unmute` 只解除主控鎖定，保留本人的自我靜音狀態（不遠端打開他人麥克風）。
5. **上限算法**：「主控以外的人數 ≤ 300」、「主控以外的台上者 ≤ 8」，使觀眾數與發言者數在上下台、移交等所有轉換中恆守上限；每房實際容量＝300＋主控、台上＝8＋主控。主控在台時把控制權移交給台下者會使主控席位變成受上限的發言者席位，台上已滿時回 `stage_full`（先下台再移交）。
6. **進場錯誤**：房間不存在與代碼錯誤一律 `unauthorized`（不洩漏房間是否存在）；代碼不分大小寫、以常數時間比較。
7. **name 轉義**：伺服器儲存並輸出 HTML 轉義後的名稱（`& < > " '`）；client 提供 `decodeName()`，範例前端以 `textContent` 顯示。
8. **限流**：任一限流違規（含 `hand:raise` 10 秒內重複）即以 close code 1008 斷線；client 函式庫在本地先擋舉手冷卻並對送出節流且**保持送出順序**（ICE 不得超前其 offer）。
9. **單序事件佇列**：每房一條 `SerialQueue`，狀態變更與該房信令全經此佇列；每連線另保證訊息依序處理。不變量違例 → 關房（fail-closed）；單一 client 的信令錯誤（壞 SDP、過早 ICE）只回該請求 `bad_request`，不影響房間。
10. **明文 ws**：`server.allowInsecure: true` 且 host 為 loopback 才允許；否則必須提供 TLS 憑證，啟動即檢查。
11. **werift 注意**：伺服器 transceiver 於套用 offer **之前**須先設成政策方向，否則 werift 不登錄瀏覽器重協商時新出現的 SSRC（觀眾升發言者後上行被丟棄）；`scripts/werift-loopback.ts` 以「去除 recvonly offer 的 SSRC」模擬瀏覽器並驗證此情境。werift 在 answer 為 recvonly 時仍可能送出 RTP，故上行一律以 publisher 註冊＋政策雙重把關。
12. **踢人與更換代碼**：C→S `participant:kick {targetId}`（主控限定，不可踢自己）把參與者移出房間（台上者等同下台並移除），對方收到 S→C `kicked {roomId}` 後伺服器以 close code 4001 關閉連線，client 不自動重連；`room:rotate-code`（主控限定、需代碼的房間）換發新代碼，舊代碼立即失效、已在房內者不受影響。兩者合用＝封鎖鬧場者（無帳號制度下的「ban」）。
13. **連線品質回報**：有人上行時，伺服器每 `rooms.qualityIntervalMs` 以 S→C `quality {participants}` 把每位上行者的上行掉包（伺服器重排緩衝實際判定遺失的比例，逐區間計算）、下行掉包（對方 RTCP 接收報告的平滑值）與 RTT 送給主控與台上者；觀眾不收，改由 client `getStats()` 的 `lossPercent` 自行顯示。
14. **開房權杖**：`rooms.createToken` 非空時，`room:create` 須帶相同的 `token?`（常數時間比較），否則回 `unauthorized`、不建立房間；防止匿名者占滿 `limits.maxRooms`。空字串維持任何人可開房（本機開發預設）。
15. **停機通知**：伺服器停止（SIGTERM／SIGINT）時對每個房間送 `room:closed {roomId, reason: 'shutdown'}`，再以 close code 1001 優雅關閉連線（最多等 1 秒完成關閉握手，逾時才強制切斷），確保通知送達；client 據此顯示「伺服器維護／重啟」而非一般關房。房間狀態只存在記憶體，重啟後不保留（第〇節範圍外）。
16. **手動音量微調**：C→S `mic:gain {targetId, gainDb}`（主控限定，`|gainDb| ≤ MAX_GAIN_DB`＝20，伺服器取到 0.1 dB）設定某人在混音中的增益，疊加在 `audio.loudness` 自動正規化之後、限幅器之前；新值在下一個上行幀內線性過渡避免爆音。設定隨參與者保存到離開房間為止（上下台不重置），`ParticipantView.gainDb` 對全員可見。
17. **下行省工**（效能決策）：(a) 台上者靜音或斷流超過 1 秒時，其 mix-minus 就是完整混音，改收共用的完整混音編碼並釋放自己的 encoder，一出聲立即換回（切換時該台上者的下行換一個 encoder 串流）；(b) 全房無人上行超過 1 秒（且 `opus.dtx` 開啟）時不再編碼，主機收到空 payload 即按 DTX 處理（時間戳前進、不送包，與 DTX 的差別只在不再送週期性靜音更新幀）；(c) 分送計畫（誰收哪個編碼）只在路由變動時重建；(d) werift 每包把 SRTP 金鑰以 Buffer 交給 node:crypto、每次重新匯入，改由 `src/transport/srtpKeys.ts` 在 cipher 建立時換成 `KeyObject`（輸出逐位元相同，由測試守住；werift 版本固定 0.25.0）。

---

開始執行。
