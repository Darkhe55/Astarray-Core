# ADR-0082 目标门禁的只读接线（清单第 ⑥ 项）

- 状态：部分采纳（调用点 + 运行时透传；宿主未提供 resolver）
- 日期：2026-10-28
- 来源：[STATUS_UPDATE_WIRING_GAPS_2026-10-28](../reports/STATUS_UPDATE_WIRING_GAPS_2026-10-28.md) 清单第 ⑥ 项
- 相关：ADR-0076（门禁）、ADR-0077（持久化）

## 1. 背景

`GoalDispatchGate` 已经能判定 paused / replanning / revision / scope / deadline / budget，
但**没有任何派发路径调用它** —— 门禁存在，却无人问它。直接把门禁变成强制会立刻改变行为
（默认无目标契约时它也无从判定），所以先做**只读接线**：让判定可被观察，再由开关决定是否强制。

## 2. 契约（冻结）

1. **默认不参与**：未提供 `goalDispatchGateResolver` ⇒ 启动/继续 mission 的行为**逐字不变**
   （`observeGoalDispatchGate` 直接返回"未阻断"）。
2. **只读判定**：解析器返回门禁后，调 `assertMissionDispatchAllowed`
   （mission 级检查：只比项目 scope，不因工具白名单误拦；工具级检查仍在工具执行前）。
3. **只观察不阻断**：`isGoalModeEnforcementEnabled !== true` 时，判定与原因**记录 + 流式输出**，
   派发照旧。
4. **可选强制**：为 true 时，判定不放行 ⇒ mission 置 `blocked` 且**不启动调度器**。
5. **上报结构化**：`onGoalDispatchVerdict` 收到 `GoalDispatchVerdictRecord`
   （mission / 项目 / 契约 revision / 是否放行 / 原因码 / 原因 / 证据缺口 / **是否真的阻断** / 时间）。
6. **两个入口都覆盖**：`launchAssistMission` 与 `launchDevolveMission`。

## 3. 生产调用链（源码位置）

```
MainController.launchAssistMission / launchDevolveMission     packages/core/src/orchestration/main-controller.ts
└─ observeGoalDispatchGate(missionId)
   ├─ options.goalDispatchGateResolver?.(missionId)（缺省 ⇒ 不参与）
   ├─ GoalDispatchGate.assertMissionDispatchAllowed({contractRevision, projectIdentifier, nowIso})
   ├─ options.onGoalDispatchVerdict?.(record)
   ├─ options.streamOutput(`[目标门禁] …`)
   └─ isGoalModeEnforcementEnabled && !isAllowed ⇒ updateMissionStatus("blocked") + return（不建调度器）
运行时透传
└─ application-runtime.ts：goalDispatchGateResolver / isGoalModeEnforcementEnabled / onGoalDispatchVerdict
```

## 4. 未完成（如实）

- **宿主未提供 resolver**：运行时选项已通，但**没有任何生产装配传入解析器** ⇒
  生产上**仍然不会产生任何目标门禁判定**（只是"插槽已开"）。
- **没有把 `GoalModeStateStore` 与门禁连起来**：解析器需要"按 mission 找到契约 + 恢复快照"，
  这层 owner 尚未实现（目标契约由谁创建/持久化也未接）。
- **恢复路径未覆盖**：本轮覆盖的是启动/继续时的调度器创建；`resumeMission` 的门禁判定
  仍只有 ADR-0064 的就绪分类（不查目标门禁）。
- **没有 UI**：判定只能从 `onGoalDispatchVerdict` 或流式输出看到。
- **未验证**：没有跑过"无 resolver ⇒ 行为不变""越 scope 只记录不阻断""强制开关 ⇒ blocked
  且不建调度器"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
