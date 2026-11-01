# ADR-0183 发布端自动登记整 mission 映射（R124，2026-11-01）

- 状态：**已实现并真实跑通**（发布即登记；提案走显式映射）
- 来源：用户"1"（让映射不再靠人工）
- 相关：ADR-0182（映射存储）、ADR-0181（整 mission 对齐）、ADR-0180（写在提案）

## 1. 做法

1. `missionTaskIdentifier` 增加哨兵 `"*"`：**整 mission ↔ 序列节点**（真实发布只有 1 个
   `task-mission-<id>` 节点，天然对应"整个 mission"）。
2. 控制器在 `registerUserTaskInSequence` 发布成功后**自动登记**映射
   （`missionId` / 序列 / owner / `"*"` / `task-<missionId>`）；失败忽略（不阻断发布）。
3. 提案的映射路径支持 `"*"`：mission 全部 done + 节点未 done ⇒ `mark-sequence-done`；
   未全部 done ⇒ `needs-human-review`。
4. `task-ledger bind-task-map` 允许 `--mission-task "*"`。

## 2. 真实证据

新 mission 一次真实运行（`mission-f2b5ef24`）后：

```
state/task-ledger/mission-task-maps.json
  missionIdentifier=mission-f2b5ef24  missionTaskIdentifier=*  sequenceTaskIdentifier=task-mission-f2b5ef24

task-ledger status --mission mission-f2b5ef24 --propose-writeback
→ proposedAction=needs-human-review（mission blocked，未全部 done）
  notes 含"按显式任务映射对齐（mission task ↔ 序列节点）"
```

即：**发布即登记**、**提案确实走映射路径**（notes 可区分）。

## 3. 验证

```
tests/core/mission-task-sequence-map.test.ts → 3/3（含哨兵 * 的两种结果）
tests/core/task-ledger-apply-writeback-cli.test.ts → 3/3（含哨兵登记）
tests/core --maxWorkers=2 → 471 files / 3627 tests 全通过
typecheck / lint / build → 全绿
```

## 4. 未完成

- 映射只在**首次发布**登记；mission 任务链后续拆分（T-01…）不影响哨兵语义，但**没有**逐任务映射；
- 登记失败被**静默忽略**（不升级），映射可能缺；
- 过期映射（节点被删/序列重建）不自动清理；
- 没有反向查询 CLI（序列节点 → mission）；
- 真实"发布→映射→写回"三连的自动化测试未做（本次为真实运行 + 单测）。
