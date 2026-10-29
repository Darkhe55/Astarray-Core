# 交付说明（草稿，2026-10-29，R55）

> 面向读者：项目负责人 / 验收者。
> 本窗口共 **34 个编号检查点（R21–R54）**，全部按"先读源码再改、显式路径提交、尝试推送"推进。
> **重要口径：本窗口没有编写或运行任何产品测试/人工验收**；下面所有"已交付"都是
> **代码接线 + 静态证据**，不是运行验证结果。

## 1. 这一窗口做了什么

### 1.1 两套记账（E 阶段，R21–R29）

| 交付 | 解决什么 | ADR |
|---|---|---|
| mission↔序列 持久索引 | CLI 不再手填 sequence/owner；缺失区分 `index-missing` | 0108/0109 |
| 推迟插入显式队列 | "下一组再消费"不再只存在于返回文本；组边界消费 | 0111/0112 |
| 截断可观察 | `consumed` 超 200 条不再静默丢弃 | 0113 |
| 单任务派发只读预检 | 明确"缺什么才能单独派发"（**仍不派发**） | 0110 |
| 写回提案 | 只读给出改哪条/依据/风险（**不可执行**） | 0114 |
| 一屏汇总 | 差异 + 提案 + 待办 + 丢弃计数一次看完 | 0115 |

### 1.2 完成门禁（C 阶段，R6–R13 与 R47）

收据与裁决**两侧都有生产方**（worker 落盘、独立审查落盘），严格模式可读、**逐任务对齐**
（缺任一任务裁决 ⇒ 不通过）。**严格开关仍默认关**（理由：未运行验证）。ADR-0079 §7 / 0095–0102 / 0101。

### 1.3 SEC-02（D 阶段，R14–R20 与 R46）

注入侧标注 + 有界记录；MCP 结果**可选 `block`**；日志换行加固（一处）；误报探针脚本；
通道矩阵与适配器核查（azure/bedrock/gemini **无 runtime ⇒ 不适用**）。
**`block` 从未实测，默认仍 `record`**。ADR-0103–0107、矩阵 §8。

### 1.4 GOAL-02（F 阶段，R30–R39 与 R51–R53）

控制面（建契约/绑定/解绑/关闭）、状态初始化、组开始/结束、**判定落盘**（有界 200）、
**本地 V 计算**（节点 done + accepted 裁决 → `computeGoalPotential`）、只读 CLI
（`goal-mode status` / `verdicts` / `--export`）、`groupKind` 接入点、组标识带时间前缀。
**默认不激活、强制缺省关、判定只观察不阻断**。ADR-0116–0122、0126–0128。

### 1.5 证据与文档（G 阶段，R40–R50）

任务卡只读索引 + 台账交叉核对、符号使用审计、证据索引、口径总表、运行手册、`PLAN_STATUS` 收口清单。

## 2. 这一窗口**没有**做什么

1. **没有运行任何产品测试或人工验收**（窗口口径）⇒ 所有交付标 `implemented-unverified`；
2. **`block` 模式未实测**（出口与 MCP 均默认 `record`），**没有任何误报率数字**；
3. **强制模式/激活没有用户入口**（只能宿主代码调用；CLI 不能改运行中进程）；
4. **没有重新开启路径**（`closeExperiment` 单向）；
5. **没有真正按 taskId 派发**（预检只表达缺什么）；
6. **没有写回执行端**（提案不可应用）；
7. **没有 DagScheduler 运行中图变更**（结构性缺口）；
8. **REMOTE-01 真实投递未做**（平台阻塞）。

## 3. 如何验收（命令与预期；**以下均未在本窗口执行**）

```powershell
cd astarray
npm run typecheck          # 预期 exit 0（本窗口每轮都跑过）
npm run lint               # 预期 exit 0
npm run build              # 预期成功
npm run test               # 本窗口从未运行；是否运行需用户授权
npm run check              # 同上
```

手动脚本（详见 `docs/reports/SCRIPT_RUNBOOK_2026-10-29.md`）：

```powershell
# 严格完成门禁的存储层四态（需要先 build）
node scripts/manual/strict-completion-drill.mjs

# 误报率探针（8 正常 + 6 假凭据）
node scripts/manual/egress-false-positive-probe.mjs

# 文档/索引类（只读，可随时跑）
node scripts/manual/taskcard-status-index.mjs
node scripts/manual/symbol-usage-audit.mjs
```

CLI 只读视图（不需要真实 mission）：

```powershell
node dist/cli.js goal-mode status
node dist/cli.js goal-mode verdicts --recent 20
node dist/cli.js goal-mode verdicts --export .tmp/verdicts.jsonl
node dist/cli.js task-ledger status --mission <id> --summary
```

**判读**：以上命令能跑通只说明"路径可达"；**不能**说明门禁/裁决/V 的判定正确 ——
那需要真实 mission + 收据 + 裁决，属于本窗口明确未做的部分。

## 4. 剩余任务（详见 `PLAN_STATUS` B/C/D）

- **B 可闭合**：按 taskId 派发、写回执行端、`groupKind` 判定策略、判定轮转、组标识全局唯一、扫描记录持久化/UI；
- **C 需产品决定**：强制模式入口、激活入口、重新开启规则、验证授权；
- **D 平台阻塞**：REMOTE-01 真实投递、DagScheduler 图变更。

## 5. 状态

草稿（R55）；定稿见 R58。**本文件不含任何运行验证结论**。

> **状态更新（R58）**：已被 [DELIVERY_NOTE_2026-10-29](DELIVERY_NOTE_2026-10-29.md) 取代（定稿）；
> 本文件仅保留为草稿历史。
