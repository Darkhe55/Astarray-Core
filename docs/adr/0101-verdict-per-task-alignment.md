# ADR-0101 完成裁决逐任务对齐（完成门禁生产方 R12）

- 状态：已采纳（代码层；未运行验证）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R12
- 相关：ADR-0099（裁决读取）、ADR-0100（裁决落盘）

## 1. 背景

R10 的聚合是 **mission 级**："该 mission 全部裁决 accepted ⇒ 通过"。
问题：**某任务根本没有裁决时也能通过**（只要其它任务都 accepted）——
这等于允许"只审一部分就宣布整单完成"。

## 2. 变更（冻结）

1. 读取端口签名改为 `(missionIdentifier, taskIdentifiers[])`；
2. `projectMissionCompletionGate` 把**已 done 任务**列表传给读取端口；
3. 运行时实现**逐任务对齐**：
   - 每个任务都必须有裁决；**缺任何一个 ⇒ 不通过**，理由 `缺少任务裁决: a, b`；
   - 任意任务 `rejected` ⇒ 不通过，理由 `task: reason`；
   - 全部 `accepted` ⇒ 通过；
   - **空列表 ⇒ null**（没有可判任务）。
4. 存储缺失/损坏一律按"缺裁决"处理（不伪造）。

## 3. 生产调用链（源码位置）

```
MainController.projectMissionCompletionGate          main-controller.ts
├─ doneTaskIdentifiers = tasks.filter(done).map(id)
└─ completionVerdictReader(missionId, doneTaskIdentifiers)   ← application-runtime
   └─ CompletionVerdictStore.read(missionId, task) × N（逐任务）
      └─ 缺裁决 / rejected ⇒ 汇总理由，isAccepted=false
```

## 4. 未完成（如实）

- **裁决写入仍有缺口**：独立工作流任命无 mission ⇒ 不落盘（R11 已知）。
- **"已 done 任务"依赖任务链状态**：若任务状态被误标 done，裁决对齐也无从发现
  （完成门禁的"任务链全 done"仍是前置条件，两者叠加才生效）。
- **没有 UI**：缺口只进 `blockedReasons` 文本与流式输出。
- **未运行验证**：没跑过"缺一个任务裁决 ⇒ 不通过""有 rejected ⇒ 不通过""全 accepted ⇒ 通过"
  任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
