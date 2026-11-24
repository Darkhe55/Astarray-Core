/**
 * RESUME-02 远程命令适配测试（2026-11-24）：
 * 普通"继续"绝不触发；仅严格 `/resume <单一任务>`；未认证/通道不允许拒绝；幂等键确定性。
 */
import { describe, expect, it } from "vitest";

import { parseRemoteResumeCommand } from "../../../packages/core/src/orchestration/remote-resume-command.js";

const base = {
  sourceChannel: "remote-im",
  authenticatedPrincipalIdentifier: "user-1",
  platformMessageIdentifier: "msg-1",
};

describe("RESUME-02：远程 /resume 命令", () => {
  it("① 普通消息（含「继续」「接着做」「引号里的继续」「标题含继续」）⇒ not-a-command", () => {
    for (const text of [
      "继续",
      "接着做",
      "请把按钮改名为「继续」",
      "继续优化登录页",
      "任务标题：继续支付重构",
      "resume T-1",
      "/resumex T-1",
    ]) {
      expect(parseRemoteResumeCommand({ ...base, text })).toEqual({ kind: "not-a-command" });
    }
  });

  it("② 缺目标/多参数/非法字符 ⇒ invalid 且给出原因码", () => {
    expect(parseRemoteResumeCommand({ ...base, text: "/resume" })).toMatchObject({
      kind: "invalid",
      reasonCode: "missing-target",
    });
    expect(parseRemoteResumeCommand({ ...base, text: "/resume T-1 now" })).toMatchObject({
      kind: "invalid",
      reasonCode: "too-many-arguments",
    });
    expect(parseRemoteResumeCommand({ ...base, text: "/resume T 1" })).toMatchObject({
      kind: "invalid",
      reasonCode: "too-many-arguments",
    });
    expect(parseRemoteResumeCommand({ ...base, text: "/resume T/1" })).toMatchObject({
      kind: "invalid",
      reasonCode: "invalid-target",
    });
  });

  it("③ 未认证 ⇒ denied（unauthenticated），即使命令形态正确", () => {
    expect(
      parseRemoteResumeCommand({
        ...base,
        authenticatedPrincipalIdentifier: null,
        text: "/resume T-1",
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "unauthenticated" });
  });

  it("④ 通道不在允许集合 ⇒ denied（channel-not-allowed）", () => {
    expect(
      parseRemoteResumeCommand({
        ...base,
        sourceChannel: "untrusted-webhook",
        text: "/resume T-1",
      }),
    ).toMatchObject({ kind: "denied", reasonCode: "channel-not-allowed" });
  });

  it("⑤ 合法命令 ⇒ parsed，且幂等键对同一（通道/主体/任务/消息）稳定", () => {
    const first = parseRemoteResumeCommand({ ...base, text: "/resume T-1" });
    expect(first).toMatchObject({
      kind: "parsed",
      taskIdentifier: "T-1",
      sourceChannel: "remote-im",
    });
    if (first.kind !== "parsed") throw new Error("unexpected");
    const retry = parseRemoteResumeCommand({ ...base, text: "  /resume   T-1  " });
    if (retry.kind !== "parsed") throw new Error("unexpected");
    expect(retry.requestIdentifier).toBe(first.requestIdentifier);

    const differentMessage = parseRemoteResumeCommand({
      ...base,
      platformMessageIdentifier: "msg-2",
      text: "/resume T-1",
    });
    if (differentMessage.kind !== "parsed") throw new Error("unexpected");
    expect(differentMessage.requestIdentifier).not.toBe(first.requestIdentifier);
  });
});
