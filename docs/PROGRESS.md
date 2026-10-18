# 当前进度

- Release: `v1`（MVP）
- Requirement Status: `FROZEN`（用户任务书 + v1 五份文档）
- Current Workflow State: `BUILDING`
- Operational Status: `ACTIVE`
- Verification Status: `PARTIAL`（阶段 1 已验证；阶段 2–7 未开始）
- Shipping Authorization: `NOT_REQUESTED`
- Last Audited: `2026-10-18`

## 阶段状态

| 阶段 | 状态 | 证据 / 备注 |
|---|---|---|
| 0 · 纸笔验证 | **未执行** | 实施计划定义为硬门槛，但用户已明确授权直接实施。**这是已知的验证缺口** |
| 1 · 骨架 + 纯规则引擎 | **已完成** | 见下方证据 |
| 2 · commit-reveal + 房间服务 | 未开始 | `crypto.ts` 已就绪，房间服务未开始 |
| 3 · 核心游戏页 | 未开始 | 当前 `App.vue` 只是阶段 1 的走通骨架 |
| 4 · 揭示体验 | 未开始 | — |
| 5 · 边界与异常 | 未开始 | 规则层的超时/弃权已实现并有测试 |
| 6 · 结算页与部署 | 未开始 | — |
| 7 · 真人对局 | 未开始 | — |

## 阶段 1 证据（2026-10-18）

| 检查 | 命令 | 结果 |
|---|---|---|
| 单元测试 | `pnpm test` | **75 passed / 7 files** |
| 类型检查 | `pnpm typecheck` | 通过，无输出 |
| 生产构建 | `pnpm build` | 通过，产物 69.06 kB JS / 8.01 kB CSS |
| 开发服务器 | `pnpm dev --port 5199` + `curl` | HTML / `main.ts` / `App.vue` / `core/rules.ts` 全部 HTTP 200 |
| 参照对局回放 | `tests/sample-game.spec.ts` | 分数 36/29/35/41 与规则文档 §8 一致 |
| commit 测试向量 | `tests/crypto.spec.ts` | 3 个向量逐字节相等，含跨房间对照 |
| 确定性 | `tests/determinism.spec.ts` | 同一日志两次投影相等；打乱顺序结果不变 |
| 架构边界 | `tests/boundary.spec.ts` | core 不依赖 Vue / Node / 网络 / 浏览器专有全局 |

## 本次实施中修正的文档错误

1. **`docs/game-rules-v1.md` §8 的被罚次数写错了。** 原文写「阿元 3、小北 3、Kai 3、老周 2」，逐轮核对后小北应为 **4**（第 3、4、5、6 轮各撞车一次）。该局的撞车事件总数 12 = 6 轮 × 2 人，与 3+4+3+2 一致。已修正文档与 fixture。

## 与实施计划的偏离（已记录理由）

1. **ESLint 边界规则改为测试实现。** 计划 1.2/1.3 要求用 ESLint 禁止 `src/core` 引入 Vue/DOM 与随机时钟。实际改为 `tests/boundary.spec.ts` + `tests/determinism.spec.ts`，理由：测试在本地与 CI 都必然执行，不依赖 lint 是否被跳过；且避免了 ESLint 9 flat config 与 vue/typescript 插件的额外依赖面。**ESLint 层尚未建立**，若后续需要编辑器内即时反馈再补。
2. **TypeScript 固定在 5.9。** 初始安装解析到 TypeScript 7.0.2，但 `vue-tsc@3.3.13` 依赖 TS 的 `./lib/tsc` 子路径导出，TS 7 已移除该导出，导致 `pnpm typecheck` 直接崩溃。已降到 `^5.9`。待 vue-tsc 支持 TS 7 后可再评估。

## 已知缺口（不得当成已验证）

1. **阶段 0 纸笔验证未执行。** 核心假设「揭示那一秒够不够爽」「公开历史能否让人读人」**完全未验证**。纯规则引擎与数值无关，因此阶段 1 不受影响；但若纸笔验证推翻核心循环，阶段 3–6 存在返工风险。
2. **真机连通性未验证。** PartyServer + Durable Objects 在国内手机移动网络下的实际连通性未测。**建议在写任何联机代码之前先做这一步。**
3. **全部博弈数值为模型推算。** 撞车率、被罚次数、分差均来自均衡模型与模拟，无真人数据。
4. **UI 的 5 项决策未确认**（`docs/game-ui-v1.md` §6 U1–U5），当前按建议值实施。
5. **阶段 1 只验证了规则层。** 联机、UI、揭示动画均无任何运行证据。

## 下一步

阶段 2：commit-reveal 接线 + PartyServer 房间对象。
建议在此之前插入一步**真机连通性验证**（最小 echo 服务 + 3 台真手机），以最小的成本排除最大的技术风险。
