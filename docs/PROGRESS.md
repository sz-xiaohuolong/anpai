# 当前进度

- Release: `v1`（MVP）
- Requirement Status: `FROZEN`（用户任务书 + v1 五份文档）
- Current Workflow State: `BUILDING`
- Operational Status: `ACTIVE`
- Verification Status: `PARTIAL`（阶段 1–3 已验证；阶段 4–7 未开始）
- Shipping Authorization: `NOT_REQUESTED`
- Last Audited: `2026-10-18`

## 阶段状态

| 阶段 | 状态 | 证据 / 备注 |
|---|---|---|
| 0 · 纸笔验证 | **未执行** | 实施计划定义为硬门槛，但用户已明确授权直接实施。**已知验证缺口** |
| 1 · 骨架 + 纯规则引擎 | **已完成** | 见下 |
| 2 · commit-reveal + 房间服务 | **已完成** | 见下；真实 Durable Object 上端到端 7/7 通过 |
| 3 · 核心游戏页 | **已完成（未做真实浏览器验收）** | 首页 / 等待页 / 游戏页已接线；见下 |
| 4 · 揭示体验 | 未开始 | 当前结算直接展示结果，没有四拍动画与跳过 |
| 5 · 边界与异常 | 部分 | 规则层与协调层的超时/弃权/去重已实现并有测试；客户端重连已有代码但**无真实断网验证** |
| 6 · 结算页与部署 | 未开始 | 未执行过 `wrangler deploy` |
| 7 · 真人对局 | 未开始 | — |

## 验证证据

### 阶段 1

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `pnpm test` | **101 passed / 8 files** |
| 类型检查 | `pnpm typecheck` | 通过，无输出 |
| 生产构建 | `pnpm build` | 通过，69.06 kB JS / 8.03 kB CSS |
| 开发服务器 | `pnpm dev` + `curl` | HTML / `main.ts` / `App.vue` / `core/rules.ts` 全部 HTTP 200 |
| 参照对局回放 | `tests/sample-game.spec.ts` | 分数 36/29/35/41 与规则文档 §8 一致 |
| commit 测试向量 | `tests/crypto.spec.ts` | 3 个向量逐字节相等，含跨房间对照 |
| 确定性 | `tests/determinism.spec.ts` | 同一日志两次投影相等；打乱顺序结果不变 |
| 架构边界 | `tests/boundary.spec.ts` | core 不依赖 Vue / Node / 网络 / 浏览器专有全局 |

### 阶段 2

`pnpm dev:room`（`wrangler dev`）起真实 Durable Object，用 `pnpm e2e`（3 个 Node WebSocket 客户端）跑通：

```
PASS  三个客户端进房并收到 welcome + 全量日志
PASS  全员准备后自动开局（收到 ROUND_OPEN）— opens=1 seqs=[7] rounds=[1]
PASS  三条 COMMIT 被转发
PASS  COMMIT 负载不含位置明文（服务器不知道你选了什么）
PASS  三条 REVEAL 被转发
PASS  三个客户端的日志序号序列一致
PASS  服务器分配的 seq 连续无缺口 — 共 13 条
结果：7/7 通过
```

另有 `tests/coordination.spec.ts` 21 条单测覆盖：席位/重连接管/满员拒绝、开局条件、提交与揭示的幂等与顺序约束、提交超时、揭示超时、零提交轮次推进、打满 8 轮进入 `over`。

### 阶段 3

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm typecheck` | 通过 |
| 单元测试 | `pnpm test` | 96 passed（UI 层无单测，按计划只给 reducer 写密集测试） |
| 生产构建 | `pnpm build` | 通过，85.82 kB JS / 13.52 kB CSS |
| SPA 路由 | `pnpm dev` + `curl` | `/`、`/room/ABC123`、`/room/ABC123/play` 均 200 |
| 视图模块转译 | `curl` 各 `.vue` / `.ts` | App、三个视图、PositionCard、useRoom、client 全部 200，Vite 无报错 |
| 端到端（含客户端投影） | `pnpm dev:room` + `pnpm e2e` | **14/14 通过**（含打满 8 轮、总分校验、再来一局） |

端到端 11 项包含两条关键断言：

```
PASS  三个客户端投影出的局面一致 — {"ann":4,"bob":4,"cyn":5}
PASS  结算分数正确（4 / 4 / 5）
PASS  空位赏金各 +1 — [0,0,0,1,1,1]
```

它把「真实 WebSocket → 真实 Durable Object → 真实日志 → 纯函数投影」这条链完整跑了一遍。

**未验证**：没有用真实浏览器打开过页面。上述是路由与模块可加载 + 逻辑层端到端，不是 GUI 验收。

## 本次实施中发现并修正的问题

1. **规则文档 §8 的被罚次数写错。** 小北应为 4（第 3、4、5、6 轮），原文写 3。已修正文档与 fixture。
2. **`tick()` 丢状态更新。** 原实现用「有没有产生事件」判断是否返回新状态；「整局结束」分支只改状态不产生事件，导致 `phase` 永远停在 `settled`。已改为比较 state 引用。
3. **PartyServer 路由名写错。** 路由是 `/parties/:绑定名-kebab-case/:房间`，即 `/parties/anpai-room/<房间码>`，不是 `/parties/room/...`。
4. **零提交的回合被判为已结算。** `project()` 里「全员已揭示」在 `commits` 为空时是空真，
   导致刚开的回合立刻结束。已改为「提交阶段关闭后才可能结算」，并加回归测试。
5. **最后一轮结算后 5 秒内点「再来一局」会被静默拒绝。** 房间此时仍是 `settled` 而非 `over`。
   已放宽为「`settled` 且已打满 8 轮」也允许重开。
6. **游戏中刷新页面会卡在房间页。** `RoomView` 的跳转 watcher 没有 `immediate`，且对 `GAME_OVER`
   也会误跳。已改为只在「进行中」阶段跳转并加 `immediate`。
7. **E2E 测试被持久化状态污染。** 房间码写死导致 DO 状态跨运行累积，读出历史日志里的旧 `ROUND_OPEN`。已改为每次生成唯一房间码。

## 环境与操作备忘

### 本地开发怎么跑

```bash
# 终端 1：房间服务
pnpm dev:room          # wrangler dev，127.0.0.1:8787

# 终端 2：前端
pnpm dev               # vite，5173
```

Vite 已配置 `/parties` 的 WebSocket 代理到 8787（见 `vite.config.ts`），因此浏览器里
`location.origin` 可以直接用作房间地址，不需要额外配环境变量。

```bash
# 端到端（需先起 dev:room）
pnpm e2e
# 也可以指定走 Vite 代理：
ANPAI_ORIGIN=http://localhost:5173 pnpm e2e
```

- **`wrangler dev` 在本机沙箱下需要覆盖 `HOME`**：它硬编码写 `~/Library/Preferences/.wrangler`，沙箱拒绝后会直接退出。绕过方式：`HOME=<可写临时目录> npx wrangler dev`。
- **DO 状态会持久化在 `.wrangler/state`**（已 gitignore）。测试用固定房间码会读到历史日志。
- **TypeScript 固定在 5.9**：`vue-tsc@3.3.13` 依赖 TS 的 `./lib/tsc` 子路径导出，TS 7 已移除，升级会导致 `typecheck` 崩溃。

## 与实施计划的偏离（已记录理由）

1. **ESLint 边界规则改为测试实现。** 计划 1.2/1.3 要求用 ESLint 禁止 `src/core` 引入框架与随机时钟；实际用 `tests/boundary.spec.ts` + `tests/determinism.spec.ts`。理由：测试必然执行，不依赖 lint 是否被跳过。**ESLint 层尚未建立。**
2. **新增 `party/coordination.ts` 纯模块。** 计划只写了 `party/server.ts`。把协调逻辑抽成不碰时钟、不碰 WebSocket 的纯状态机后，它可以在 Node 里直接单测（21 条），DO 只剩薄适配。这是对可验证性的加强，不改变职责边界。

## 已知缺口（不得当成已验证）

1. **阶段 0 纸笔验证未执行。** 核心假设「揭示那一秒够不够爽」「公开历史能否让人读人」**完全未验证**。
2. **没有真实浏览器之间对战过。** 阶段 2 的 7/7 是 3 个 Node WebSocket 客户端对真实 DO，不是两个浏览器各出一手牌。UI 尚未接线。
3. **真机连通性未验证。** 国内手机移动网络下的实际连通性未测（本轮是本机回环）。
4. **客户端重连未经真实断网验证。** 代码写了指数退避与全量重放，但没有做过「锁屏 30 秒再解锁」的实测。
5. **全部博弈数值为模型推算**，无真人数据。
6. **UI 的 5 项决策未确认**（`docs/game-ui-v1.md` §6 U1–U5）。
7. **未执行过 `wrangler deploy`**，线上路由与 DO 迁移未验证。
8. **UI 没有真实浏览器验收。** 阶段 3 的证据是「路由与模块可加载」+「逻辑层端到端 11/11」，不是「有人在浏览器里点完了 8 轮」。揭示动画、手机布局、误触防护均未实测。

## 下一步

1. **真人浏览器验收（最高优先级）**：两个浏览器各自开一局，打完 8 轮。这是阶段 3 真正的验收，也是发现布局与交互问题的唯一方式。
2. **真机连通性**：`pnpm dev:room` + 两台真手机（含 iOS Safari），验证国内移动网络下的连接。
3. 阶段 4：揭示体验的四拍动画与跳过。
