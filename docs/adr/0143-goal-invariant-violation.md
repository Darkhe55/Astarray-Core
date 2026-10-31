# ADR-0143 安全不变量：结构化标识 + 权限拒绝接入（K4，2026-10-31）

- 状态：已采纳（标识白名单 + 门禁记录/阻断 + 工具权限拒绝作为唯一生产者；**默认不阻断**）
- 来源：用户"开始"；[GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30](../reports/GOAL02_KERNEL_UI_SPLIT_GAP_2026-10-30.md) K4
- 相关：ADR-0092（门禁）、ADR-0141（K6 同类收窄）、ADR-0142（K11）

## 1. 背景

`evaluateSafetyInvariants` 需要"哪些不变量被违反"的输入，但仓内**没有生产者**；
且 `nonViolableInvariants` 是自由文本，无法与本地拒绝信号可靠匹配。
卡要求"安全不变量独立于 V"、"进展收益不得抵消越权风险"。

## 2. 设计（冻结）

1. **结构化标识**（`goal-invariant-catalog.ts`）：
   `tool.permission-denied` / `scope.project-boundary` / `storage.protected-write` /
   `installation.gate`；**未知标识由契约校验拒绝**。
2. **记录**：`GoalDispatchGate.recordInvariantViolation({invariantCode, detail, recordedAtIso})`
   —— **只有契约声明了该标识才记录**（返回 `false` 表示未声明）。
3. **阻断**：`assertDispatchAllowed` 发现任何已记录违规 ⇒
   `reasonCode: "safety-invariant-violated"`，detail 与证据缺口列出违规；
   **独立于 V**（不因 V 下降清除；测试覆盖）。
4. **生产者（唯一，当前）**：工具端口装饰（`main-controller`）捕获
   `DomainError.errorCode === "tool-permission-denied"` ⇒ 上报
   `tool.permission-denied`（`工具名: 原因`），**照常抛出原错误**。
5. **生效条件**：契约声明该标识 **且** 强制模式开启（否则判定仍只记录）。

## 3. 调用链（源码位置）

```
worker 工具执行
└─ buildWorkerToolPortWithRecoveryCheckpointing 的装饰 execute
   └─ catch DomainError(tool-permission-denied)
      └─ onGoalInvariantViolation（runtime）
         └─ GoalGateCache.resolve(mission).recordInvariantViolation
            └─ 下次 assertDispatchAllowed ⇒ safety-invariant-violated
```

## 4. 运行证据

```
npx vitest run tests/core/goal-invariant-violation.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

覆盖：未声明 ⇒ 不记录且不影响派发；已声明 ⇒ 记录后派发被拒（原因/缺口可见）；
违规不因 V 下降被清除；契约校验拒绝未知标识、接受已知标识。

## 5. 未完成（如实）

- **只有 `tool.permission-denied` 有生产者**：其余三个标识是保留白名单，**写了也不会被触发**；
- **违规不持久化**：`GoalGateSnapshot` 没有该字段，重启后丢失（需重新检出）；
- **只在目标门禁内生效**：未绑定/未激活目标 ⇒ 不记录；强制关 ⇒ 只记录不阻断；
- **无集成测试**：工具拒绝 → 上报 → 门禁阻断的整条链路未在真实 mission 验证；
- **语义偏保守**："任何工具权限拒绝"都算违反该不变量；若用户只关心特定工具/路径，需要更细的标识。

## 6. 验证状态

门禁与契约规则：**已运行通过**（4 条单测）；工具端口接线：`implemented-unverified`。
