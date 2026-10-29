# 交付说明（定稿，2026-10-29，R58）

> 取代草稿 [DELIVERY_NOTE_DRAFT_2026-10-29](DELIVERY_NOTE_DRAFT_2026-10-29.md)（草稿保留作历史）。
> 本窗口 **38 个编号检查点（R21–R58）**；每轮：先读源码再改 → 改后跑 `typecheck`/`lint`/`build`
> → 显式路径提交 → 尝试推送。
>
> **最重要的一句**：本窗口**没有编写或运行任何产品测试/人工验收**。
> 以下所有"已交付"都是**代码接线 + 静态证据**，**不是运行验证结果**。

## 1. 交付内容（按领域）

| 领域 | 交付 | 证据 |
|---|---|---|
| **两套记账** | mission↔序列 索引（CLI 免手填、`index-missing` 区分）；推迟插入队列（入队/组边界消费/截断可观察）；单任务只读预检；写回提案；一屏汇总 | ADR-0108–0115 |
| **完成门禁** | 收据存储/写入/读取；裁决存储/写入/读取；**逐任务对齐**；存储层演练脚本（未执行） | ADR-0095–0102、0079 §7 |
| **SEC-02** | 注入侧标注 + 有界记录；MCP 结果可选 block；日志换行加固（一处）；误报探针（未执行）；矩阵刷新与适配器核查 | ADR-0103–0107、矩阵 §8 |
| **GOAL-02** | 门禁解析器、恢复对账、激活唯一开关、控制面、状态初始化、组开始/结束、判定落盘、关闭实验、本地 V、`groupKind` 接入点、组标识时间前缀、判定 JSONL 导出 | ADR-0092–0094、0116–0122、0126–0128 |
| **CLI** | `goal-mode status` / `verdicts` / `verdicts --export`；`task-ledger status`（`--list-bindings` / `--task` / `--propose-writeback` / `--deferred-insertions` / `--summary`） | ADR-0109/0110/0114/0115/0117/0120/0128 |
| **证据与文档** | 任务卡索引、台账交叉核对、符号审计、证据索引、口径总表、运行手册、死链检查（0 死链）、优先级建议 | ADR-0123–0125、0129、各报告 |

## 2. 明确**没有**做的事

1. **没有运行产品测试或人工验收**（口径）⇒ 全部 `implemented-unverified`；
2. **`block` 未实测**（出口/MCP 默认 `record`），**没有误报率数字**；
3. **强制模式/激活无用户入口**（只能宿主代码调用；CLI 不能改运行中进程）；
4. **无重新开启路径**（`closeExperiment` 单向）；
5. **未真正按 taskId 派发**（预检只表达缺什么）；
6. **无写回执行端**（提案不可应用）；
7. **无 DagScheduler 运行中图变更**；
8. **REMOTE-01 真实投递未做**（平台阻塞）；
9. **`groupKind` 无判定策略**（接入点已接，生产仍记 `normal`）。

## 3. 验收方法

### 3.1 静态门（本窗口每轮都跑过）

```powershell
cd astarray
npm run typecheck    # exit 0
npm run lint         # exit 0
npm run build        # 成功
```

### 3.2 从未运行的项（需授权）

```powershell
npm run test         # 本窗口从未运行
npm run check        # 本窗口从未运行
```

### 3.3 手动脚本（详见运行手册）

```powershell
npm run build
node scripts/manual/strict-completion-drill.mjs     # 未执行过
node scripts/manual/egress-false-positive-probe.mjs # 未执行过
node scripts/manual/taskcard-status-index.mjs       # 已执行（文档）
node scripts/manual/symbol-usage-audit.mjs          # 已执行（文本）
node scripts/manual/docs-link-check.mjs             # 已执行（0 死链）
```

### 3.4 只读 CLI（不需真实 mission）

```powershell
node dist/cli.js goal-mode status
node dist/cli.js goal-mode verdicts --recent 20
node dist/cli.js task-ledger status --mission <id> --summary
```

**判读**：命令能跑通只说明路径可达；**判定是否正确需要真实 mission + 收据 + 裁决**，本窗口未做。

## 4. 剩余任务与建议顺序

详见 [REMAINING_ITEMS_PRIORITY_2026-10-29](REMAINING_ITEMS_PRIORITY_2026-10-29.md)：

1. **P0 补运行证据**（先用两个未执行脚本）；
2. **`groupKind` 判定策略**（低成本消除误判）；
3. **产品决定**：强制/激活入口（建议宿主启动配置）、重开规则（建议重置）、验证授权；
4. **写回执行端 + 审批模型**；
5. **按 taskId 派发**（单独立项）；
6. **平台/结构性阻塞**（REMOTE-01、图变更）。

## 5. 未闭合项状态

与 `PLAN_STATUS` B/C/D 段一致：B 6 项（其中 2 项已部分完成：组标识可跨重启区分、判定已可导出）、
C 4 项（需产品决定）、D 2 项（平台/立项）。

## 6. 状态

**定稿（R58）**。本文件所有"已交付"均指**代码接线**；**没有一条**声称运行验证通过。
最终自查见 R59，目标收束见 R60。
