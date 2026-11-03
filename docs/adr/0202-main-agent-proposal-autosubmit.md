# ADR-0202 主 Agent 提案的自动提交入口（R147，2026-11-03）

- 状态：**已接（opt-in，默认关）**；ALIGN-01-03 的"无自动调用方"缺口由本检查点部分闭合
- 来源：用户"按建议顺序进行"（ALIGN-00 收口第一项）
- 相关：ADR-0045（提案边界）、ALIGN-01 卡 01-03

## 1. 背景

`MainController.submitMainAgentTaskProposal` 是本地提案控制面，但**没有任何调用方**
（卡内 01-03 明确记录"入口无自动调用方"）。同时 assist 路径根本不跑主 Agent 模型
（用户消息直接建 mission），所以"主 Agent 提出任务"这条生产路径是断的。

## 2. 本次改动（保守、可关闭）

1. 新增纯函数 `extractMainAgentProposalPayload`：只接受"整段就是 JSON 对象"（可带
   ```json 围栏）且含 `targetSecondaryAgentInstanceIdentifier`；其它输出一律 null。
2. `MainController` 新增选项 `isMainAgentProposalAutoSubmitEnabled`（**缺省 false**）：
   ponder 模式回答结束后，若输出是提案 JSON，则调用既有 `submitMainAgentTaskProposal`
   提交；**失败只流式升级说明**（不伪造"已提交"），不影响本轮回答。
3. 门面 `PublicApplicationOptions` / 运行时选项透传该开关（名字相同）。

## 3. 为什么默认关

- 自动把"模型输出"变成"任务登记"属于行为变化，且 assist 主 Agent 回合尚未设计；
- 先提供可验证入口，默认关保证既有 CLI/测试行为不变。

## 4. 验证

```
tests/core/main-agent-proposal-autosubmit.test.ts → 5/5
  JSON / 围栏 / 非 JSON / 缺目标字段 / 数组 ⇒ 提取规则正确
tests/core --maxWorkers=2 → 3664 tests 全通过（首轮两条集成测试负载超时，单跑均过）
typecheck / lint / build → 全绿
```

## 5. 未完成（如实）

- **端到端提交未测**：需要构造带 `conversationTaskInsertionController` 与已知
  `userMessageReference` 的控制器夹具（本轮未做）；
- **默认未开启**：卡内要求"默认用户对话进入主 Agent"，assist 路径仍未跑主 Agent；
- assist/devolve 没有主 Agent 回合（直接建 mission），这是 01-03 的剩余架构部分；
- 提案提交后**不自动建 mission**（提案进序列，由插入控制面后续消费）。
