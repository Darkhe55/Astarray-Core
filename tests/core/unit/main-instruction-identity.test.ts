/**
 * COMM-01-02 修正：主控指令身份与幂等键。
 *
 * 反例优先（针对修正前的真实缺陷）：
 * - **同毫秒两条不同指令**必须得到不同键（旧实现用 `Date.now()` 会撞键，被 journal 以"同键异内容"拒收）；
 * - 键**与时间无关**（同一输入重复计算必须一致）；
 * - 空 mission / 空消息标识必须拒绝（不得以空值代替身份）。
 */
import { describe, expect, it } from "vitest";

import { buildMainInstructionIdempotencyKey } from "../../../packages/core/src/orchestration/main-instruction-identity.js";

describe("主控指令幂等键", () => {
  it("① 同毫秒的两条不同指令 ⇒ 键不同（旧实现会撞键）", () => {
    const first = buildMainInstructionIdempotencyKey({
      missionIdentifier: "mission-1",
      messageIdentifier: "message-a",
    });
    const second = buildMainInstructionIdempotencyKey({
      missionIdentifier: "mission-1",
      messageIdentifier: "message-b",
    });
    expect(first).not.toBe(second);
  });

  it("② 键与时间无关：同一输入重复计算结果一致", () => {
    const input = { missionIdentifier: "mission-1", messageIdentifier: "message-a" };
    expect(buildMainInstructionIdempotencyKey(input)).toBe(buildMainInstructionIdempotencyKey(input));
  });

  it("③ 含 mission 与消息标识，便于排查", () => {
    expect(
      buildMainInstructionIdempotencyKey({ missionIdentifier: "mission-1", messageIdentifier: "message-a" }),
    ).toBe("main-instruction:mission-1:message-a");
  });

  it("④ 空 mission ⇒ 拒绝", () => {
    expect(() =>
      buildMainInstructionIdempotencyKey({ missionIdentifier: "  ", messageIdentifier: "message-a" }),
    ).toThrow();
  });

  it("⑤ 空消息标识 ⇒ 拒绝（身份不得留空）", () => {
    expect(() =>
      buildMainInstructionIdempotencyKey({ missionIdentifier: "mission-1", messageIdentifier: " " }),
    ).toThrow();
  });
});
