# ADR-0059 合并前审查证据绑定校验（ALIGN-03-05）

- 状态：部分采纳（证据一致性强制生效；审查者要求可选）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 05
- 相关：ADR-0012（Git 集成）、ADR-0058（审查者与干净工作区）、ADR-0055（独立审查）

## 1. 背景

卡内要求：审查结果绑定**任务、来源个体、产物 revision/commit、证据与结论**；
**过期或不匹配证据不能合并**；人工验收策略按现有协同/放权配置，**不凭本卡改变批准权**。

实测：`GitContributionReviewRecord` 已经记了 `taskId/baseCommit/headCommit/changedPaths/
reviewDecision/executedChecks`（本轮又加了审查者），但 `finalizeIntegration` **从不回看**这些字段
—— 只要报告里有 `integrationCommit`，就按"集成完毕"继续跑测试并可能合入目标分支。
也就是说：**审的是 A 版本、合并的是 B 版本**这种过期证据，之前拦不住。

（`AcceptanceVerdictGate` 那条链路已有 revision/commit 失效规则，但那是"验收裁决"，
不是"Git 贡献审查"，两者尚未统一。）

## 2. 契约（冻结）

合并（`finalizeIntegration`）前对每条 `accepted` 贡献逐项核对：

1. **结论**必须是 `accepted`（`rejected`/`needs-rework` 不参与合并）；
2. **任务绑定一致**：记录 `taskId` 必须等于待合并任务；
3. **产物可核对**：`baseCommit`/`headCommit` 非空且不相同；
4. **commit 真的在集成分支历史里**：用 `git merge-base --is-ancestor <head> refs/heads/<integration>`
   探测（非祖先 ⇒ 过期证据）。这一条**始终生效**，与本轮开关无关；
5. **审查者（可选要求）**：`isReviewRequiredForMerge=true` 时，审查者必须存在
   且**不等于贡献者**；缺省值 `null` 表示"未指定"，**不得**当作已审查；
6. **违反即不合入**：原因写进 `unresolvedRisks` 并**直接返回报告**（不抛错、不删报告），
   由人工处理后重新收尾；
7. **不改变批准权**：人工体验/操作授权/用户裁决仍由既有五门禁与用户配置决定，
   本卡只校验"证据是否还匹配"。

## 3. 生产调用链（源码位置）

```
finalizeIntegration                                              packages/core/src/orchestration/git-integration-coordinator.ts
├─ 逐条 accepted 贡献：
│  ├─ isCommitInBranchHistory（merge-base --is-ancestor；失败=不在历史）
│  └─ evaluateContributionReviewEvidence                       git-review-evidence.ts
│     （结论/任务绑定/base-head/祖先/审查者）
├─ 有不匹配 ⇒ unresolvedRisks + saveReport + return（不合入）
└─ 通过 ⇒ 集成测试 → [isTargetBranchMergeAllowed] 干净守卫 → 恢复点 → 合并目标分支
```

## 4. 未完成（如实）

- **审查者要求默认关闭**（`isReviewRequiredForMerge` 缺省 false）：旧报告与既有测试没有
  审查者字段，默认强制会让历史集成立刻不可收尾；是否改为默认强制需要产品决策。
- **只绑定 commit**：没有绑定任务序列 revision、没有绑定证据哈希（`executedChecks` 内容变化
  不会使评审失效），也没有校验 `changedPaths` 与当前 diff 仍一致。
- **未与 `AcceptanceVerdictGate` 统一**：Git 贡献审查与验收裁决仍是两条独立证据链。
- **未验证**：没有跑过"head 不在历史 ⇒ 拦下""任务不符 ⇒ 拦下""审查者缺失且开启要求 ⇒ 拦下"
  "全部匹配 ⇒ 正常合入"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
