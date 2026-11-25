/**
 * WIRING-04-02 补口（2026-11-25）：投递回执的**顺序纪律**。
 *
 * 缺陷（原 `entrypoint.ts`）：先把 journal 标 `delivered`，再 `sendToParent`。
 * 两者之间崩溃 ⇒ 消息被记为"已投递"但从未送达，且不会再重试（丢消息）。
 *
 * 修正：**先**完成 IPC 投递，**成功之后**才写回执。若投递失败，不写回执，
 * 由投递工作者按退避重试；若回执写失败，消息已送达但未标记 ⇒ 可能重投，
 * 依赖接收端按 messageId 去重（仓库已有 replay 去重存储）。
 *
 * 这不是"用本地 run 事件当投递证据"：投递事实由这里真实调用 IPC 的行为给出；
 * 真正的"对端已消费"仍以 `ackDelivered` 为准则，二者不可混用。
 */
export async function deliverThenRecordReceipt(input: {
  /** 真实的 IPC 投递动作（失败必须抛出）。 */
  readonly dispatch: () => void;
  /** 投递成功后的回执写入（失败会向上抛，调用方可重试）。 */
  readonly recordReceipt: () => Promise<void>;
}): Promise<void> {
  input.dispatch();
  await input.recordReceipt();
}
