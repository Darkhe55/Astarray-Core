# EVENT-01 验收口径与验收方案（草稿，2026-10-23）

> **状态：口径未定 ⇒ 不开工、不宣称通过。**
> 卡内四个检查点（EVENT-01-01~04）全部 pending，原因不是实现难，而是**没有验收标准**。
> 本文件把"需要你定的四件事"和"定完之后怎么验"写清楚。

## 1. 需要你定的四件事

| # | 字段 | 说明 | 示例 |
|---|---|---|---|
| 1 | `eventSources` | 首期纳入的事件源清单（至少 1 项） | `["process-exit","provider-failure","queue-storm"]` |
| 2 | `responseDeadlineSeconds` | 超过多久算"未按期响应"并**明确降级**（正数秒） | `60` |
| 3 | `recoveryPolicy` | 恢复默认策略：`automatic` / `require-user-confirmation` / `configurable` | `require-user-confirmation` |
| 4 | `requiredEvidence` | 完成证据口径：每条要跑的场景/检查项标识 | `["single-owner","old-epoch-rejected","storm-no-ping-pong","quota-exhausted-still-receives"]` |

把答案填进：

```
docs/reports/EVENT01_ACCEPTANCE_CRITERIA_TEMPLATE.json   （复制一份改名为 EVENT01_ACCEPTANCE_CRITERIA.json）
```

然后运行：

```
npx tsx scripts/verify-event01-criteria.mjs --criteria docs/reports/EVENT01_ACCEPTANCE_CRITERIA.json
```

- **退出码 0** ⇒ 口径完整，可以开工；
- **退出码 2** ⇒ 缺项会被逐条列出（这正是现在的状态）。

## 2. 口径完整后的验收场景（草案，待口径确认后细化）

| 场景 | 注入方式 | 必须成立的结论 |
|---|---|---|
| S1 单一所有者 | 同一资源同时收到两个"紧急"事件 | 只有一个所有者生效；另一个明确拒绝（不"都生效"） |
| S2 旧 epoch 拒绝 | 先发事件，再伪造旧 epoch 的调用/提交 | 旧 epoch 的调用与提交被拒绝；在途副作用须确认 |
| S3 风暴不乒乓 | 高频重复事件（远超响应期限） | 不来回切换；独立危险不丢；限额耗尽仍保持暂停但**继续接收**事件 |
| S4 恢复与降级 | 解除条件出现 / 反馈通道故障 | 未解除不自动继续；恢复按 `recoveryPolicy`；反馈故障明确降级、不重复副作用 |

每条场景必须留下：命令、输入、退出码、关键断言输出、发生时间。**没有这些证据 = 未通过。**

## 3. 当前结论

- 口径：**未定**（模板四项均为 null）；
- 实现：未开工（没有口径就开始写，等于自己编验收标准）；
- 卡状态：`pending`（保持不变，不虚报）。
