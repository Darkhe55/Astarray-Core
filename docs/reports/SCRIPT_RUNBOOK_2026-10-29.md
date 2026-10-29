# 手动脚本运行手册（2026-10-29，R45）

> 目的：把本窗口交付的 5 个手动脚本的**前提、命令、预期输出与判读标准**写清。
> **本窗口从未运行前两个**（ADR-0102 / 0107）；后三个是文档扫描脚本，已运行过（见各 ADR）。
> 本文件**不声明任何产品行为已验证**。

## 1. 脚本清单

| 脚本 | ADR | 依赖 | 本窗口是否运行 |
|---|---|---|---|
| `scripts/manual/strict-completion-drill.mjs` | 0102 | **`npm run build` 产物**（`dist/public-sdk.js`） | **未运行** |
| `scripts/manual/egress-false-positive-probe.mjs` | 0107 | **`npm run build` 产物** | **未运行** |
| `scripts/manual/taskcard-status-index.mjs` | 0123/0124 | Node + `docs/tasks/**` + `git` | 已运行（文档扫描） |
| `scripts/manual/symbol-usage-audit.mjs` | 0125 | Node + `packages/`、`scripts/` 源码 | 已运行（文本扫描） |

**关键前提**：`dist/` 在 `.gitignore` 内（第 3 行）⇒ 新克隆**没有 `dist/`**，
前两个脚本必须先 `npm run build`，否则 `ERR_MODULE_NOT_FOUND`。

## 2. 严格完成门禁演练（ADR-0102）

```powershell
cd astarray
npm run build
node scripts/manual/strict-completion-drill.mjs
```

- **预期**：逐条打印 `ok`；临时 state 目录建了又删；退出码 0。
- **判读**：任何 `FAIL` 行 ⇒ 退出码 1，**说明存储层语义与文档不符**（不是"产品全坏"，
  脚本只覆盖收据/裁决的写入、幂等、拒绝覆盖、缺失判定）。
- **明确不覆盖**：`projectMissionCompletionGate` 的完整 mission 上下文（需真实 assist mission）。

## 3. 误报率探针（ADR-0107）

```powershell
cd astarray
npm run build
node scripts/manual/egress-false-positive-probe.mjs
```

- **预期**：8 条 normal 全 `clean`；6 条假凭据全 `hit`；汇总
  `falsePositives=0 missesOrOtherRules=0`；退出码 0。
- **判读**：`FLAGGED` 出现在 normal 上 ⇒ **误报**（直接关系"是否敢默认 block"）；
  `MISS/OTHER` ⇒ 规则与样本不匹配（可能是规则改名，需更新期望前缀）。
- **边界**：8+6 条样本**不足以**得出产品级误报率；只测规则命中，不测阻断行为。

## 4. 任务卡索引（ADR-0123/0124）

```powershell
cd astarray
node scripts/manual/taskcard-status-index.mjs
node scripts/manual/taskcard-status-index.mjs > docs/reports/TASKCARD_STATUS_VIEW_2026-10-29.md
```

- **前提**：在 git 仓库内运行（脚本用 `git log --diff-filter=A` 取首次提交日期；失败返回 null）。
- **预期**：Markdown 表 + "与台账交叉核对"一节；退出码 0。
- **判读**：只统计文档事实；`archive/**` 的"首次提交日期"是**移动日**，不能当新卡证据。

## 5. 符号使用审计（ADR-0125）

```powershell
cd astarray
node scripts/manual/symbol-usage-audit.mjs
```

- **预期**：29 行三态表；汇总"未找到 / 仅定义处 / 有外部引用"；退出码 0。
- **判读**：`未找到` ⇒ 证据索引过期；`仅定义处` ⇒ 需人工确认入口是否不可达
  （**不等于缺陷**，例如只经 SDK 暴露的入口）。

## 6. 为什么本窗口不运行前两个

窗口口径：**不编写/不运行产品测试、不做人工验收**。这两个脚本会执行真实产品代码路径
（收据/裁决存储、敏感扫描器），其结果会被误读为"验收通过"。因此：
- 脚本已提交、已做语法检查（`node --check`）；
- **没有运行记录，也没有任何"已验证"结论**；
- 授权后按上面命令执行，并把输出如实贴回台账。

## 7. 验证状态

**静态核对**（`.gitignore` 与 SDK 导出位置为证）；**本文件不含运行结果**。
