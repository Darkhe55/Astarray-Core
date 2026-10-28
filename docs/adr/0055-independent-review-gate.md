# ADR-0055 独立审查门禁：直属上级、非自报证据与纵深防御（ALIGN-03-01）

- 状态：部分采纳（契约与控制面入口；编排放行未接）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 01
- 相关：ADR-0025（任命与验收）、ADR-0047（报告索引）

## 1. 背景

卡内要求：次级任命**执行与测试/审查的具体下级**；同一执行任务的**自报不能代替独立审查结论**；
执行者只完成被分配任务链并向**唯一直属上级**报告；受控四级委派规则不变。

实测缺口（本轮核对）：

- `AgentAppointmentRegistry`（实现者不得自验、高风险三身份互异）与
  `AcceptanceVerdictGate`（裁决绑定 revision/提交哈希、高风险需人工）都已存在且实现完整；
- 但它们**只被 `StandaloneWorkflowRunner`（CLI 合成场景）使用**；assist/devolve 的真实
  任务完成路径既不任命、也不记录裁决，因此"独立审查"在主线里不存在；
- 任命只校验三个 id 互异：**不校验验收者的直属上级**（可以借别家次级的三级来签字）；
- 裁决只要求证据数组非空：**执行者自报**（"我完成了"）可以充当唯一"证据"。

## 2. 契约（冻结）

1. **直属上级**：验收者必须是 `RegisteredAgentDirectory` 里已登记的三级个体，且
   `missionId` 与本次任命一致、`owningSecondaryAgentInstanceId` **等于任命次级** ——
   执行/审查只对唯一直属上级负责。
2. **任命者不得自审**：`appointingSecondaryAgentInstanceIdentifier` 不得等于验收者。
3. **纵深防御**：即使任命数据被绕过，`recordVerdict` 仍拒绝
   `acceptingAgentInstanceIdentifier ∈ {实现者, 测试者}`。
4. **自报不是证据**：证据引用若**全部**带 `self-report:` / `executor-report:` / `agent-claim:`
   前缀（或为空），拒绝记录裁决 —— 必须至少一条外部可核对引用（工具结果、提交哈希、测试输出）。
5. **理由必填**：裁决 `reason` 空白即拒绝（不允许"只给结论"）。
6. **既有规则不改**：revision/提交哈希失效、高风险需人工、低风险测试/验收同人需用户策略
   —— 全部沿用 `AcceptanceVerdictGate` / `AgentAppointmentRegistry`，本模块不重复实现。

## 3. 生产调用链（源码位置）

```
本地控制面（非模型工具）
├─ MainController.appointExecutionAndReview        packages/core/src/orchestration/main-controller.ts
│  └─ IndependentReviewGate.appoint                 independent-review-gate.ts
│     ├─ RegisteredAgentDirectory.getAgentEntry     直属上级/mission/角色校验
│     └─ AgentAppointmentRegistry.createAppointment 三身份隔离（既有）
├─ MainController.recordAcceptanceVerdict
│  └─ IndependentReviewGate.recordVerdict
│     ├─ 非实现/测试者（纵深防御）
│     ├─ 证据非"只有自报"
│     └─ AcceptanceVerdictGate.recordVerdict        签名/schema/revision（既有）
└─ MainController.evaluateTaskMergeReadiness
   └─ AcceptanceVerdictGate.evaluateMergeReadiness  合并就绪（既有）
```

## 4. 未完成（如实）

- **编排未强制**：任务 `done` 的完成门禁**没有**要求"存在独立验收裁决"；也就是说，
  即使不任命、不裁决，任务仍可能被判完成。这是 03-02/03-03（执行/审查/集成闭环）的范围。
- **无自动调用方**：三个入口目前只有控制面（UI/CLI/SDK 可调），任务完成时不会自动触发任命/裁决。
- **四级委派规则未改**（本卡明确不改）。
- **未验证**：没有跑过"跨次级借人 → 拒绝""只有自报 → 拒绝""正常三方任命 → 裁决 → merge-ready"。
- 证据前缀清单是**约定**而非封闭集合：执行者若换一种措辞仍可冒充"外部证据"，
  真正的强约束要等 03-02 把工具结果/提交哈希做成**结构化**证据引用。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
