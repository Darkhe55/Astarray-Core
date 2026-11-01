# ADR-0181 两套记账的整 mission 节点对齐（R122，2026-11-01）

- 状态：**已实现并真实数据跑通**
- 来源：用户"1"（补 id 映射，让写回在真实数据可用）
- 相关：ADR-0180（写回 CLI 发现 id 不对齐）、ADR-0114（提案）、ADR-0052（结构性缺口）

## 1. 发现（真实数据）

真实 mission 的序列**只有 1 个节点** `task-mission-<missionId>`（`externalReference=mission:<id>`），
而 mission 链有多个 `T-0x`。两者没有共同 id —— 逐 taskId 比对必然产出
`missing-in-sequence` + `missing-in-mission`，`mark-sequence-done` 不可达。

## 2. 对齐规则（新增）

当序列**恰好一个节点**且该节点属于本 mission（`externalReference === mission:<id>`
或 `taskId === task-mission-<id>`）时，按**整 mission** 对齐：

| 情况 | 提案 |
|---|---|
| mission 全部 done + 节点未 done | `mark-sequence-done`，目标 `taskIdentifier = 序列节点 id` |
| mission 未全部 done + 节点未 done | `needs-human-review`（不单向推导） |
| 节点已 done | 无条目（不产出噪声） |

非"单节点 mission"的序列仍走原有逐任务比对（不会误伤）。

## 3. 真实数据端到端

```
status --propose-writeback --mission mission-90bc56fb
→ mark-sequence-done（task-mission-90bc56fb，revision 2）

apply-writeback --approved-by user-local --expected-revision 2
→ writeback-applied，sequenceRevisionAfter=4

序列文件：revision=4、节点 done、审计新增
  status-change("任务 task-mission-90bc56fb → done")
mission summary 仍为 done（未被改动）
```

## 4. 验证

```
tests/core/task-ledger-writeback-apply.test.ts → 7/7（新增 3 条整 mission 对齐）
tests/core --maxWorkers=2 → 471 files / 3623 tests 全通过
typecheck / lint / build → 全绿
真实数据：mission-90bc56fb 完成写回（见 §3）
```

## 5. 未完成

- 多节点序列（每任务一节点）仍会因 id 不同而误报；本次只覆盖"单节点 mission 序列"的真实形态；
- **没有持久 id 映射表**：依赖 `externalReference` 约定 + 单节点形态，形态变化会退化；
- 写回只处理整 mission 节点，**不会**把 mission 内的 `T-0x` 与序列多节点逐条映射；
- 其它动作（needs-review）仍只能人工。
