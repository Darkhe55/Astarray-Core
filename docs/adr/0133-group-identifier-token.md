# ADR-0133 组标识追加随机令牌（R64，2026-10-30）

- 状态：已采纳（生成逻辑已接；单测通过）
- 来源：用户选择 B3；[ADR-0127](0127-goal-group-identifier.md)（时间前缀）
- 相关：ADR-0119（组边界）

## 1. 背景

R52 的标识是 `goal-group-<UTC14>-<n>`：时间戳只到**秒**，`n` 是进程内计数。
同一秒内重启且计数器相同 ⇒ **理论上撞名**，而该标识会被写进
`PersistedGoalModeState.currentTaskGroupIdentifier` 与
`deferred-insertions.json.consumedByGroupIdentifier`，撞名会让对账失去依据。

## 2. 变更（冻结）

1. 新格式：`goal-group-<UTC14>-<n>-<8 位小写十六进制令牌>`
   例：`goal-group-20261030112233-3-0a1b2c3d`；
2. 时间戳仍取 `startedAtIso`（与标识同源），令牌缺省由 `randomUUID()` 派生 8 位；
3. 抽出纯函数 `buildGoalTaskGroupIdentifier` / `toGoalTaskGroupRunTag`
   （`packages/core/src/orchestration/goal-task-group-identifier.ts`），`runLoop` 调用它；
4. 非法输入（时间不可解析、序号非正整数、令牌非 8 位十六进制）**抛错**，不静默兜底。

## 3. 调用链（源码位置）

```
MissionOrchestrator.runLoop                       mission-orchestrator.ts
└─ startedAtIso = now
   └─ buildGoalTaskGroupIdentifier({startedAtIso, sequenceNumber, randomToken?})
      └─ goal-group-<UTC14>-<n>-<token>
         └─ beginPort({taskGroupIdentifier, startedAtIso}) → 持久化
```

## 4. 运行证据（真实）

```
npx vitest run tests/core/goal-task-group-identifier.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

覆盖：时间戳转换、非法时间抛错、格式、**同秒同序号不同令牌 ⇒ 不同标识**、缺省随机令牌格式、
序号/令牌非法抛错。

## 5. 未完成（如实）

- **不保证全局唯一**：仍是"时间 + 进程计数 + 8 位随机"，理论碰撞概率极低但非零（无持久序列/UUIDv7 单调保证）；
- **旧标识不迁移**（历史状态里仍是 R52 格式）；
- **编排器接线未集成测试**（只测了纯函数）。

## 6. 验证状态

生成逻辑（本测试覆盖部分）：**已运行通过**；编排器接线：`implemented-unverified`。
