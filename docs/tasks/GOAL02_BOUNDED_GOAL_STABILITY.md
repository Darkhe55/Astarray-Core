# GOAL-02：实验性目标模式与有界进展约束
日期：2026-10-28。状态：in_progress（01–03 全部部分交付，implemented-unverified；整卡未闭合）。

执行规则：每轮只做一个编号检查点，超过三小时拆分；先核对当前代码和在途改动，已有能力复用。覆盖、删减前由工具备份；不覆盖他人工作。必须更新本卡状态和交付记录；共享台账存在并行冲突时提交独立状态补丁，不以未授权为由跳过状态记录。本卡不授权安装、真实付费模型调用、外发消息、提交推送或自动启用实验功能。需要依赖时先询问已有资源。沿用用户此前不要求编写/运行测试的交付口径，本卡列出验收条件但不自行执行测试或宣称通过；代码完成只能标 implemented-unverified。变量名必须可读，时间单位明确。公共核心只放通用契约，不复制私有界面实现或设计。

## 审查与定位
已有 `packages/core/src/tools/local-progress-and-cycle-guard.ts`：调用环、无进展计数、单飞、预算等。已有偏序任务、完成证据、检查点和节点记忆。本次在核心源码检索未发现 Lyapunov/goal-mode 实现；不能把循环守卫当成目标一致性证明。前驱：ALIGN-01/02 的稳定个体、版本化目标与权威偏序入口接线；契约设计可提前。

用户目标原文：“目标模式，需要尝试构造李雅普诺夫稳定性的等价约束，确保持续推进过程中永不偏航。”
实现边界：保留原文为优化目标，不宣传已证明“永不偏航”。开放世界模型行动及外部扰动无法仅凭评分得到此保证。首版提供“受约束目标推进”，不是新的权限模式；与思索/协同/放权正交，默认关闭，仅认证用户开启。

## 01：冻结目标与进展模型
- 建立 GoalContract：goalIdentifier、revision、owner、原始要求引用、范围、不可违反项、完成谓词、证据要求、资源上限、截止/暂停条件、任务节点映射。模型建议不能自改目标、删要求或降低判准。
- 版本变更必须来自原任务发布方的合法变更；变更不重置累计预算。子目标绑定上级目标版本，已验收结果保留来源。
- 在固定目标版本的里程碑边界定义候选势函数：V = Σ weight × remainingRequirement（正权重，未验证/失效=1，当前有效且通过确定性判据或独立验收=0）。拆分任务不改变总权重，不以工具调用数、模型信心、输出字数降分。
- V=0 仅表示当前已枚举要求具有有效证据，不等于现实世界完整正确。没有可靠完成谓词时记录 unknown，不能给伪精确分值。安全不变量独立于 V，不允许“进展收益抵消越权风险”。

## 02：本地门禁与有界绕行
- 派发前验证 scope、权限、目标版本、预算；每次副作用仍走原工具权限和备份门禁。把拒绝限定在对应任务链，不阻塞主 Agent 与用户通信。
- 默认每三个已结束任务组检查一次进展（完成/中断也计组，不靠启动次数）；沿用现有调用总预算和截止时间，取更严边界，避免单个组无限工作。
- 允许调查、测试和必要返工暂时不降 V；固定版本连续三组不下降则暂停该目标自动派发，给出证据缺口与继续条件。不自动无限重试或申请额外资源。
- 证据失效导致 V 上升时保留事实、暂停并重新规划，禁止修改权重掩盖倒退。外部变化触发新检查点，不回滚用户修改。紧急事件复用既有仲裁机制。
- 模型只提出动作与解释，本地校验器记录执行前后状态，禁止模型伪造已执行或替代完成门禁。

## 03：恢复、可观察性和实验退出
持久化目标版本、V 的逐项依据、累计预算、当前组和暂停原因；恢复先对账，不重复副作用。关闭实验后安全停止新增目标派发，保留已存在任务和历史，不清除限制或撤销已执行结果。返回状态、判据缺口、资源消耗和下一检查点，禁止返回未经证实的稳定性保证。

## 验收条件（待验证）
改写评分无法假完成；计划拆分不降 V；无证据不可降分；模型改目标被拒；无进展能暂停；重启预算不归零；外部变化使证据失效；权限门禁不因目标模式绕过；用户仍能中断。理论证明只限显式有限状态/已建模转移子集，记录假设、反例和适用范围，不外推为全产品保证。

参考：[MIT Lyapunov Analysis](https://underactuated.mit.edu/lyapunov.html)。采用候选势函数与不变量的工程类比；稳定、收敛和安全是不同性质。


## 检查点记录

### 01 冻结目标与进展模型——**部分交付**（2026-10-28）

**审查发现**：仓库里有循环守卫（调用环/无进展计数/单飞/预算），但**没有**目标契约与进展模型；
循环守卫只防"原地打转"，不回答"是否还在朝原目标推进"。

**交付**（`packages/core/src/orchestration/goal-contract.ts`，纯契约 + 纯计算）：
| 要点 | 说明 |
|---|---|
| GoalContract | goalIdentifier/revision/owner/sourceRequestReference/范围/不可违反项/要求/资源上限/截止/暂停条件/supersedesRevision |
| 版本变更 | 只有**原任务发布方**或**认证所有者**可改；`model-proposal`/`tertiary-agent` **一律拒绝**；revision 逐次 +1 |
| 候选势函数 | `V = Σ weight × remaining`；只有确定性判据/独立验收记 0；缺失评估记满权重；**不用**工具调用数/模型信心/字数降分 |
| 未知优于伪精确 | 存在 `unreliable` 完成谓词 ⇒ `status:"unknown"` + 列出要求，不给数字 |
| 拆分守恒 | 子权重之和必须等于父权重（容差比较） |
| 不变量独立 | `evaluateSafetyInvariants` **不接受 V 参数**，结构上隔离 |
| 默认关闭 | `GOAL_MODE_DEFAULT_ENABLED=false`；激活需"用户来源+认证用户+显式请求+显式开启" |

**未做（如实）**：**没有接进派发**（属 02）、**没有持久化**（属 03）、无 CLI/UI、
未建模"调查/测试/返工暂时不降"窗口、**不声称 Lyapunov 稳定性**；
未跑"模型改目标被拒/拆分不降 V/无证据不降分/不可靠谓词 ⇒ unknown"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 02 本地门禁与有界绕行——**部分交付**（2026-10-28）

**审查发现**：01 只交付契约与纯计算，**没有任何执行侧约束** —— 目标模式不会拦截、暂停或校验派发。

**交付**（`packages/core/src/orchestration/goal-dispatch-gate.ts`）：
| 要点 | 说明 |
|---|---|
| 派发前检查 | `assertDispatchAllowed` 返回 `goal-paused`/`requires-replanning`/`revision-mismatch`/`scope-violation`/`deadline-passed`/`budget-exhausted`，允许时给剩余预算与距下次检查组数 |
| 组计数 | `recordGroupCompletion` 每 **3 个已结束组**检查一次（完成/中断都计组，不看启动次数） |
| 有界绕行 | `investigation`/`rework` 组**不计入停滞**（允许调查/测试/返工暂时不降），仍计入组数 |
| 停滞暂停 | 普通组**连续 3 次检查 V 未严格下降** ⇒ 暂停自动派发 + 证据缺口；**无自动重试/自动加资源入口** |
| 证据失效 | `recordEvidenceInvalidation` ⇒ 记录事实（新 V/失效要求/原因）+ 暂停 + `requiresReplanning`；**无改权重入口** |
| 防伪造 | 只接受 `recordedBy:"local-verifier"`（类型 + 运行时双检）；模型不得伪造已执行 |
| 不越权 | 门禁不调工具、不写文件、不放宽权限；副作用仍走原门禁 |

**未做（如实）**：**未接进派发**（没有调用方，目标模式暂不改变真实行为）；
**未持久化**（计数/暂停原因/证据缺口在内存，重启归零，属 03）；无 UI/CLI；
预算边界只是目标级、未与既有调度预算做统一"取更严"计算；`pauseConditions` 未评估；
未跑"三组不降 ⇒ 暂停/调查组不罚/模型伪造被拒/证据失效 ⇒ 暂停且权重不变"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### 03 恢复、可观察性与实验退出——**部分交付**（2026-10-28）

**审查发现**：01/02 的状态都在内存：重启后累计预算、暂停原因、当前组、V 依据全部丢失；
也没有"关闭实验"的安全语义；恢复时若直接重跑可能重复副作用。

**交付**（`packages/core/src/orchestration/goal-mode-store.ts`）：
| 要点 | 说明 |
|---|---|
| 持久化 | `<state>/goal-mode/<goal>.json`：目标/契约版本/owner/原始要求引用、**V 逐项依据**、last-known V、当前组、累计工具调用/成本、暂停原因、证据缺口、`requiresReplanning`、实验关闭标记、门禁快照 |
| 恢复先对账 | `evaluateResume`：在途组 ⇒ **`reconcile-first`**（禁止直接重跑）；暂停/需重规划/已关闭 ⇒ `stay-paused`；否则 `resume`（只带 last-known V，不重算、不宣称稳定） |
| 版本不串 | `contractRevision`/`sourceRequestReference` 不一致 ⇒ 直接拒绝 |
| 实验退出 | `closeExperiment` 只置标记+时间+暂停原因；**保留**任务/历史/限制/已执行结果 |
| 状态视图 | `describeStatus` 返回状态/缺口数/资源消耗/下一检查点；`stabilityGuarantee` **恒为 `"none"`** |
| 原子性 | 原子写 + 互斥 + 备份恢复；损坏按"无状态"处理，不伪造历史 |

**未做（如实）**：**未接进恢复流程**（`resumeMission` 不调用 `evaluateResume`）；
**未接进派发**（"关闭实验 ⇒ 停新增派发"目前只是数据标记，无执行侧保障）；无 UI/CLI；
`consumedCostUnits` 无计价来源；`beginTaskGroup` 与真实副作用非同一事务（崩溃后只能提示对账）；
未跑"在途组 ⇒ reconcile-first/版本不一致 ⇒ 拒绝/关闭后不恢复且历史保留/状态视图无稳定性保证"任何一条。

**验证状态**：未编写/未运行测试；`npm run typecheck` exit 0、`npx eslint` exit 0、`npm run build` 成功。

### R5 激活成为唯一开关（2026-10-29）

**交付**：删除死常量 `GOAL_MODE_DEFAULT_ENABLED`；`resolveGoalModeActivation` 成为唯一判定；
`GoalContractStore.saveActivated` 在未激活时**拒绝创建契约**；运行时新增
`activateGoalMode` / `getGoalModeActivation`（默认未激活）；未激活时门禁解析器恒返回 `null`
（目标模式不参与派发/恢复）。ADR-0094。

**未做**：无 UI/CLI 调用激活入口；契约/绑定仍无写入方；强制模式仍缺省关；未运行验证。

### R30–R32 补充（2026-10-29）

- **R30**：控制面最小入口（`createGoalContract` / `bindMissionToGoal` / `unbindMissionFromGoal`
  / `refreshGoalGateCache`），只走宿主代码，默认不激活、不阻断（ADR-0116）。
- **R31**：`goal-mode status` 只读 CLI（契约数/绑定数/可还原/跳过原因），**无写命令**（ADR-0117）。
- **R32**：端到端静态核对（[GOAL02_END_TO_END_GAPS_2026-10-29](../reports/GOAL02_END_TO_END_GAPS_2026-10-29.md)）：
  **决定性缺口 = `GoalModeStateStore` 无任何写入方** ⇒ hydrate 恒 `state-missing`、
  `restoredCount=0`、解析器恒 null；`evaluateResume` 的拦截分支在生产上永不触发。
  另：强制模式无入口、激活无 CLI/UI、判定不落盘、`closeExperiment` 无调用方。

### R33–R37 补充（2026-10-29）

- **R33**：`createGoalContract` 首次写目标状态（ADR-0118）；**R34**：组开始/结束写状态，不推进 V（ADR-0119）。
- **R35**：判定落盘（有界 200，`goal-mode verdicts` 只读；ADR-0120）。
- **R36**：`closeGoalExperiment` 接线；已关闭目标以 `experiment-closed` 跳过还原（ADR-0121）。
- **R37**：收口报告（[GOAL02_CLOSURE_RECOMMENDATIONS_2026-10-29](../reports/GOAL02_CLOSURE_RECOMMENDATIONS_2026-10-29.md)）：
  **V 计算仍未接**（`recordGroupCompletion` / `recordToolCallConsumed` 零调用方）⇒ 门禁只剩静态判定；
  强制模式/激活仍无用户入口（建议走宿主启动配置，不做 CLI 命令）；无重新开启路径；组标识不持久。

### R38–R39 补充（2026-10-29）

- **R38**：本地 V 计算接入组结束（要求评估 → `computeGoalPotential` → `recordGroupCompletion` /
  `recordToolCallConsumed` → `finishTaskGroup`），失败只清在途标记（ADR-0122）。
- **R39**：F 阶段一致性自查（[F_PHASE_CONSISTENCY_2026-10-29](../reports/F_PHASE_CONSISTENCY_2026-10-29.md)）：
  **V 已接**（推翻 R37 报告 §2.1 的"未接"）；仍缺 = 强制模式入口、激活入口、重新开启、组标识持久、
  `groupKind` 区分；其中"入口形态"与"重开规则"**需产品决定**。

### R51–R54 补充（2026-10-29）

- **R51**：`groupKind` 接入组边界（`goalTaskGroupKindProvider`，同步纯函数；缺省仍 `normal`；
  仓内**没有判定策略**）（ADR-0126）。
- **R52**：组标识改为 `goal-group-<UTC14>-<n>`，跨重启可区分（ADR-0127）。
- **R53**：`goal-mode verdicts --export <path>` 只读导出 JSONL（ADR-0128）。
- **R54**：`PLAN_STATUS` A/B 段同步：A 段补 R51–R53；B 段把"组标识持久化"改为"**全局唯一**"、
  把"判定导出"改为"**导出已完成，缺轮转**"、把 "groupKind 区分"改为"**判定策略**"（不再说"一律 normal"）。

### R70 内核/UI 职责划分核对（2026-10-30）

按"内核（公开仓）完成闭环职责、UI（私有仓）只做呈现与操作"核对：[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md)。

**结论**：内核**尚不能闭合**。关键缺口 K1（目标设立入口）、K2（requirements↔任务映射）、
K3（契约变更 API）、K7（完成判定耦合）、K8（失活/归档）、K10（运行中暂停）；
K4/K5/K6/K9/K11/K12 为"已实现未接线"或低量级补齐。

**UI 侧**：`astarray-ui` 目前**没有目标模式任务卡**（仅在索引里提及），且依赖 K1/K8/K9/K12 尚不存在。

### R71 内核缺口第一批（2026-10-30）

- **K9 状态视图**：`runtime.describeGoalStatus` + CLI `goal-mode status --goal <id>`（无状态 ⇒ 2）。
- **K8 失活**：`runtime.deactivateGoal`（关闭 + 解绑所有 mission + 刷新；**不删文件**，历史保留）。
- **K3 契约变更**：`validateGoalContractChange`（来源/revision/supersedes/总权重）+ `runtime.updateGoalContract`
  （累计预算不重置、旧证据作废并置 `requiresReplanning`）。
- **测试**：`tests/core/goal-contract-change.test.ts` 6/6 通过。
- **仍缺**：K1 目标设立入口、K2 requirements↔任务映射、K7 完成耦合、K10 运行中暂停；
  K4/K5/K6/K11 因**缺信号源**（不变量违规检出、证据失效检测、pauseConditions 结构化语义、
  任务总预算）暂不能诚实接线。ADR-0136。

### R72 要求 ↔ 任务节点映射（K2，2026-10-31）

- 新增 `GoalRequirementMappingStore`（`goal-mode/requirement-mappings/<goal>.json`）：绑定/覆盖/清除，
  记录写入时的契约 revision；revision 不一致 ⇒ 映射失效（不迁移）。
- 运行时 `bindRequirementTaskMapping`（校验契约与要求存在）；组结束算 V 时优先使用动态映射，
  无映射回退契约静态字段。
- **测试**：`tests/core/goal-requirement-mapping.test.ts` 5/5 通过。
- **未做**：无自动映射（须宿主/规划器显式写入）、无单节点解绑、运行时接线未集成测试。ADR-0137。

### R73 目标提案与用户确认（K1，2026-10-31）

- `proposeGoalContract`：只落提案（默认 30 分钟过期；`sourceRequestReference` 由 harness 注入），
  不落契约/不绑定/不派发。
- `confirmGoalContract`：必须 `isUserConfirmation:true` + 通过激活判定；过期/已确认给别的目标一律拒绝；
  通过后生成 revision 1 契约并写初始状态（任务节点留空给 K2）。
- **测试**：`tests/core/goal-contract-proposal.test.ts` 7/7 通过。
- **未做**：**未注册为 agent 工具**（模型还不能在对话里主动提议）、无 UI/提案列表/撤回、
  运行时接线未集成测试。ADR-0138。

### R74 目标完成耦合（K7，2026-10-31）

- 纯判定 `evaluateGoalCompletion`：实验关闭 ⇒ 不适用；revision 不一致/需重规划/暂停 ⇒ 拒绝；
  每条要求须 `valid` 且剩余量 0；多余依据拒绝；`lastPotentialValue` 必须为 0。
- 运行时端口 `missionCompletionGoalPort`（仅 `isGoalCompletionRequired === true` 时装配）：
  未绑定 ⇒ 不参与；契约/状态缺失 ⇒ 拒绝。
- `finishMission("done")` 先问目标，不通过 ⇒ **降级 blocked** + 升级原因（不先判完成后回滚）。
- **测试**：`tests/core/goal-completion-requirement.test.ts` 5/5 通过。
- **未做**：**默认关**；无集成测试；依赖 K2 映射（无映射时开启会几乎阻断所有完成）。ADR-0139。

### R75 组边界门禁复查（K10，2026-10-31）

- 编排器 `goalGroupBoundaryGatePort`：每个安全点（无在途任务）复查一次；不通过 ⇒
  `onUserEscalation` + `finishMission("blocked")` + 停止调度；**抛错同样保守停止**。
- 控制器仅在 **`isGoalModeEnforcementEnabled === true`** 且装配 resolver 时提供端口，
  复用 `observeGoalDispatchGate`（判定照常落盘/输出）。
- **默认（强制关）不装配**：行为不变，只观察。
- **未做**：无集成测试、无节流（每轮都查）、停止后无"恢复"入口；依赖 V/暂停准确性。ADR-0140。

### R76 暂停条件收窄为可评估枚举（K6，2026-10-31）

- 暂停条件从自由文本改为有限枚举：`budget-exhausted` / `deadline-passed` / `stagnation` /
  `requires-replanning`；**未知条件由契约校验拒绝**。
- 纯评估 `evaluateGoalPauseConditions`：只评估已声明条件，返回原因与触发项。
- 组结束（V 计算后）用**门禁实时计数**评估，触发 ⇒ `gate.pause(...)`，状态/快照自然带暂停原因。
- **测试**：`tests/core/goal-pause-conditions.test.ts` 8/8 通过。
- **未做**：`maximumWallClockSeconds` 未评估（无可靠目标开始时间）、无集成测试、暂停不自动恢复。ADR-0141。

### R77 预算取更严（K11，2026-10-31）

- 门禁新增 `applyExternalBudgetLimit`：有效上限 = **min(契约上限, 外部任务预算)**；
  拒绝时注明"取更严"与更严一方来源。
- `GoalGateCache` 接受 `externalToolCallBudget`，hydrate 还原门禁后注入；运行时选项
  `missionToolCallBudget`（**不持久化**，重启需重新注入）。
- **测试**：`tests/core/goal-budget-stricter.test.ts` 5/5 通过。
- **未做**：外部预算需宿主注入（未从 `maximumLoopIterations` 推导）、只覆盖工具调用数、
  无集成测试。ADR-0142。

### R78 安全不变量结构化 + 权限拒绝接入（K4，2026-10-31）

- `nonViolableInvariants` 收窄为枚举：`tool.permission-denied` / `scope.project-boundary` /
  `storage.protected-write` / `installation.gate`；未知标识由契约校验拒绝。
- 门禁 `recordInvariantViolation`（只有声明时才记录）+ `assertDispatchAllowed` ⇒
  `safety-invariant-violated`；**独立于 V**（不因 V 下降清除）。
- 生产者（当前唯一）：工具端口装饰捕获 `tool-permission-denied` ⇒ 上报；原错误照常抛出。
- **测试**：`tests/core/goal-invariant-violation.test.ts` 4/4 通过。
- **未做**：其余三个标识**无生产者**；违规**不持久化**；无集成测试；语义偏保守
  （任何权限拒绝都算）。ADR-0143。

### R79 证据失效的内核写入点（K5，2026-10-31）

- 纯变换 `buildInvalidatedGoalState`：指定要求 ⇒ `invalidated` + 原因、剩余量回权重、**重算 V**
  （`unreliable` ⇒ `null` 不给伪数字）、置 `requiresReplanning`/暂停原因/缺口、快照同步、revision+1；
  未知要求抛错（不静默忽略）。
- 运行时 `invalidateGoalEvidence`：写状态 + **同步所有已绑定 mission 的门禁**
  （V 可算 ⇒ `recordEvidenceInvalidation`；不可算 ⇒ 只 `pause`）。
- **测试**：`tests/core/goal-evidence-invalidation.test.ts` 3/3 通过。
- **未做**：**仍无检测器**（"何时失效"由宿主/未来检测器决定）、无集成测试、只到"要求粒度"、
  旧证据引用被覆盖。ADR-0144。
