# ADR-0058 Git 集成：审查者独立与"干净工作区"守卫（ALIGN-03-04）

- 状态：部分采纳（审查者字段 + 两道工作区守卫；审查者注册校验与分配入口未做）
- 日期：2026-10-28
- 来源：[ALIGN-03](../tasks/ALIGN03_EXECUTION_REVIEW_FEEDBACK.md) 检查点 04
- 相关：ADR-0012（Git 集成）、ADR-0055（独立审查）、ADR-0057（完成收据）

## 1. 背景

卡内要求：涉及 Git 的任务由次级创建隔离工作区/分支、**指定审查者**、判定返修或合并；
三级**只提交自己的分支**、不直接合入目标分支；**不覆盖人工并行修改、不自动 stash/reset**。

实测（本轮核对）：

- **已具备**：`GitWorktreeAllocator` 给三级分配独立 worktree/branch；三级贡献先经
  `GitContributionVerifier`（身份/祖先/越界/敏感信息/测试证据）审查；通过后由协调器
  `merge --no-ff` 进**集成分支**（不是目标分支）；目标分支合并另由
  `finalizeIntegration` + 五门禁证据（`isTargetBranchMergeAllowed`）控制，当前恒 false。
- **缺口 1（审查者）**：`GitContributionReviewRecord` 只有 `contributingAgentInstanceId`，
  **没有审查者字段**，也就无法表达/强制"作者不能自审"。
- **缺口 2（人工并行修改）**：`submitContribution` 与 `finalizeIntegration` 都在**共享仓库**
  里 `checkout` + `merge`，**没有检查工作区是否干净** —— 若有人工未提交改动，
  切分支/合并会携带它们；（虽然不会自动 stash/reset，但也不该在脏工作区上操作。）

## 2. 契约（冻结）

1. **审查者字段与独立性**：`SubmitContributionInput.reviewingAgentInstanceIdentifier` 可选；
   给出时**不得等于贡献者**（作者自审 ⇒ `task-sequence-permission-denied`）；
   记录进 `GitContributionReviewRecord.reviewingAgentInstanceIdentifier`。
2. **未指定 ≠ 已审查**：缺省/空 ⇒ 记录 `null`，读取方不得把它当作"已审查通过"。
3. **干净工作区守卫（提交侧）**：合并前检查 `git status --porcelain --untracked-files=no`；
   非空 ⇒ 抛 `stale-human-change`，**拒绝**切换分支/合并，并明确说明
   "本流程不会 stash/reset/checkout 丢弃这些改动"。
4. **干净工作区守卫（收尾侧）**：目标分支合并前同样的检查；脏 ⇒ 把风险写进报告并
   **不合入**（报告保留，返回而不抛），由人工处理后再收尾。
5. **只看已跟踪改动**：`--untracked-files=no` —— 未跟踪文件不会被 checkout/merge 静默覆盖
   （git 会拒绝冲突覆盖），把构建产物也算进来只会误挡正常合并。
6. **`reset --hard` 的唯一边界**：仅存在于**显式恢复点恢复**（`restoreRecoveryPoint`），
   且恢复前会自动创建"恢复前"恢复点（可撤销）；本检查点**未新增**任何 stash/reset/丢弃逻辑。

## 3. 生产调用链（源码位置）

```
三级提交贡献
└─ GitIntegrationCoordinator.submitContribution                 packages/core/src/orchestration/git-integration-coordinator.ts
   ├─ readAllocation（worker 分支/集成分支/个体身份）
   ├─ 审查者独立性校验（reviewing ≠ contributor）
   ├─ GitContributionVerifier.verifyContribution（既有）
   ├─ [accepted] status --porcelain --untracked-files=no  ⇒ 脏则抛 stale-human-change
   ├─ checkout 集成分支 → merge --no-ff → detach
   └─ 报告追加（含 reviewingAgentInstanceIdentifier）
收尾
└─ finalizeIntegration
   ├─ 集成测试（失败 → unresolvedRisks 并返回）
   ├─ [isTargetBranchMergeAllowed] status 干净守卫 ⇒ 脏则不合并、记录风险并返回
   └─ 恢复点 → checkout 目标分支 → merge → detach（失败走只读对账）
```

## 4. 未完成（如实）

- **审查者未做注册/隶属校验**：协调器没有 `RegisteredAgentDirectory` 端口，
  只校验"不等于贡献者"，未校验"已登记/直属上级"（ALIGN-03-01 的规则尚未接到 Git 路径）。
- **没有"指定审查者"的分配入口**：审查者只能由调用方传入，生产路径没有任命 API。
- **目标分支合并仍恒不可用**：`isTargetBranchMergeAllowed` 依赖五门禁证据，其中人工体验/
  操作授权没有来源 ⇒ 恒 false（既有结论，未变）。
- **人工并行修改的判定只有"干净/脏"**：没有按路径判断"是否触及本次贡献的路径"，
  也没有与 `human-worktree-observer` 的改动分类联动。
- **未验证**：没有跑过"脏工作区 ⇒ 拒绝""审查者=贡献者 ⇒ 拒绝""干净 ⇒ 正常合并"任何一条。

## 5. 验证状态

**implemented-unverified**：未编写/未运行测试、未做人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
