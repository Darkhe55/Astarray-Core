# ADR-0175 rework 组性质真实演练（R114，2026-11-01）

- 状态：**已真实跑到 `lastTaskGroupKind="rework"`**
- 来源：用户"跑"；ADR-0174 遗留"真实 rework 组闭环"
- 相关：ADR-0130/0162（组性质与停滞）、ADR-0174（指令入口）

## 1. 做法（同进程宿主脚本）

`test/rework-drill.mjs`（不入库）用 `AstarrayApplicationFacade` 在**同一进程**里：

1. 真实 provider（stepfun `step-3.5-flash`）+ `isModelTaskPlanningEnabled`；
2. 激活目标模式 → 提议/确认 `goal-rework-6` → 提交两节点（`T-01`、`T-02`）任务；
3. 等 `T-01` 进入 `running`（编排器已注册、第二组未开始）后，发送
   **JSON 指令** `{"action":"reassign","taskId":"T-02"}`；
4. 等 mission 终态，读目标状态。

## 2. 真实证据（trace：`ASTARRAY_TRACE_GROUPKIND=1`）

```
[GK] groupStart starting=T-01 reworked=
[GK] reassign=T-02 reworked=T-02
[GK] groupStart starting=T-02 reworked=T-02
FINAL blocked
LAST_GROUP_KIND rework
GROUP_COUNT 2
```

即：reassign 命中 → 第二组以 `rework` 性质启动 → 组结束时 `lastTaskGroupKind="rework"` **落盘**。
（该 mission 因模型未给完成事件而 blocked，不影响组性质证据。）

## 3. 发现的两个真实约束（已修/已记）

1. **指令必须是 JSON**：`parseSchedulerInstruction` 只接受
   `{"action":"reassign","taskId":"T-02"}`；纯文本会被拒（只升级"指令无法解析"）。
   已写进 `sendMissionInstruction` 的 JSDoc；
2. **必须在编排器注册后、第二组启动前发送**：太早（规划中）指令被静默丢弃，
   太晚（组已启动）标记只影响再下一组。脚本用"等到有任务 running"解决。

## 4. 验证

```
tests/core --maxWorkers=2 → 471 files / 3607 tests 全通过
typecheck / lint / build → 全绿
真实演练 → LAST_GROUP_KIND rework（见 §2）
```

## 5. 未完成

- 演练脚本为临时脚本（未入库、无自动化测试）；
- 只验证了 `rework`；`investigation` 仍无本地信号（设计如此，不产生）；
- 指令发送时机没有产品级保障（宿主需自行确保在安全点）；
- 指令内容（JSON）没有 schema 校验入口，错误只以"无法解析"升级。
