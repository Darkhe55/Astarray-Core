# ADR-0075 冻结目标契约与候选势函数（GOAL-02-01）

- 状态：部分采纳（契约 + 纯计算；门禁/持久化/接线未做）
- 日期：2026-10-28
- 来源：[GOAL-02](../tasks/GOAL02_BOUNDED_GOAL_STABILITY.md) 检查点 01
- 相关：ADR-0052（派发循环）、`tools/local-progress-and-cycle-guard.ts`

## 0. 先说边界（不可被引用为别的意思）

- 保留用户原文为**优化目标**；**不宣传**"已证明永不偏航"。
- 开放世界行动与外部扰动**无法**仅凭评分保证；首版是"**受约束目标推进**"，**不是新的权限模式**。
- 与思索/协同/放权正交、**默认关闭**、仅认证用户可开启。
- `V = 0` 只表示"当前**已枚举**要求具有有效证据"，**不等于现实世界完整正确**。
- 安全不变量**独立于 V**，不允许"进展收益抵消越权风险"。
- 本模块只做**契约与纯计算**，不派发、不联网、不读写盘。

## 1. 背景

仓库里有循环守卫（调用环/无进展计数/单飞/预算），但**没有**目标契约与进展模型。
循环守卫不等于目标一致性证明：它只防"原地打转"，不回答"是否还在朝原目标推进"。

## 2. 契约（冻结）

1. **GoalContract**：`goalIdentifier`、`revision`、`ownerIdentifier`、`sourceRequestReference`、
   原始目标文本、范围（项目 + 允许工具名，可为 null 表示不限制）、**不可违反项**、
   要求列表、资源上限、截止时间、暂停条件、`supersedesRevision`。
2. **版本变更**：`assertGoalRevisionChangeAllowed` —— 只有**原任务发布方**或**认证所有者**
   可以改；`model-proposal` / `tertiary-agent` **一律拒绝**；revision 必须逐次 +1
   （变更**不重置**累计预算，预算在目标级资源上限里，不在本函数）。
3. **候选势函数**：`V = Σ weight × remainingRequirement`（权重为正）。
   - 只有 `evidenceKind` 为 `deterministic-check` 或 `independent-acceptance` 才记 0；
   - `unverified` / `invalidated` / **缺少评估记录** 都记满权重（不静默降分）；
   - **不使用**工具调用数、模型信心、输出字数降分。
4. **未知优于伪精确**：存在 `completionPredicateKind === "unreliable"` 的要求时返回
   `status:"unknown"` 并列出要求，**不给数字**。
5. **拆分守恒**：`assertSubRequirementWeightsPreserveParent` —— 子权重之和必须等于父权重，
   拆分不改变总权重（浮点用容差）。
6. **安全不变量独立**：`evaluateSafetyInvariants` **不接受 V 参数**（结构上隔离）；
   违反即 `isSatisfied:false`，与 V 是否下降无关。
7. **默认关闭**：`GOAL_MODE_DEFAULT_ENABLED = false`；
   `resolveGoalModeActivation` 要求"用户来源 + 认证用户 + 显式请求 + 显式开启"四者同时成立，
   模型/三级 Agent 的"我已开启"不构成证据。

## 3. 生产调用链（当前）

**没有生产调用链** —— 本检查点只交付契约与纯函数；门禁（02）与持久化/恢复（03）才把它接进派发。
这也是"已实现但未接线"的如实状态。

## 4. 未完成（如实）

- **没有接进派发**：目标模式不会拦截/暂停任何任务组（属 02：三组不降 V 才暂停）。
- **没有持久化**：V 的逐项依据、累计预算、当前组、暂停原因都还没有落盘（属 03）。
- **没有 CLI/UI**：用户无法开启目标模式、查看 V 与证据缺口、暂停/重定向。
- **没有把"调查/测试/返工不计降"建模**：当前只看证据；"允许暂时不降"的窗口属 02。
- **没有理论证明**：本 ADR 不声称 Lyapunov 稳定性；只借用"候选势函数 + 不变量"的工程类比。
- **未验证**：没有跑过"模型改目标被拒""拆分不降 V""无证据不降分""不可靠谓词 ⇒ unknown"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
