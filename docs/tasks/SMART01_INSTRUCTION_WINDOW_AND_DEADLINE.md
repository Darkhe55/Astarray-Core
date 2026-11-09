
## 窗口准入接线（2026-11-09，用户裁决）

**裁决要点**：窗口满时**禁止越窗准入与启动**，但**继续接收并持久化排队**；已准入任务及其必要
下级派发继续执行；主 Agent 完成持久化交办并拿到回执后可**释放槽位**（不等下级成果）；
取消/暂停/撤权走**独立控制通道**；沿用统一任务序列。

**真实缺陷**：`InstructionWindowStore` 已存在，但 `submitTask` **从不调用它** ⇒
"第 4 条排队"只对显式 `acceptUserInstruction` 成立，产品主路径可以无限越窗启动。

**修复**（`packages/core/src/public-sdk.ts`）：

| 要点 | 实现 |
|---|---|
| 准入先于派发 | `submitTask` 先 `admitInstructionForTask`，三种结果互不混淆 |
| 满窗不启动 | 结果 `queued` ⇒ 记录 `status="queued"`、`missionIdentifier=null`、入 FIFO，**不派发、不挂监视器** |
| 无状态目录 | 结果 `unwindowed` ⇒ 不启用窗口（**不假装已准入**），主路径行为与引入前一致 |
| 释放槽位 | 任务终态或取消时：**先提交回执**，再补一条 |
| 只补一条 | `isDispatchingQueuedTask` 串行化，避免并发终态一次放出多条 |
| 取消不受阻 | 排队任务直接出队并取消，不需要槽位（独立控制通道） |
| 窗口幂等键 | 按 `session:task:prompt-digest` 生成 —— 任务幂等由既有账本负责，窗口只管容量 |

**证据**（`tests/core/integration/smart01-instruction-window-admission.test.ts` 4/4，应用入口级）：

1. 第 4 条业务指令 ⇒ `queued` 且 `missionIdentifier === null`（前 3 条 `accepted`）；
2. 取消第 1 条释放槽位 ⇒ **只补一条**（task-3 派发，task-4 仍 `queued`）；
3. 并发提交 6 条 ⇒ **恰好 3 accepted / 3 queued**（不越窗）；
4. 排队中的任务**可立即取消**（控制通道不受窗口约束）。

**过程中修掉的两处真实缺陷**：

- 取消后槽位永不释放 —— 取消会**先停监视器**，轮询再也看不到终态；
- 窗口幂等键复用用户键 ⇒ 第二个实例同键不同文本被判"同键异参"而整单失败。

公开全量 **652 files / 4469 passed + 3 skipped**；退出码非 0 仅因
`graph-change-deterministic-drill` 的**既有**清理竞态产生 1 条未处理拒绝（隔离 3/3 通过），
与本次改动无关。

**仍未做（如实）**：`submitReceipt` 的"主 Agent 持久化交办"判定仍以**任务终态**为依据，
尚未区分"已交办但下级仍在跑"的中间态；暂停/撤权在执行层的自动终止未接线。
