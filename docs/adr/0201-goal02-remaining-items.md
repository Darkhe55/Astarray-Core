# ADR-0201 GOAL-02 剩余六项按序收口（R146，2026-11-03）

- 状态：**全部处理**（四项补测试、一项真实演练、一项语义确认）
- 来源：用户"按顺序逐个完成"
- 相关：ADR-0198/0199/0200

## 1. 调查组免停滞（多组）

**补测**：`goal-progress-stagnation.test.ts` 新增 12 个 `investigation` 组、V 恒定：

```
每 3 组到达检查点时 didRunProgressCheck=true，但 checksSinceLastReduction 保持 0，不暂停。
```

说明：这是**门禁级**多组证据，不是"真实 12 组 mission"（真实只读 mission 需模型稳定，见 ADR-0200）。

## 2. 混合读写组判定

已由现有测试覆盖：

- `isInvestigationTaskGroup({taskToolNames:[["readFile","createProjectFile"]]})` ⇒ `false`；
- 解析器：只有部分任务只读 ⇒ `normal`。

未另加测试；真实混合组未跑。

## 3. 删除被映射任务的清理（链路）

**补测**：确定性演练中先 `bind(T-99 → node-99)`，再 `removeMissionTask(T-99)`，
轮询断言映射被清理为空（覆盖 runtime → store 链路，而非仅存储单测）。

## 4. 有在途任务时重连被拒

已有专测：`dag-scheduler-preferred-dispatch.test.ts` "有在途任务时拒绝重连（not-safe-point）"。

## 5. 真实 mission 四操作演练

新增宿主脚本（真实 stepfun，非夹具）：

```
mission-97a98727：写入 prompt ⇒ 权限询问 ⇒ T-001 blocked（安全点）
INJECT  injected / REVISE revised / REWIRE rewired / REMOVE removed
目标：requiresReplanning=false、pauseReason=null
```

即：**四操作在真实 mission 上全部成功**（脚本未入库，属一次性演练）。

## 6. 恢复后自动继续（语义确认 + 测试）

语义：`replanGoal` 清除 `requiresReplanning` 后，**同一 mission 的派发控制面立即可用**
（不需要重建 mission；门禁缓存已刷新）。

**补测**：V 上升暂停 → `replanGoal` 成功 → 同一 mission 再注入 `T-98` **被接受**。

注意：这仍需要"是否有任务可派发"由调度器决定；**不会自动重放已失败的任务**，
也不自动重新提交用户 prompt。

## 7. 验证

```
tests/core --maxWorkers=2 → 3659 tests 全通过
typecheck / lint / build → 全绿
```

## 8. 最终仍未做（如需继续）

- 真实 12 组全只读 mission 的免停滞（受模型稳定性限制，当前为门禁级证据）；
- 真实混合读写组；
- 恢复后自动**重放失败任务**（明确不做：需用户决定）。
