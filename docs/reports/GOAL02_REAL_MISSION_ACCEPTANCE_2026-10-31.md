# GOAL-02 真实 mission 验收（第一次实跑，2026-10-31）

> 授权：用户明确允许真实模型/工具调用，并要求"专门创建一个 test 文件夹用于测试"。
> 本次只做**基础管线实跑**；目标模式（K1→K10）的实跑因缺少入口而**未完成**（见 §5）。

## 1. 环境与准备

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\MerchRev\Documents\astarray\test\workspace`（本次新建，独立于两个仓库） |
| 状态目录 | `C:\Users\MerchRev\Documents\astarray\test\state`（`ASTARRAY_DATA_DIR=…\test` ⇒ state=…\test\state） |
| Provider | `unisound`（`https://maas-api.unisound.com`），模型 `u2`，凭据引用 `prov-unisound-1` |
| 端点 | 必须给**完整路径** `https://maas-api.unisound.com/v1/chat/completions`（只给 `/v1` ⇒ 404 `path error: /v1`） |
| 权限 | 非交互运行需在 stdin 提供 `allow-once`（按**精确参数**授权；参数变化会再次询问） |

状态目录的凭据与设置从仓库 `.astarray` **复制**而来（只在本机测试目录，未入库）。

## 2. 实跑记录（成功）

命令（在 `test\workspace` 下）：

```
node ..\..\astarray\dist\cli.js run "创建文件 hello.md，内容为：第一行 # Hello，第二行空行，第三行 - 由真实 mission 创建。" \
  --mode assist --runtime openai-compatible \
  --provider-endpoint https://maas-api.unisound.com/v1/chat/completions \
  --provider-model u2 --provider-credential-reference prov-unisound-1 \
  --provider-request-timeout-seconds 120 --json --timeout-seconds 300
```

结果（节选，真实输出）：

```
astarray: 已按精确参数 allow-once 授权 createProjectFile（作用域授权: granted），并下发 unblock（任务 T-001）。
{
  "missionId": "mission-f9a43378",
  "mode": "assist",
  "status": "done",
  "permissionAsk": "allowed-once",
  "prompt": "创建文件 hello.md，内容为：第一行 # Hello，第二行空行，第三行 - 由真实 mission 创建。"
}
```

**产物**：`test/workspace/hello.md`（38 字节）：

```
# Hello

- 由真实 mission 创建。
```

**完成收据**：`test/state/completion-receipts/mission-f9a43378/T-001.json`

```json
{
  "schemaVersion": 1,
  "receipt": {
    "missionIdentifier": "mission-f9a43378",
    "taskIdentifier": "T-001",
    "hasVerifiedCompletionControlEvent": true,
    "toolCallCount": 1,
    "artifactPaths": ["hello.md"],
    "recordedAtIso": "2026-10-31T10:26:37.552Z"
  }
}
```

**任务链**：`test/state/missions/mission-f9a43378/task-chain.json`（另有 `.bak`）。

## 3. 本次证明了什么

- Provider 真实调用可用（OpenAI-compatible 协议、真实模型 `u2`）；
- 工具权限询问 → 精确参数授权 → `unblock` → 工具执行 的完整闭环可用；
- 工具确实写盘（`hello.md` 内容正确）；
- **完成收据**落盘，且 `hasVerifiedCompletionControlEvent: true`、`artifactPaths` 正确。

## 4. 失败/弯路（如实记录）

1. 首次用 `--provider-endpoint https://maas-api.unisound.com/v1` ⇒ **404 `path error: /v1`**；补全 `/chat/completions` 后正常。
2. 未提供 stdin 裁决 ⇒ mission 进入 `blocked`（`requires-human-resubmission`），**未擅自放行**。
3. 一次 provider 请求超时（默认 30s）导致 `This operation was aborted`；把 `--provider-request-timeout-seconds` 调到 120 后成功。

## 5. 目标模式（K1→K10）实跑：**被入口缺失阻断**

目标模式的内核 API 都在 `ApplicationRuntime`，但：

| 障碍 | 证据 |
|---|---|
| **公开 SDK 没有目标模式方法** | `public-sdk.ts` 中无 `proposeGoalContract`/`confirmGoalContract`/`bindMissionToGoal`/`deactivateGoal` 等（只在 `ApplicationRuntime`） |
| **CLI 没有目标模式写命令** | `cli.tsx` 的 `goal-mode` 只有 `status` / `verdicts`（只读） |
| **`submitTask` 不能"带着目标创建 mission"** | `submitTask` 参数只有 `sessionId/taskIdentifier/prompt/idempotencyKey/projectIdentifier/workspaceRootPath/targetAgentInstanceIdentifier` |
| **绑定只能事后做** | `bindMissionToGoal` 需要已存在的 `missionIdentifier`；而门禁在 **mission 启动时**评估 ⇒ 事后绑定对本次派发生效不了 |

结论：**"用户设立目标 → 整组 agent 围绕目标推进"这条链路，目前无法从公开入口真实跑通**；
本次只能验证基础管线（§2），不能宣称 GOAL-02 已端到端验收。

## 6. 下一步（需要产品决定）

1. **最小闭环**：`submitTask`（或新命令）接受 `goalIdentifier`，在创建 mission 时完成绑定 + 状态初始化；
2. **最小入口**：公开 SDK 暴露目标模式方法（UI 也要用）；CLI 加 `goal-mode propose/confirm/bind`（confirm 必须显式用户动作）；
3. **开关可注入**：`isGoalModeEnforcementEnabled` / `isGoalCompletionRequired` / `missionToolCallBudget` 目前只能构造期传入，需要暴露给宿主/CLI；
4. 以上就绪后，再做一次**目标驱动**的真实 mission 验收（本次的 `test/` 目录可直接复用）。

## 7. 验证状态

- 基础管线真实实跑：**已验证**（mission done + 产物 + 收据）；
- GOAL-02 端到端：**未验证**（入口缺失，见 §5）；
- 本次**无代码改动**（只新建 `test/` 测试目录与本文档）。

## 8. R81 复跑：目标模式公开入口（2026-10-31 19:0x）

R81 接上入口后同一 `test/` 目录复跑。

### 8.1 入口真实执行

```
node dist/cli.js goal-mode propose --source "user-message:acceptance-1" --file proposal.json
→ {"status":"goal-proposal-created","proposalIdentifier":"goal-proposal-b14281ab-…"}

node dist/cli.js goal-mode confirm goal-proposal-b14281ab-… --goal goal-acceptance-1 --owner user-local --yes
→ {"status":"goal-contract-created","goalIdentifier":"goal-acceptance-1","revision":1}

node dist/cli.js goal-mode status --goal goal-acceptance-1
→ 契约 revision 1、未暂停、V=null、下一检查点"下三个已结束任务组后检查一次进展"、stabilityGuarantee:"none"

node dist/cli.js goal-mode map --goal goal-acceptance-1 --requirement req-1 --tasks T-001
→ {"status":"goal-requirement-mapped","mappingCount":1}
```

### 8.2 创建时绑定 + 判定落盘

`run --goal goal-acceptance-1 …`（真实 provider）后：

`test/state/goal-mode/mission-bindings.json` 出现三条绑定（含失败/重试的 mission），说明**绑定发生在启动前**；
`goal-mode verdicts` 对应的记录为 `isAllowed:true, isEnforced:false`（只观察、未阻断）。

### 8.3 K7 完成耦合真实拒绝

映射 `req-1 → T-001` 后，`run --goal … --goal-require-completion` 的真实输出：

```
astarray: [需要用户] 目标未完成，不标记完成: 要求 req-1 证据不足（unverified）。；V 仍为 1，不是 0。
```

即：任务本身执行完，但目标证据不齐 ⇒ **不判 done**（符合 K7 设计）。

### 8.4 provider 情况变化（如实）

- unisound 的 `prov-unisound-1` 于本次复跑时返回 **401**（此前 18:26 可用）⇒ 疑似 key 过期/轮换；
- sensenova 返回 **429**（tpm/rpm 限流）；
- 改用 **stepfun** `prov-live-1` + `step-3.5-flash` 成功。
- 期间一次 mission 因模型改用 `writeFileTemporary`（审批的是 `createProjectFile`）触发"必需操作未成功"而失败；
  换成首轮成功措辞后正常 —— **属于模型选工具差异，不是目标模式缺陷**。

### 8.5 仍未验证

- `--goal-enforce` 的**组边界停止**（需"运行中目标被暂停"的场景）；
- **正向完成**（`req-1` 需要 accepted 独立裁决；当前单任务流程不产生裁决 ⇒ V 恒为 1）；
- 模型在对话中**自主提议目标**（未注册工具）。

## 9. R82 正向完成（2026-10-31 19:19）

修正两处后重跑，**第一次正向完成**：

- 顺序：`handleWorkerOutcome`（任务 done 落账）→ `maybeFinishGoalTaskGroup`（此时 V 才看得到 done）；
- 证据：`deterministic-check` 谓词允许"任务 done + 验证收据（hasVerifiedCompletionControlEvent + artifactPaths 非空）"记 0。

```
run --goal goal-acceptance-1 --goal-require-completion …
→ {"missionId":"mission-6ed57632","mode":"assist","status":"done"}

goal-mode status --goal goal-acceptance-1
→ lastPotentialValue: 0, requirementBasisCount: 1, consumedToolCalls: 1, stabilityGuarantee: "none"

completion-receipts/mission-6ed57632/T-001.json
→ hasVerifiedCompletionControlEvent: true, toolCallCount: 1, artifactPaths: ["hello5.md"]

test/workspace/hello5.md → 内容正确
```

**意义**：K1（提案/确认）→ K2（映射）→ 启动前绑定 → V=0 → K7 完成耦合放行，整条链路真实跑通。
仍未实跑：`--goal-enforce` 的组边界停止、accepted 裁决路径。

## 10. R83 目标暂停 + 组边界停止（2026-10-31 20:4x）

新增 `goal-mode invalidate`（K5 内核入口的 CLI）后，构造"目标被暂停"并跑强制模式。

### 10.1 K5 失效 ⇒ 暂停

```
goal-mode invalidate --goal goal-acceptance-1 --requirement req-1 --reason "…hello5.md 被外部删除"
→ potentialValueAfterInvalidation: 1
goal-mode status → isPaused: true, requiresReplanning: true, V: 1, gap: 1,
                    nextCheckpoint: "重新规划后设置新检查点"
```

### 10.2 K10 启动前阻断

```
run … --goal goal-acceptance-1 --goal-enforce
→ [目标门禁] 阻断派发：证据失效导致需要重新规划：…
→ mission-89855721 status=blocked（复核），任务 pending，hello6.md 未创建
```

### 10.3 K10 组边界停止

`goal-k10`（`maximumToolCalls:1`、`pauseConditions:["budget-exhausted"]`、`req-1→T-001`）：

```
run … --goal goal-k10 --goal-enforce
→ [目标门禁] 阻断派发：工具调用预算已用尽（2/1）。
→ [需要用户] 目标门禁在组边界拒绝继续调度: 工具调用预算已用尽（2/1）。
→ status: cancelled；hello7.md 已生成（停止前任务已完成）
goal-mode status goal-k10 → isPaused: true, pauseReason: "工具调用预算已用尽（2/1）。",
                            V: 0, consumedToolCalls: 2
goal-mode verdicts → isEnforced: true；最后 reasonCode: "goal-paused"
```

### 10.4 发现的不一致（未修）

1. `run` 的输出状态：启动前阻断返回 `running`、组边界停止返回 `cancelled`，真实状态是 `blocked`；
2. 预算计数 `consumed=2 / max=1`（先执行后检查）；
3. 一次全量测试跑出现 1 条 unhandled error（测试全过，重跑 exit 0，未定位）；
4. `reasonCode` 只有 `goal-paused`，预算细节只在 detail。

## 11. R84 修复两条不一致（2026-10-31 21:0x）

1. **启动阻断不再误报 running**：`launch*Mission` 门禁拒绝 ⇒ 置 blocked + **抛出** `invalid-task-chain`；
   复跑：`status: "blocked"`（修复前 `running`）。
   *尝试直接改状态映射会让 G5 早停续跑稳定失败（短暂 blocked），已回退并注释说明。*
2. **预算执行前守卫**：新错误码 `tool-budget-exhausted` + 控制器进程内计数 + 门禁有效上限；
   复跑：`目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 createProjectFile`，`hello9.md` 未创建。

验证：G5 2/2 通过；全量 471 files / 3588 tests（一次瞬时 e2e01 失败，单跑通过）；typecheck/lint/build 绿。

仍未解决：预算耗尽的任务失败使 mission 显示 `cancelled`（应为 blocked）且目标不自动暂停；短暂 blocked 对外可见；`permissionAsk` 映射遗留；边界停止仍显示 `cancelled`。

## 12. R85 预算耗尽 = 治理停止（2026-10-31 21:2x）

- `WorkerOutcome.failure` 增加 `failureCode`；worker 从工具 errorCode 取值，orchestrator 的 catch 也从 `DomainError.errorCode` 取值；
- failureCode 为 `tool-budget-exhausted` ⇒ 任务 failed（事实）+ 升级 + `onGoalBudgetExhausted` + `finishMission("blocked")`；
- 运行时暂停目标并**落状态**（pauseReason/缺口/快照/revision）；
- `finishMission` 幂等，循环退出不再用 `cancelled` 覆盖已定终态。

真实复跑（goal-k10c，上限 1）：

```
[目标门禁] 阻断派发：目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 writeFileTemporary。
[需要用户] 目标门禁在组边界拒绝继续调度: …
goal-mode status → isPaused: true
                   pauseReason: "目标工具调用预算已用尽（已执行 1，上限 1）：拒绝执行 writeFileTemporary。"
```

验证：G5 2/2；全量 471 files / 3588 tests；typecheck/lint/build 绿。

**仍未解决**：mission 终态仍 `cancelled`（目标暂停已正确落盘）；任务失败时 `consumedToolCalls` 仍 0（与"已执行 1"不一致）；边界停止输出状态仍 `cancelled`。

## 13. R86 终态单点写入 + 目标状态合并（2026-10-31 21:3x-21:4x）

- `finalizeMissionStatus`：终态不可互相覆盖；**`done` 例外**（可覆盖"中断型 blocked"）；
- `onMissionGateBlocked`（早停/门禁失败）**不**走终态单点（否则续跑完成写不了 done）；
- `GoalModeStateStore.finishTaskGroup` 改为**以磁盘最新状态合并**（保留 pauseReason/缺口/requiresReplanning，
  consumed 取 max），并让失败组用控制器计数补齐"已执行"。

真实复跑（goal-k10g，上限 1）：`isPaused: true`、`consumedToolCalls: 1`（修复前 0）、
`pauseReason` 与 `evidenceGapCount` 均保留。

回归教训：G5 早停续跑曾稳定失败（45s running），原因就是"中断 blocked 被当终态"；修后 2/2 通过。

**仍未解决**：mission 终态仍 `cancelled`（CLI 任务失败后立即 shutdown → scheduler.cancel 先落 cancelled，
治理 blocked 被终态单点拒绝）；根因是收口时序，未在 CLI 层调整。
