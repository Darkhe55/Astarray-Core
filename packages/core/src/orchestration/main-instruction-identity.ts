/**
 * COMM-01-02 修正（2026-11-11，用户澄清"身份由汇报路径自动填写"）：主控指令的**消息身份**。
 *
 * 修正前的真实缺陷：幂等键用 `Date.now()` 拼接——
 * ① 同一毫秒内的**两条不同指令**得到同一键，而 `mailbox-journal` 对"同键异内容"直接拒收，
 *    等于第二条合法指令被静默丢弃；
 * ② 键随时间变化，**跨重试无法去重**（重试会生成新键，去重形同不存在）。
 *
 * 现口径：身份由**消息标识**决定（框架生成、模型不可写），键稳定且与时间无关。
 * "同一指令跨重试只入队一次"需要上游提供指令标识（属后续切片，不在本次范围）。
 */

/** 主控指令的幂等键：`main-instruction:<missionId>:<messageIdentifier>`。 */
export function buildMainInstructionIdempotencyKey(input: {
  readonly missionIdentifier: string;
  readonly messageIdentifier: string;
}): string {
  if (input.missionIdentifier.trim() === "") {
    throw new Error("主控指令缺少 mission 标识（不得以空值代替）");
  }
  if (input.messageIdentifier.trim() === "") {
    throw new Error("主控指令缺少消息标识（身份必须由框架生成，不得留空）");
  }
  return `main-instruction:${input.missionIdentifier}:${input.messageIdentifier}`;
}
