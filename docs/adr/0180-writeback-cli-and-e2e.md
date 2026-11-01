# ADR-0180 写回 CLI 与真实存储端到端（R121，2026-11-01）

- 状态：**已实现并跑通**（CLI + 真实存储夹具；发现 id 对齐缺口）
- 来源：用户"加 CLI 入口做一次真实序列端到端"
- 相关：ADR-0179（应用引擎）、ADR-0114（提案）

## 1. 新增 CLI

```
task-ledger apply-writeback --mission <id> [--sequence <id>] [--owner <agent-instance>]
  --approved-by <user> --expected-revision <n> [--json]
```

流程：绑定索引补全 → 现生成提案 → 校验 `expectedRevision` → `applyWriteBackProposal`
（只执行 `mark-sequence-done`，人工批准，revision 双重校验）→ 输出 applied/skipped。

## 2. 真实存储端到端（夹具 `mission-wb`/`sequence-wb`）

```
status --propose-writeback → mark-sequence-done（T-01, revision 2）
apply-writeback --approved-by user-local --expected-revision 2
→ {"status":"writeback-applied","appliedTaskIdentifiers":["T-01"],"sequenceRevisionAfter":4}

序列文件：revision=4、T-01 status=done
auditEntries：publish + status-change("任务 T-01 → done")

再以 --expected-revision 2 应用：
→ {"status":"stale-revision", ... 当前提案基于 revision 4 ...}（退出码 1）
```

自动化：`tests/core/task-ledger-apply-writeback-cli.test.ts` 2/2（应用 + stale + index-missing）。

## 3. 发现：真实 mission 与序列的 id 不对齐

对全部历史绑定扫描：mission 任务 id 为 `T-01`/`T-001`，序列节点 id 为 `task-mission-<id>`
⇒ 两侧**没有共同 id**，提案只会产出 `missing-in-sequence` + `missing-in-mission`，
`mark-sequence-done` 在真实数据上**不可达**（本次端到端用夹具强制 id 对齐才走到该分支）。

这是两套记账的结构性缺口（ADR-0052/0110），不是本 CLI 的缺陷；要真正可用需先补 id 映射。

## 4. 验证

```
tests/core/task-ledger-apply-writeback-cli.test.ts → 2/2
tests/core --maxWorkers=2 → 471 files / 3620 tests 全通过（首轮两条瞬时失败，重跑 exit 0）
typecheck / lint / build → 全绿
```

## 5. 未完成

- **真实数据不可达 `mark-sequence-done`**（id 不对齐，见 §3）；
- 批准无身份校验（`approvedBy` 仅字符串）；
- 批量应用非原子；
- 其它动作（needs-review/missing-*）仍只能人工处理；
- CLI 无 `--dry-run`（提案阶段需先跑 status）。
