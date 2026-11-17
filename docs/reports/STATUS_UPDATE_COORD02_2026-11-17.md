# STATUS_UPDATE：COORD-02 立卡（2026-11-17）

**性质**：独立状态补丁。共享台账（`docs/reports/TASKCARD_BACKLOG_2026-10-17.md` §11）本轮**未改动**，
避免与并行修改冲突；下列内容待合入台账对应位置。

## 待合入台账的位置

`docs/reports/TASKCARD_BACKLOG_2026-10-17.md` — "COORD 相关" 段落（现有
`#### 第 66+ 轮：COORD-01 收口` 之后）建议新增一行：

```
- COORD-02 消息版本与授权标记（生产者前置）：blocked-on-producer-fields
  卡：docs/tasks/COORD02_MESSAGE_VERSION_AND_AUTHORIZATION_STAMPING.md
  前置：FeedbackMessage 需补 taskRevision / authorizationEpoch（生产者填写）
```

## 本轮事实

| 项 | 结论 |
|---|---|
| P1-3 要求 7 的预算部分 | **已实现**（`selectCoordinationContextEntries`，只标记被携带的消息） |
| P1-3 要求 7 的版本/授权部分 | **阻塞**：消息结构上没有 `taskRevision` / `authorizationEpoch` |
| 是否在消费端猜版本 | **不猜**（会构成伪造授权），因此宁可留空并在卡内写明 |
| 全量门禁 | 807 files / 5351 passed + 3 skipped（提交 `1d6ac1c5`） |

## 证据引用

- 卡：`docs/tasks/COORD02_MESSAGE_VERSION_AND_AUTHORIZATION_STAMPING.md`
- 已完成部分：`docs/tasks/COORD01_TASK_FEEDBACK_CONSUMPTION_REPAIR.md`（P1-3 要求 7 小节）
- 字段缺失的事实：`packages/core/src/core/types.ts:513`
