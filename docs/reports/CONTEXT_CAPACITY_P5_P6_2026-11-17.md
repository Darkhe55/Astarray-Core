# 上下文容量与准入 P5–P6 实施记录（2026-11-17）

## P5 Provider context overflow

- 新增稳定错误码 `provider-context-overflow`。
- `describeProviderHttpFailure`：
  - HTTP 413 直接归类为上下文溢出；
  - HTTP 400 仅在详情包含 `context length`、`maximum context`、`context window`、`too many tokens`、`prompt is too long`、`input is too long`、`request too large` 时归类；
  - 普通 400 保持 `provider-http-error`。
- `isProviderContextOverflowError(error)` 供重试路径使用。
- `WorkerAgent.run()` 增加一次降级重试：
  - 只在没有执行过任何工具、没有产生文本时；
  - 第二次使用 `recall` 阶段预算；
  - 同一 Worker 最多一次；
  - 第二次仍失败则原样抛出。

## P6 optional 候选评分器

- 新增 `context-optional-scorer.ts`。
- 评分器只排序**未进入提示词**的全局决策候选，用于延后写入/后续回访优先级。
- 不参与 required 选择，不改变任务约束、验收标准或安全边界。
- 未提供评分器时保持原有稳定顺序。

## 验证

```text
npm run typecheck   通过
npm run lint        通过
目标测试            8 文件 / 31 用例通过
```

目标测试使用 `threads` 池；完整 Vitest 仍受沙箱禁止 fork 子进程影响。

## 提交

```text
1eb9e69a feat: classify provider context overflow
b23bafa5 feat: retry once after provider context overflow
7a84f38e feat: rank optional deferred context candidates
```

## 备注

P5 的重试只覆盖“溢出发生在收到文本/执行工具之前”的安全场景；已经产生副作用或部分输出的请求不重跑，避免重复工具调用。
