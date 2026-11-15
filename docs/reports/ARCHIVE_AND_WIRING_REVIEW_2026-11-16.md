# 任务卡归档与生产接线核查

日期：2026-11-16。基线：`840ff1d4`。范围：近期核心任务卡与关键生产调用链静态核查，加 3 文件 / 10 用例定向回归；不是全仓逐行审计，也未运行全量 check、真实模型或重新打包。

## 归档结果

新增 [EXEC-01-03 两项限定修复归档](../tasks/archive/completed-checkpoints/EXEC01_03_LOCAL_FIXES_2026-11-16.md)。整卡新增归档 0；原卡全部保留，未清理日志、代码、备份或运行状态。

## 主要发现（按修复优先级）

### P1：上下文回执把准入记账当成实际投递

`orchestration/context-admission.ts` 的 `admit` 只写消息 ID/接收者/时间，既不取得消息正文，也无模型请求或安全点投递端口，却返回 injected。`application/application-runtime.ts` 的 `admitCoordinationContext` 据此把 journal 的 contextDeliveryState 写成 delivered。

与 COORD-01 的“delivered 代表模型请求实际携带”冲突。应拆开 admitted 与 delivered，实际请求装配成功后才记投递；补断言请求中含目标消息正文，而非仅断言标志为 true。

### P1：COORD 消费器已构造，但未找到生产消费调用

全 packages 检索 `runConsumptionStep` 仅命中 `coordination-message-consumer.ts` 的方法定义。运行时暴露 consumer 与 ready-set 重算入口，不等于后台持续消费。卡末“四检查点全部有生产接线”的说法证据不足；不得以查询/控制入口的包测试代替消息入库到业务调度的完整链路。

需要把消费唤醒接到反馈入库和启动恢复，验证权威任务状态确实更新、依赖确实解除、只派发一次。保留原调度器，不另造任务真相。

### P2：CLUSTER 写租约仅覆盖同一个实例

`orchestration/diagnostic-cluster-service.ts` 的 activeLeases 是实例内 Set。两个服务实例或进程不共享它，不能满足原卡的跨进程竞争验收。TTL 已有读取时间判定，不能继续笼统说“cache 没 TTL”。应补持久租约/并发版本保护及双进程反例。

CLUSTER 卡把效果报告列成“需真实数据、待人测”，但原验收要求是至少 60 条合成错误、10 类标注、20 对负例及可复算指标；这部分并不必然需要付费模型或真实用户数据。不要以等待真实数据替代可执行验收。

### P2：主 Agent 与节点上下文装配仍未统一

main-controller 的思索路径仍以当前 message 为 userPrompt，未见在该入口调用公共上下文提供者；稳定个体身份不能证明历史已装入。context-prompt-assembler 的默认提供者仍未传 contextPacks/recalledContextBlocks，能力定义不等于实际启用。需按原设计验证跨轮回忆及按节点取回正文；本轮不宣称所有模式都无历史。

## 进展与当前卡状态

| 卡 | 本轮判断 |
|---|---|
| ALIGN-03 | 已出现 buildReviewTaskNode 的真实审查任务接线，较旧版本进步；默认开关仍需显式 true。不可继续称只有文件存在性检查，也不能未经完整运行验收标完成 |
| COORD-01 | 原卡 implemented-unverified；存在上述真实接线缺口，不仅缺人工验收，保留活动状态 |
| CLUSTER-01 | 算法/服务/CLI 有交付，仍缺并发完整性、效果与资源证据，不能整卡归档 |
| COMM-01 | 最新 messageId 重放去重已接主进程与反馈子进程，相关 5 用例本轮通过；outbox 消费边界仍需证明宿主端实际接收，不能将落盘 delivered 理解为模型读到 |
| EXEC-01 | 包级 6 项历史证据主要证明导出、拒绝路径及只读入口；证据自身仍列真实后端、运行时、干净设备及跨平台 blocked；整卡保留 |
| STARTUP-RECOVERY | 沿用先前核心范围归档，不重复提升整卡等级 |

本报告作为独立状态纠偏记录，不覆盖并行施工原卡。建议顺序：修 COORD 虚假投递回执及消费唤醒 → 验证独立审查闭环 → CLUSTER 并发与合成验收 → 补真实沙箱交付证据。

结论：关键模块已有增量接线，但当前证据不足以认定完全符合原始设计；“可导出/可直接调用/测试绿色”不能替代生产闭环。

## 逐项处置结果（2026-11-16 起，持续更新）

| 发现 | 处置 | 证据 | 验证范围 |
|---|---|---|---|
| P1 上下文回执把准入当投递 | **第一步已修**：`admit()` 只记准入（恒 `isDelivered:false`），新增 `recordDelivered()` 需 `requestIdentifier` 证据；运行时准入写 `contextDeliveryState="pending"` | `orchestration/context-admission.ts`、`application/application-runtime.ts`、提交 `7ac03c9a` | 单测 10 条 + 集成 2 处断言纠正；全量门禁 5296 passed |
| P1 同上（**第二步：请求实际携带**） | **未完成**：尚未把准入消息接入上下文装配/安全点投递；`delivered` 仍无人写入 | 待做 | —— |
| P1 COORD 消费器无生产调用 | **未开始** | —— | —— |
| P2 CLUSTER 写租约仅实例内 | **未开始** | —— | —— |
| P2 CLUSTER 效果/资源报告被误列为"等真实数据" | **未开始** | —— | —— |
| P2 主 Agent 与节点上下文装配未统一 | **未开始** | —— | —— |

> 说明：本表只记录**已核实的实际代码状态**；不以提交数量或测试全绿代替接线证据。

> **2026-11-16 更新**：P1「上下文回执把准入当投递」**两步均已完成**——
> 第一步拆开准入/投递（提交 `7ac03c9a`），第二步把准入消息接入 Worker 的真实模型请求，
> 请求提交后才记 delivered（提交见下一条）。证据：`orchestration/coordination-context-delivery.ts`、
> `tests/core/integration/coord01-context-delivery-wiring.test.ts`（捕获 systemPrompt 断言正文/来源/任务）。
