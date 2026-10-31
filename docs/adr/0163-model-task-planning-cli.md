# ADR-0163 模型任务分解接入 CLI（R100，2026-11-01）

- 状态：已采纳（真实 mission 产出**两节点**任务链：`outcome=model`）
- 来源：用户"接入"；卡验收"计划拆分不降 V / 每三组检查"的前提
- 相关：ALIGN-02-02 分解契约、ADR-0162（每三组检查）

## 1. 现状与改动

分解器早已存在（`createModelBackedTaskDecompositionProvider`），但：
1. **公开选项没透传**：运行时支持 `isModelTaskPlanningEnabled`，门面没暴露；
2. **规划器不知道可用工具**：提示词只有格式，模型会发明 `write_file` 之类未注册工具 ⇒
   本地契约判 `节点声明了未注册工具` ⇒ 降级单节点（首次实测就是这个原因）。

改动：
- 门面选项 `isModelTaskPlanningEnabled` 透传到运行时；
- CLI `run --model-planning`；
- 规划器新增 `availableToolNames`，提示词明确"toolNames 只能从这里选"，
  运行时用 `registry.getFullDescriptors()` 注入。

## 2. 真实运行证据（2026-11-01 03:2x）

```
run … --model-planning
→ mission-d5901d26

status → tasks=2
  T-01 failed  dependsOn=[]
  T-02 blocked dependsOn=[T-01]
summary → taskPlanningOutcome: "model"（不是降级）
```

即：**模型真的产出了两节点、带依赖的分解**，并通过本地契约校验；
（该次任务本身因"缺少完成控制事件"失败，属模型行为，不是分解问题。）

## 3. 全量验证

`tests/core --maxWorkers=2` → **471 files / 3600 tests 全通过**；`lint` 绿。

## 4. 未完成

- **多组完成未跑通**：本次 T-01 因完成控制事件缺失失败，没进到"多组完成后每三组检查"；
- 规划提示词仍可能产出不可执行节点（只做工具名校验，不做"节点数是否合理"判断）；
- `projectSummary` 仍为 null（未接项目摘要来源）；
- 真实 `--model-planning` + 目标模式 + 预算/停滞的联合演练未做。
