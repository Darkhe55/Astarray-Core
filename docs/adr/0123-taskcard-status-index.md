# ADR-0123 任务卡的只读状态索引（G 阶段 R40）

- 状态：已采纳（脚本 + 生成报告；**只统计文档事实**）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R40
- 相关：`TASKCARD_BACKLOG_2026-10-17.md`（人工台账）

## 1. 背景

42 张任务卡的状态只存在于各自的 Markdown 里（checkpoint 记录、ADR 引用、"未完成"段落）。
要回答"哪些卡最近动过 / 哪些还没闭合"只能人工逐份翻，容易漏。

## 2. 交付

1. `scripts/manual/taskcard-status-index.mjs`（**只读**）：
   - 扫描 `docs/tasks/**/*.md`；
   - 统计**文档事实**：去重 checkpoint 标识数（`R<n>` / `第 N 轮`）、ADR 引用数、
     是否出现"平台阻塞/blocked"、是否出现"未完成/in_progress"、最近日期、行数；
   - 输出 Markdown 表；**不导入产品代码、不读状态目录、不验证任何行为**。
2. 生成报告 `docs/reports/TASKCARD_STATUS_VIEW_2026-10-29.md`（本次实际运行产物）。

## 3. 使用方式

```powershell
cd astarray
node scripts/manual/taskcard-status-index.mjs
node scripts/manual/taskcard-status-index.mjs > docs/reports/TASKCARD_STATUS_VIEW.md
```

## 4. 这份数据能说明什么 / 不能说明什么

**能**：某卡被改动过多少次（checkpoint 标识数）、引用了多少 ADR、是否自述未完成/阻塞。

**不能**：
- 不能说明卡内任务**真的完成**（"提到未完成"只是文本）；
- 不能替代 `PLAN_STATUS` 或人工验收；
- 不校验 `TASKCARD_BACKLOG_2026-10-17.md` 的 42 张卡清单是否与本目录一致
  （交叉核对**尚未实现**，属 R41 候选）。

## 5. 验证状态

- 脚本**已运行**（**只读文档扫描**，不涉及产品行为）：exit 0，生成 71 行报告；
- 未跑任何产品测试；未改任何卡；
- `npm run typecheck` / `eslint` / `build` 不受影响（脚本为 `.mjs`，不进构建）。
