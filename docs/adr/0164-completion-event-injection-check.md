# ADR-0164 完成控制事件提示的核查结论（R101，2026-11-01）

- 状态：**核查完成，无缺陷**（此前失败是模型未遵守提示；补跑后完整通过）
- 来源：用户"查"；ADR-0163 遗留"缺少 ASTARRAY_TASK_COMPLETION_V1"
- 相关：ADR-0163（模型分解）

## 1. 核查项

1. **协议提示是否真的注入了？**
   `worker-agent.ts` 在 `requireCompletionEvent === true` 时注入末行要求（含 marker + 冻结 JSON 示例 +
   "未完成不要输出"），位置在提示构建末尾（约 L407–430）。**存在且启用**。
2. **为什么 requireCompletionEvent 为 true？**
   公开门面在 provider 路径**强制开启**：`public-sdk.ts:2772`
   `requireCompletionControlEvent: runtimeKind === "provider"`（mock 关闭）。
   这是既有安全设计（真实 Provider 必须给完成事件才结案），不是新缺陷。
3. **为什么那次失败？**
   模型（step-3.5-flash）在该次输出里**没有**在末行给出 marker（或格式不符），
   门禁按设计拒绝结案。加 trace（`ASTARRAY_TRACE_COMPLETION=1`）确认该 mission 的 worker 确实
   `requireCompletionEvent=true, conversation=false`。

## 2. 补跑结果（决定性）

```
ASTARRAY_TRACE_COMPLETION=1 run … --model-planning
[WCOMP] task=T-01 requireCompletionEvent=true conversation=false
[WCOMP] task=T-02 requireCompletionEvent=true conversation=false
→ mission-0524ccd3 status=done, taskPlanningOutcome=model
task-chain: T-01 done, T-02 done
```

即：**两节点模型分解 + 完成控制事件**可以完整通过（同模型、同端点、同提示），
此前失败属**单次模型行为**（未遵守末行要求），不是提示未注入或门禁错误。

## 3. 附带证据

- `[终态] 忽略 cancelled：mission 已是 blocked`（R86 终态单点）在失败那次的日志中出现，
  说明"阻止覆盖"确实生效；
- 该次 done 说明目标模式相关门禁未误伤正常完成。

## 4. 未做

- 未做"模型不守约时是否提示重试"的改进（当前直接失败，由用户重提）；
- 完成事件格式错误的具体原因未从模型原始输出取证（只从消息推断）；
- 未把 `ASTARRAY_TRACE_COMPLETION` 写进正式诊断文档（仅代码内 env 开关）。
