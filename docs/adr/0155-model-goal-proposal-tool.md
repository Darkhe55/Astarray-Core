# ADR-0155 模型自主提议工具（③，2026-11-01）

- 状态：**已实现并真实跑通**（模型调用 `proposeGoal` 生成待确认提案）
- 来源：用户"按顺序都做"（③-A / ③-B）
- 相关：ADR-0138（提案/确认）、ADR-0154（裁决面）

## 1. 设计

1. **描述符** `packages/core/src/tools/goal-proposal-tool.ts`
   - `proposeGoal`：`mutationKind: none`、`backupPolicy: not-required`、`isIdempotent: false`；
   - 入参：`objectiveText`、`requirements[]`（标识/描述/权重/完成谓词）。
2. **权限映射**：`proposeGoal: ["project.read"]`（只写本地提案，属最低风险；与 `ToolRegistry.register`
   的 `assertToolMapped` 一致）。
3. **可见性**：`resolveToolDescriptors` 在**目标模式已激活**时追加该描述符；
   未激活不暴露（避免"能调但一定失败"）。
4. **执行**：`buildWorkerToolPort` 在执行前拦截 `proposeGoal`：
   - 未激活 ⇒ `goal-mode-not-active`；
   - 缺 mission 上下文 ⇒ `mission-context-missing`；参数非法 ⇒ `invalid-arguments`；
   - 通过 ⇒ `proposeGoalContract({draft, sourceRequestReference: "mission:<id>"})`，
     **只落提案**，不建契约、不激活、不绑定；
   - 返回文本明确"需用户确认"。
5. **来源引用**由本地派生 `mission:<id>`，**模型无法伪造"用户说过"**。

## 2. 真实运行证据（2026-11-01 01:17）

```
run … --goal goal-k10r --json
→ {"missionId":"mission-a8100852","status":"done"}

test/state/goal-mode/proposals/goal-proposal-f5d88156-….json
→ sourceRequestReference: "mission:mission-a8100852"
  objectiveText: "在 docs 目录写一份一页说明"
  requirements: [{ req-demo, "docs 下存在说明文件", weight 1, deterministic-check }]
  confirmedAtIso: null        ← 仍待用户确认
```

即：**模型自己调用工具生成提案，但没有生成契约**（边界正确）。

## 3. 单元测试

`tests/core/goal-proposal-tool.test.ts`（3/3）：描述符字段、权限映射、
`ToolRegistry.register` 接受并可查询。全量：**471 files / 3591 tests 通过**。

## 4. 未做 / 限制

- **未限制"每个 mission 只能提议一次"**：模型可重复提议（同名目标会生成多份提案，靠用户确认时选择）；
- **提案的有效期/来源展示**未在 CLI 端到端验证（`goal-mode confirm` 走的是提案 id）；
- **未接 UI**：模型提议后用户如何看到提案仍靠 `goal-mode` 目录/CLI；
- ②（三 Agent 身份 + accepted 裁决演练）**未做**（需要演练夹具）。
