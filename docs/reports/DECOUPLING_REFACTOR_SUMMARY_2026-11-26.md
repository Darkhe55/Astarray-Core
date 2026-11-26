# Astarray-Core 分阶段解耦改造总结（2026-11-26）

> 依据：`docs/reports/AXIOMATIC_DESIGN_MATRIX_2026-11-26.md`（公理设计矩阵）与 `docs/design/REFACTOR_PLAN_2026-11-26.md`。
> 纪律：每阶段先写反例测试 → `typecheck/lint/test/test:scripts/隐私` → 同步文档 → 提交推送；公共行为保持兼容。

## 一、阶段成果

| 阶段 | 交付物 | 反例测试 | 状态 |
|---|---|---|---|
| P1 判定三角化 | `orchestration/mission-completion-decision.ts`（`decideMissionCompletion`：task-chain → receipts → verdict 固定顺序；strict-off 跳过后两步；读取失败抛错、不 fail-open） | 7 | ✅ |
| P2 子门面 | `public-sdk-facets/`：`permission`(10 方法)、`ops`(4)、`goal`(12)、`context`(2)、`mission`(7)；门面只读 getter + 委托；CLI 三处接入（goal/permission/run） | 8+5+5+5+11 = 34 | ✅（写路径主体保留，见三） |
| P3 权限服务 | `permission-resolution.ts`（纯判定）、`permission-overview.ts`（概览装配）、`permission-resolution-service.ts`（端口注入服务） | 6+5+6 = 17 | ✅ |
| P4 目标门禁 | `goal-dispatch-gate-adapter.ts`（观察/强制 + 判定记录类型迁出） | 5 | ✅ |
| P5 治理 | `scripts/lib/decoupling-import-rules.mjs` + `check-decoupling-imports.mjs`（规则检查并入 `test:scripts`）；`application/runtime-option-groups.ts`（分组入口 + 冲突显式报错） | 7+6 = 13 | ✅ |

## 二、指标对比（实测）

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `main-controller.ts` imports | 107 | **85** |
| `main-controller.ts` 行数 | 6183 | 6219 |
| `public-sdk.ts` 行数 | 8540 | 8599（签名与委托保留，逻辑迁出） |
| 子门面文件 | 0 | **5** |
| 新增服务/适配器 | 0 | **5** |
| 新增反例测试 | — | **69 条**（含 7 条脚本反例） |
| 全量测试 | 6374 | **6445** |
| `test:scripts` | 51 | **58** |
| 分支覆盖率 | 83.05% | **83.3%** |

## 三、未关闭项（诚实记录）

1. **Mission 写路径主体仍在门面**：`submitTask`/`cancelTask` 与幂等账本、指令窗口、槽位补位、监视器共享门面状态，**跨方法状态耦合**大于单方法依赖，强拆会引入行为风险；当前以「facet 薄委托 + 门面持有状态机」处理，`queryTask` 已完整迁出。
2. **CLI 未全量窄依赖**：`goal-mode-command`、`parameter-authorization-settings-command`、`run-command` 已切；其余命令（提交/取消/观察类）仍调用整门面。
3. **`public-sdk.ts` 行数未降**：子门面迁移保留同签名委托，行数反而因 getter/工厂略增；「单文件 < 3000 行」目标需要 Mission/Context 大块实现真正迁出（属后续阶段）。
4. **85% 全局覆盖阈值仍差 1.7pp**：属既有 B9 缺口（83.3%），本轮未回归；目标约束「不低于 83.05%」已满足。

## 四、可复现验证

```bash
npm run typecheck
npm run lint
npm test
npm run test:scripts
npm run verify:privacy
npm run verify:decoupling-imports
```

最近一次结果：`typecheck` 0、`lint` 0、`test` 1027 files / 6445 tests 全过、`test:scripts` 58/58、隐私 `privacy-ok`、import 规则零违规。
