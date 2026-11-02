# ADR-0200 investigation 全只读 mission 真实演练（R145，2026-11-03）

- 状态：**已跑到**（真实 provider + 模型分解；`lastTaskGroupKind="investigation"`）
- 来源：用户"investigation 全只读 mission 真实演练"
- 相关：ADR-0198（信号定义）、ADR-0191（组性质持久化）、ADR-0175（rework 演练）

## 1. 配置

- 目标 `goal-inv`：单要求（deterministic，未映射），`pauseConditions: []`；
- provider：stepfun `step-3.5-flash`，`--model-planning`；
- prompt：只读（"请读取 docs/plan.md。"）。

## 2. 真实结果

**成功的一次**（`mission-ed128999`）：

```
task-chain：T-01 done，toolNames=["readFile"]
goal-inv：lastTaskGroupKind="investigation"，lastPotentialValue=1，未暂停
```

即：**全只读组被识别为 investigation 并落盘**。

**此前两次失败尝试**（同样配置，prompt 稍长）：

| mission | 结果 | 组性质 |
|---|---|---|
| `mission-b9a47e9b` | done（触发完成事件缺失的有界重试） | `rework` |
| `mission-dc177ace` | blocked（T-02 失败） | `rework` |

两次都因**完成控制事件缺失触发 R115 重试**，重试把任务标记为返工 ⇒ `rework` 优先。
这从侧面验证了"**返工优先于调查**"的优先级在真实运行中生效。

## 3. 观察

- 模型分解产出的只读任务确实声明 `toolNames=["readFile"]`（判定信号可用）；
- 模型输出不稳定：同一 prompt 三次里两次缺完成事件 ⇒ 组性质被重试改写成 `rework`；
  这意味着"真实环境下 investigation 的产生"依赖模型守约；
- V 保持 1（要求未映射到任何任务，符合预期）。

## 4. 未验证

- "调查组**不计入停滞**"的真实效果（需要 9+ 组、且组全为只读；本次只有 1 组）；
- 只读组在停滞检查点的跳过行为（只有单测，无真实多组演练）；
- 混合读写组的真实判定（需要模型产出一写一读的组）。
