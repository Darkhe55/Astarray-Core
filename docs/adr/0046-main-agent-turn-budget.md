# ADR-0046 主 Agent 单条处理预算与超期记账（180 秒）

- 状态：已采纳（契约 + 生产接线）
- 日期：2026-10-28
- 来源：[ALIGN-01](../tasks/ALIGN01_IDENTITY_AND_MAIN_AGENT.md) 检查点 05
- 相关：SMART-01-04（`main-agent-deadline-supervisor`，三分钟派发期限）、ADR-0044（身份分层）、ADR-0045（提案边界）

## 1. 背景

ALIGN-01-05 要求：**任务交付提案后立即释放主 Agent 的任务等待**，不等待下级执行完成；
**单条主 Agent 处理预算上限 180 秒**，耗尽时保存已知进度并明确返回"待补信息/待继续"，
**不得伪造已分发**；**不能用无限模型重试占住通信**。

实测基线：

- `SMART-01-04` 的 `evaluateInstructionDeadline` 与 `MAIN_AGENT_DISPATCH_DEADLINE_MILLISECONDS = 180_000`
  早已存在，但它是**纯评估函数**：没有任何地方按它中止运行，也没有调用方；
- `respondInPonderMode` 跑模型时只有 `AbortController` 占位（从未 abort），
  慢模型/长工具循环会一直占住会话；
- assist 分支创建 mission 后**立即返回**（不 await 调度器），这一半本来就满足卡内要求。

## 2. 契约（冻结）

1. **预算是硬上限**：主 Agent 自己跑模型的路径（ponder）用
   `AbortSignal.timeout(budget)` 与调用方取消信号组合（`AbortSignal.any`）中止本轮；
   默认 `180_000` ms，可由装配层覆盖（测试/受限环境）。
2. **超期不是完成**：预算耗尽时把本轮记为 `outcome: "timed-out"`，并**当场**向用户回报
   `[需要继续] …请补充信息或指示「继续」…本轮没有派发任何任务`。
3. **记账可核对**：`MainAgentTurnProgressRecord` 记录轮次 id、会话 id、起止时间、预算、
   实际耗时、已流式产出字数、`outcome`、`nextActionText`，且 **`isTaskDispatched` 恒 `false`**
   —— 主 Agent 的一轮答复**从不**等于任务已派发。
4. **落库失败不阻塞、不掩盖**：`mainAgentTurnProgressPort` 写
   `<state>/main-agent-turns/<turnId>.json`（原子写）；写入失败只吞掉该异常，
   超期事实仍照常回报。
5. **不记录模型隐式状态**：只记本地可核对的事件/计数，不存思维链、不存原文提示词。
6. **assist 路径不等待下级**：创建 mission 后立即返回（既有行为），本 ADR 不改调度；
   "释放任务等待"与"下级是否执行成功"是两件事，后者由完成门禁判定。

## 3. 生产调用链（源码位置）

```
用户消息（ponder）
└─ MainController.handleUserMessage → respondInPonderMode   packages/core/src/orchestration/main-controller.ts
   ├─ AbortSignal.timeout(180_000) + AbortSignal.any(取消信号)
   ├─ runtime.run / runToolLoop(signal)                      既有运行层（会响应取消）
   ├─ buildMainAgentTurnProgressRecord                        packages/core/src/orchestration/main-agent-turn-budget.ts
   ├─ streamOutput(null, "[需要继续] …")                       面向用户的如实回报
   ├─ lastMainAgentTurnProgress（只读 getter）                getLastMainAgentTurnProgress()
   └─ mainAgentTurnProgressPort                               application-runtime 写
                                                              <state>/main-agent-turns/<turnId>.json
用户消息（assist/devolve）
└─ createMission → launchAssistMission → return missionId     不 await 下级执行
```

## 4. 未完成（如实）

- **UI 展示**：`getLastMainAgentTurnProgress()` 已可用，但 CLI/TUI/GUI 尚未把它渲染成
  "超时/待继续"状态（属界面仓库范围）。
- **续跑**：超期后"从已知进展续跑"目前只是文案承诺 —— 没有任何自动续跑入口
  （`main-agent-turn-progress` 记录可作后续续跑的依据）。
- **assist 分支的主 Agent 模型轮次**尚不存在（默认路径仍是固定 T-001），
  等 ALIGN-02-02 接上规划后再套用同一预算。
- `main-agent-turn-progress` 记录暂无保留策略（不自动清理）。
- 未验证"无限模型重试"的上游：Provider 侧重试次数由既有运行时配置约束，
  本轮未逐一审计其边界（不宣称已封死）。

## 5. 验证状态

**implemented-unverified**：本轮按任务卡口径未编写/未运行测试、未人工验收。
已执行：`npm run typecheck` exit 0、`npx eslint <本批文件>` exit 0、`npm run build` 成功。
超期路径**没有**被真实慢模型触发过 —— 不宣称"超时一定生效"。
