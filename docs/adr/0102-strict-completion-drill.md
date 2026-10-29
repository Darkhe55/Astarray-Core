# ADR-0102 严格完成门禁的验收演练脚本（完成门禁生产方 R13）

- 状态：已交付脚本（**未执行**；仅做语法检查）
- 日期：2026-10-29
- 来源：[NEXT60_PLAN_2026-10-29](../tasks/NEXT60_PLAN_2026-10-29.md) R13
- 相关：ADR-0095…0101（收据/裁决存储与读取）

## 1. 背景

收据与裁决两侧都已能写能读、且门禁要求逐任务对齐（R6–R12），但**没有任何可重复的验收步骤**。
窗口口径不允许跑测试/验收，所以本步交付**脚本 + 明确边界**，让"授权后怎么验"不再靠记忆。

## 2. 交付

1. `scripts/manual/strict-completion-drill.mjs`：
   - 用临时 state 目录，直接驱动存储层；
   - 覆盖四态：**齐备通过**、**缺收据 ⇒ 不足**、**缺裁决 ⇒ null**、**同任务不同内容拒绝覆盖**；
   - 断言失败时打印具体条目并以退出码 1 结束。
2. 公共 SDK 增补导出：`CompletionReceiptStore`、`CompletionVerdictStore`、
   `evaluateCompletionReceipt` 及其类型（**存储层 API，不改变门禁行为**）。

## 3. 覆盖范围（必须说清）

| 覆盖 | 不覆盖 |
|---|---|
| 收据写入/读取/幂等/拒绝覆盖 | `projectMissionCompletionGate` 的完整 mission 上下文 |
| 裁决写入/读取/缺裁决语义 | 真实任务链 + 调度器 + assist mission 端到端 |
| `evaluateCompletionReceipt` 的"缺失即不足" | 权限/租约/恢复路径 |
| 存储损坏 ⇒ null（间接：读取不抛） | UI 呈现 |

**不覆盖的那一行是重点**：完整门禁仍需人工起一个 assist mission 走一遍，脚本**不能**替代。

## 4. 验证状态

- 脚本**从未执行**；
- 只做了 `node --check`（语法检查，exit 0），**不构成行为验证**；
- `npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。

## 5. 未完成（如实）

- 未运行脚本（需用户授权）；
- 脚本只覆盖存储层，不覆盖控制器门禁；
- 没有 CI 接入（也不应在本窗口接）。
