# COORD-02：消息版本与授权标记（生产者前置）

**状态**：`blocked-on-producer-fields`（消费端已就绪，缺上游字段）
**立卡日期**：2026-11-17
**来源**：P1-3 返修时发现的硬前置（见 `COORD01_TASK_FEEDBACK_CONSUMPTION_REPAIR.md` P1-3 要求 7）

## 1. 为什么立这张卡

P1-3 要求"只把**已授权、版本适用**、预算内的消息放进模型请求"。本轮已实现：

- ✅ 预算内选择（`selectCoordinationContextEntries`，按渲染长度装填）；
- ✅ 未被选中的消息保持 `pending`，只对**实际携带**的标 `delivered`；
- ❌ **版本适用性**与**授权校验无法实现**。

原因不是没写代码，而是**没有字段可依据**：

```text
FeedbackMessage 字段（core/types.ts:513）
  messageId / source / recipientId / priority / createdAtIso / idempotencyKey
  projectIdentifier? / missionIdentifier? / taskIdentifier? / replyToMessageIdentifier?
  ⇒ 没有 taskRevision（任务版本）
  ⇒ 没有 authorizationEpoch（授权代际）
```

消费端若自行"猜一个版本/授权"，等于**伪造授权**——这是本卡拒绝做的事。

## 2. 需要上游补的字段（本卡的唯一前置）

| 字段 | 语义 | 谁填 |
|---|---|---|
| `taskRevision?: number` | 该反馈所基于的**任务链 revision** | 生产者在构造反馈消息时，从任务链读取并写入 |
| `authorizationEpoch?: number` | 该反馈所属的**授权代际**（撤权后递增） | 生产者在受权状态下写入；无授权上下文则不填 |

两条都应是**可选**字段：缺省 ⇒ 消费端按"不可验证"处理（保守：不携带、或携带但标注"未验证版本"），
**不得**默认当成当前版本。

## 3. 消费端接线（字段就绪后要做的事）

| 步骤 | 内容 |
|---|---|
| ① | `collectPending` 返回条目增加 `taskRevision` / `authorizationEpoch` |
| ② | 选择器增加两条过滤：`taskRevision === 当前任务链 revision`；`authorizationEpoch === 当前授权代际` |
| ③ | 未通过过滤的消息**保持 pending**（与预算排除同一处理，不丢不误确认） |
| ④ | 提示词区块标注**已验证**还是**未验证**（不得把未验证内容说成已验证事实） |
| ⑤ | 反例：旧 revision 消息不携带；撤权（epoch 变化）后旧消息不携带；字段缺失 ⇒ 保守处理 |

## 4. 验收判据

1. 旧 revision 的反馈**不会**进入模型请求（反例可稳定复现）；
2. 撤权后（epoch 递增）旧 epoch 的反馈**不会**进入；
3. 缺字段 ⇒ 不默认绑定当前版本（行为可观察：要么不携带，要么明确标注"未验证"）；
4. 上述三条都有测试捕获**实际请求载荷**（不只看状态字段）；
5. 既有 P1-3 行为不回归（预算选择、pending 保持、unknown 态）。

## 5. 明确不做

- 不在消费端推断版本/授权（拒绝伪造）；
- 不改独立审查默认开关；
- 不引入第二套任务版本存储（revision 只认任务链）。

## 6. 现状证据

| 项 | 位置 |
|---|---|
| 预算选择（已实现） | `packages/core/src/orchestration/coordination-context-delivery.ts` |
| Worker 只标记被携带的消息（已实现） | `packages/core/src/orchestration/worker-agent.ts` |
| 反例（预算部分携带） | `tests/core/integration/coord01-context-delivery-wiring.test.ts` ⑦ |
| 缺字段的事实 | `packages/core/src/core/types.ts:513`（`FeedbackMessage`） |
