# 《暗牌》技术架构 v1

> 版本：v1（MVP）
> 日期：2026-10-18
> 状态：待审核
> 关联文档：[game-rules-v1.md](./game-rules-v1.md) · [game-balance-v1.md](./game-balance-v1.md) · [game-ui-v1.md](./game-ui-v1.md) · [game-implementation-plan-v1.md](./game-implementation-plan-v1.md)

---

## 1. 架构总览

**一条铁律：事件日志是唯一真相，局面是日志的纯函数投影。**

```
┌──────────────────── 浏览器（每个玩家一份） ────────────────────┐
│                                                                │
│   Vue 3 组件层                                                  │
│      │  只读 state，只发 intent                                 │
│      ▼                                                          │
│   ┌──────────────────────────────────────────┐                 │
│   │  @core/rules  纯 Reducer                  │                 │
│   │  project(log) → GameState                 │                 │
│   │  无 I/O、无随机、无时钟                     │                 │
│   └──────────────────────────────────────────┘                 │
│      ▲                                                          │
│      │  append(event)                                          │
│   ┌──────────────────────────────────────────┐                 │
│   │  @core/log   规范顺序 / 去重 / 缺口检测     │                 │
│   └──────────────────────────────────────────┘                 │
│      ▲                                                          │
└──────┼─────────────────────────────────────────────────────────┘
       │  WebSocket（JSON）
┌──────┴─────────────────────────────────────────────────────────┐
│  PartyServer on Cloudflare Durable Objects                     │
│  「房间对象」= 一个房间 = 一个 DO 实例                            │
│                                                                │
│  ✅ 做：分配单调 serverSeq、维护成员与在线状态、                  │
│         广播事件、保留日志、按截止时间推进阶段                     │
│  ❌ 不做：算分、判撞车、算赏金、判胜负                             │
└────────────────────────────────────────────────────────────────┘
```

**为什么需要这个房间对象，而不是纯 P2P：**

1. **消除日志分歧。** 纯 P2P 下，一个恶意客户端可以对不同对等方广播不同的提交（equivocation），导致各自投影出不同局面。有单一排序点后，日志只有一条。
2. **国内手机网络的现实。** WebRTC + 公共 tracker/Nostr 信令在国内手机网络下 NAT 穿透失败率高，且 iOS Safari 在标签页进入后台时会**暂停全部 WebRTC 处理且不恢复**。开黑当晚连不上，这个项目就失败了。
3. **它不违反「判定在前端」的要求。** 房间对象不懂任何游戏规则——它只知道「谁提交了几个字节」，不知道字节是什么意思。

> **PartyKit 托管平台已于 2026-10-16 停止部署、2026-10-23 关闭。** 本文档使用其官方迁移路径 **PartyServer + Wrangler 部署到 Cloudflare**，不使用已停运的 PartyKit 托管。

---

## 2. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端框架 | **Vue 3 + TypeScript + Vite** | 任务指定；Vite 冷启动快，适合个人项目快速迭代 |
| 样式 | **Tailwind CSS** | 设计稿里的间距/颜色刻度可以直接映射成 token，避免手写 CSS 漂移 |
| 状态管理 | **Pinia**，但只放「会话与连接」状态 | **游戏局面不放 Pinia**——它是 `project(log)` 的派生值，放进 store 会产生第二份真相 |
| 规则引擎 | **纯 TypeScript Reducer** | 可单测、可重放、可 diff。整个项目的正确性核心 |
| 实时通信 | **PartyServer + Cloudflare Durable Objects** | 见 §1；房间 = 一个 DO 实例，天然匹配「一个房间」的边界 |
| 部署 | **Cloudflare Workers + 静态资源** | 一次 `wrangler deploy` 同时发前端与房间服务；免费额度足够朋友局 |
| 测试 | **Vitest**（reducer）+ 少量集成测试 | 只有 reducer 值得写密集测试，UI 靠手测 |

**明确不引入**：游戏引擎、3D 库、WebRTC、Yjs/CRDT（本作的状态是线性的，不需要 CRDT）、任何数据库（DO storage 够用）。

---

## 3. 事件模型

### 3.1 事件信封

```ts
type SeatId = string;   // 由 seatToken 派生，见 §6
type EventType =
  | 'JOIN' | 'LEAVE' | 'READY'
  | 'ROUND_OPEN' | 'COMMIT' | 'REVEAL'
  | 'ROUND_TIMEOUT';

interface GameEvent {
  seq: number;        // 服务器分配的单调递增序号，全局唯一
  ts: number;         // 服务器时间戳（毫秒），仅用于协调与调试
  author: SeatId;     // 事件发起者；服务器代发的事件（ROUND_OPEN/TIMEOUT）用系统席位
  type: EventType;
  payload: unknown;   // 按 type 收窄
  clientSeq: number;  // 客户端本地自增，仅用于服务器去重
}
```

### 3.2 各事件的 payload

| type | payload | 谁发 |
|---|---|---|
| `JOIN` | `{ nickname, seatId }` | 客户端（服务器校验 `seatId` 与 `seatToken` 一致后转发） |
| `LEAVE` | `{ seatId, reason: 'closed' \| 'timeout' }` | 服务器 |
| `READY` | `{ seatId, ready: boolean }` | 客户端 |
| `ROUND_OPEN` | `{ round, openedAt }` | **服务器** |
| `COMMIT` | `{ round, commit: string }` | 客户端 |
| `REVEAL` | `{ round, slotIndex, nonceHex }` | 客户端 |
| `ROUND_TIMEOUT` | `{ round, phase: 'commit' \| 'reveal' }` | **服务器** |

**注意 `COMMIT` 的 payload 里没有位置。** 位置只存在于客户端的本地内存里，直到 `REVEAL` 才广播。服务器从始至终不知道任何人选了哪个位置。

### 3.3 关键决定：结算不产生事件

**结算结果是 `project(log)` 算出来的，不写回日志。**

理由：如果结算也写回日志，就有两份真相（日志 + 结算事件），两者可能不一致。让结算成为纯派生值，则「同一日志 → 同一局面」是构造性成立的，不需要额外保证。

代价：每个客户端都要重算。8 轮 × 5 人的计算量微不足道。

### 3.4 阶段也是派生的

阶段（`COMMITTING` / `REVEALING` / `RESOLVED`）不单独存，由 `project()` 从日志推导：

```
若该轮无 ROUND_OPEN                        → WAITING
否则若已有 ROUND_TIMEOUT(reveal) 或全员已揭示 → RESOLVED
否则若已有 ROUND_TIMEOUT(commit) 或全员已提交 → REVEALING
否则                                        → COMMITTING
```

**「全员已提交」的判定用的是「该轮 COMMIT 事件数 = 当前活跃席位数」**，这是纯粹的计数，不涉及任何游戏规则。

---

## 4. 规范顺序

**服务器是唯一排序点。** 每个事件由房间对象分配单调递增的 `seq`，然后广播。

- **规范顺序 = `seq` 升序。** 客户端收到事件后先入本地缓冲区，按 `seq` 排序再投影；发现 `seq` 缺口则暂停投影并向服务器请求缺失区间。
- **去重**：服务器按 `(author, clientSeq)` 去重（网络重发）；客户端按 `seq` 去重。
- **乱序**：WebSocket 本身有序，但重连补日志时可能重叠，因此仍按 `seq` 归并。

**这比「客户端各自维护 seq」健壮得多**：客户端本地的 seq 在重载、双标签页、时钟漂移下都不可靠。把排序交给单一排序点，客户端只需消费。

---

## 5. commit-reveal 协议

### 5.1 规范编码（必须逐字节一致）

```
commit = SHA-256( UTF8( roomCode + "|" + round + "|" + seatId + "|" + slotIndex + "|" + nonceHex ) )
```

- `roomCode`：房间码原文
- `round`：十进制整数，无前导零
- `seatId`：席位 ID 原文
- `slotIndex`：从 0 开始的十进制整数
- `nonceHex`：`crypto.getRandomValues(new Uint8Array(16))` → 小写十六进制，固定 32 字符
- 分隔符半角 `|`，整体 UTF-8

**编码里必须含 `roomCode` 与 `seatId`**，否则同一份 `(轮, 位, nonce)` 在不同房间/不同玩家处产生同一哈希，存在跨房间重放。

### 5.2 测试向量（实现必须复现）

| roomCode | round | seatId | slotIndex | nonceHex | commit |
|---|---|---|---|---|---|
| `ANPAI7K` | 1 | `seat-a1b2` | 3 | `000102030405060708090a0b0c0d0e0f` | `84ccd19d209dcdf0ddbe7acc33edbf38ddbf3b52d8900b5e9506686da88cca80` |
| `ANPAI7K` | 10 | `seat-c3d4` | 9 | `fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0` | `56c818d56708c55c2edf154bd35dc4e219c1d7de7547c07546fbbe09da128f80` |

跨房间对照（同 round/seat/slot/nonce，roomCode 改为 `ANPAI8M`）：
`ea78b9b1b8143f16171cebb4acd5c7fe68ce9652ccc0ea75c8d900d3908c85df`

### 5.3 已验证的范围

上述原语的**绑定性与隐藏性**已在 node v23.11.0 上验证：
- **绑定**：看到他人揭示后无法改选（改变位置会得到不同哈希）。
- **隐藏**：不知道 `nonceHex` 时无法从哈希反推位置。

**这验证的是密码学原语与上述编码，不是「整个游戏已实现」。** 客户端的实现仍必须跑上面的测试向量。

### 5.4 时序

```
客户端                          服务器                        其他客户端
  │                              │                              │
  │ 本地选位 + 生成 nonce         │                              │
  │ 算 commit                    │                              │
  ├── COMMIT{round, commit} ────▶│                              │
  │                              ├── 分配 seq，广播 ────────────▶│
  │◀───────────── 广播 COMMIT ───┤                              │
  │                              │                              │
  │        （全员已提交 或 提交截止）                              │
  │◀──────── ROUND_TIMEOUT(commit) 或 由计数推导 ────────────────▶│
  │                              │                              │
  ├── REVEAL{round, slot, nonce}▶│                              │
  │                              ├── 广播 ─────────────────────▶│
  │                              │                              │
  │  各客户端 project(log) → 校验哈希 → 结算（纯函数，不写回日志）  │
```

---

## 6. 身份与席位

- 玩家首次进房时，客户端生成 `seatToken`（16 字节随机 hex），存入 `localStorage`，键为 `anpai:seatToken:<roomCode>`。
- **`seatId = SHA-256(seatToken)` 的前 8 字节 hex**，是日志中出现的唯一身份标识。
- **`seatToken` 明文永不进入日志**，只在 `join` 握手时发给服务器一次。否则任何人都能冒用他人席位。
- **身份绑定 `seatToken`，不绑定昵称。** 因此昵称允许重复；同一昵称可以是不同席位。
- **一个席位同时只允许一个活跃连接。** 新的连接使用同一 `seatToken` 时**接管**该席位，旧连接被服务器断开。

---

## 7. 断线、超时与异常

### 7.1 断线

**手机上「切后台」等于断线**（iOS Safari 会挂起页面）。因此设计前提是：**断线是常态，不是异常。**

| 情形 | 处理 |
|---|---|
| 连接断开 | 服务器标记席位 `disconnected`，但**不移出游戏**。客户端顶部显示「重连中…」轻提示 |
| 重连（同一 `seatToken`） | 服务器下发**全量日志**（房间很小，8 轮 × 5 人 ≈ 数百条事件，直接全发）；客户端重放，恢复到当前状态 |
| 重连时正处于提交阶段 | 若该轮尚未关闭，可继续提交；若日志中已有自己的 `COMMIT`，**以已记录的为准，不得覆盖** |
| 重连时正处于揭示阶段 | 若揭示截止未到，可正常揭示 |
| 重连时回合已推进 | 直接进入当前轮；错过的轮次按日志中已记录的**弃权**结算 |
| 席位在截止前始终未回来 | 该轮弃权（得 0 分，不占位置）。下一轮回到 `ROUND_OPEN` 时若已重连，正常参与 |

**房主退出不影响游戏——因为不存在房主。** 任何客户端关闭页面，其余人继续。

### 7.2 截止时间

| 阶段 | 截止 |
|---|---|
| 提交 | `ROUND_OPEN.openedAt` + **30 秒** |
| 揭示 | 提交截止 + **15 秒** |

- **`openedAt` 由服务器在 `ROUND_OPEN` 事件里写入**，是所有人唯一的时间基准。客户端本地时钟不参与判定。
- 服务器在截止时发出 `ROUND_TIMEOUT` 事件；客户端即使没收到，也能从 `openedAt` 自行推导同一截止时间。
- **零提交的轮次**：`ROUND_OPEN` 一定存在，因此截止时间可推导，全员弃权后正常进入下一轮。

### 7.2.1 机器人席位

机器人是**普通席位**，只是多了一个 `bot: true` 标记（`JOIN` 事件携带），并且没有连接。

- **房主 = 第一个加入的席位**，由日志推导（`hostSeatId`），不在服务端单独保存。
- 房主可发送 `addBot` / `removeBot`（仅 `lobby` 阶段）。
- 机器人的提交与揭示由房主浏览器代为发送：`COMMIT` / `REVEAL` 消息带 `forSeat: "bot-1"`。
- 服务端只做**授权检查**：`forSeat` 必须指向机器人席位，且发送者必须是房主。它仍然不知道任何人选了什么——这条边界没有被打破。
- 机器人策略在 `src/core/bot.ts`，是**纯函数**（无随机源、无时钟）：给定「公开局面 + 自己的席位 + 房间码」永远得到同一个选择。
- **策略 = 按对称混合策略均衡的概率抽样**（闭式解，见 `docs/game-balance-v1.md` §2），不是 AI 判断，也不是「挑最高分」。
  - 抽样种子**必须包含房间码**。只用 (席位, 轮次) 时，每一局的落点组合都被固定，等于一次抽样被重复上千次，实测撞车率会掉到 37%（真人基线 69.1%）——机器人反而比真人更少撞车、占了便宜。
- **公平性约束（回归测试守住）**：机器人**既不该永远互撞，也不该永不互撞**。「永不互撞」意味着机器人之间完美协同、真人独自承担全部撞车，这是在作弊。`tests/bot.spec.ts` 与 `scripts/e2e-bot.mjs` 从两个方向断言这个区间。

**限制**：房主关闭页面后机器人停止行动，该轮按超时弃权。

### 7.3 未揭示的提交

**规则：提交作废，本轮弃权得 0 分，且不占任何位置**（该位置因此可能触发赏金 +1）。

**这条规则让「故意拒绝揭示」成为弱劣势策略：**

- 独自占位时：揭示 → 得分；拒绝 → 得 0。
- 与对手同占一位时：揭示 → 两人都 0；拒绝 → 你的承诺作废，**对手变成独占并得分**。

两种情况你都拿 0，但揭示能阻止对手得分。因此理性玩家永远会揭示。残留的只有「故意送分给朋友」式的 kingmaking，这是社交问题，不是协议漏洞。

### 7.4 重复与乱序事件

| 问题 | 处理 |
|---|---|
| 客户端重发（网络抖动） | 服务器按 `(author, clientSeq)` 去重 |
| 重连补日志时区间重叠 | 客户端按 `seq` 去重 |
| 事件乱序到达 | 客户端按 `seq` 排序后再投影 |
| 检测到 `seq` 缺口 | 暂停投影，向服务器请求缺失区间，补齐后再投影 |

---

## 8. 可信边界（必须明确写出来，不能含糊）

**本作的可信模型是「朋友之间不设防」，不是「抗恶意攻击」。**

| 能防 | 怎么防 |
|---|---|
| 提交后偷看他人选择再改 | commit-reveal（哈希绑定） |
| 跨房间 / 跨玩家重放提交 | 编码绑定 `roomCode` 与 `seatId` |
| 冒用他人席位 | 身份绑定 `seatToken`，日志只出现派生的 `seatId` |
| 昵称冲突 | 同上 |
| 日志分歧 | 服务器是唯一排序点 |
| 重复提交 / 重放提交 | 服务器按 `(author, clientSeq)` 去重；规则只认该轮第一条 `COMMIT` |

| **不能防** | 说明 |
|---|---|
| 改过的客户端在揭示前就看到**自己的**信息 | 无影响——每个客户端本来就只知道自己选了什么 |
| 改过的客户端伪造日志 | 客户端可以本地显示任意内容，但它影响不了别人的局面（别人的局面由服务器广播的日志决定） |
| 玩家串通（两个席位同一人操作） | 他能打两手牌，但看不到任何人的明文选择，因此没有信息优势 |
| 拒绝揭示以阻止他人 | 见 §7.3——这条是**自损**的 |
| 最后一轮的 kingmaking | 无法用技术手段消除，属社交问题 |

**任何文档、UI 或宣传都不应声称「纯前端判定能完全防作弊」。** 正确的说法是：**暗选在提交后不可更改、不可提前窥探；但本作不防蓄意破坏的朋友。**

---

## 9. 目录结构

```
table-game/
├─ docs/                          # 本套设计文档
├─ src/
│  ├─ core/                       # 纯逻辑，零依赖，可单测
│  │  ├─ events.ts                # 事件类型定义
│  │  ├─ log.ts                   # 排序 / 去重 / 缺口检测
│  │  ├─ rules.ts                 # project(log) → GameState
│  │  ├─ crypto.ts                # commit / verify（用 WebCrypto）
│  │  └─ values.ts                # 各人数的基础价值表
│  ├─ net/
│  │  ├─ client.ts                # WebSocket 客户端 + 重连
│  │  └─ protocol.ts              # 消息类型（与 party/ 共享）
│  ├─ stores/
│  │  └─ session.ts               # Pinia：只放连接与席位，不放局面
│  ├─ components/
│  │  ├─ PositionCard.vue
│  │  ├─ RevealOverlay.vue
│  │  ├─ Scoreboard.vue
│  │  └─ HistoryDrawer.vue
│  ├─ views/
│  │  ├─ HomeView.vue
│  │  ├─ RoomView.vue
│  │  ├─ PlayView.vue
│  │  └─ ResultView.vue
│  └─ main.ts
├─ party/
│  └─ server.ts                   # PartyServer 房间对象（只有协调，没有规则）
├─ tests/
│  └─ rules.spec.ts               # reducer 的断言集
├─ wrangler.toml
└─ package.json
```

**边界纪律：`src/core/` 不允许 import 任何 Vue、任何 DOM、任何网络模块。** 它必须是可以在 Node 里直接跑的纯 TypeScript。这条纪律用 ESLint 的 `no-restricted-imports` 强制。

---

## 10. 部署

```bash
npm create cloudflare@latest -- --template=cloudflare/partykit
# 或手动接入 PartyServer
npx wrangler deploy      # 一次部署同时发布前端静态资源与房间对象
```

| 项 | 值 |
|---|---|
| 部署命令 | `npx wrangler deploy` |
| 本地开发 | `npx wrangler dev`（房间对象跑在本地） |
| 前端 | 由 Worker 的静态资源绑定提供，或 Cloudflare Pages |
| 数据保留 | DO storage 保留日志 **24 小时**，之后自动清理。本作不需要长期存储 |
| 成本 | 朋友局规模下落在 Cloudflare 免费额度内 |
| 域名 | `wrangler` 提供的 `*.workers.dev` 子域即可，v1 不买域名 |

**为什么不用纯静态托管 + 纯 P2P**：见 §1 的三条理由。稳定联机比「零后端」重要——为了省掉一个极简中继而承担玩家连不上的风险，是错的取舍。

---

## 11. 测试策略

**只给 reducer 写密集测试，其余靠手测。** 这是个人项目，测试预算要花在正确性核心上。

| 层 | 测什么 | 怎么测 |
|---|---|---|
| `core/crypto` | 测试向量复现 | 上表 3 个向量，断言逐字节相等 |
| `core/rules` | 结算正确性 | 断言集：独占得分 / 2 人撞车归零 / 3 人撞车归零 / 空位赏金 +1 / 连续空置累加 / 赏金被取走后归零 / 撞车后赏金不变 |
| `core/rules` | 确定性 | **同一日志投影两次，结果深比较相等**；再断言 reducer 源码不含 `Math.random` / `Date.now` / `performance.now`（用 lint 规则，不靠人眼） |
| `core/log` | 乱序与去重 | 打乱事件顺序后投影，断言与顺序输入结果相同 |
| `core/rules` | 完整对局回放 | 用 [game-rules-v1.md](./game-rules-v1.md) §8 的示例对局作为 fixture，断言最终分数为 36/29/35/41 |
| 端到端 | 开房 / 断线重连 / 超时 | 手测，不写自动化 |

**「同一日志投影两次结果相等」这条断言是整个架构的地基**，它把「事件日志是唯一真相」从口号变成了可执行的检查。
