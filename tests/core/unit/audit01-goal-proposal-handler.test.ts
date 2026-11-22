/**
 * AUDIT-REPAIR-01 检查点 01（2026-11-22）：proposeGoal 处理器反例。
 *
 * 卡内要求：目标模式未激活 / 无 mission / 未分配 / deny / 参数非法 ⇒ **不落提案**；
 * 允许时恰好一个提案；同一 callId 重试幂等；不同调用不合并。
 *
 * 本文件钉住 **处理器侧** 的校验与幂等；权限/门禁由 PolicyWrapper 先行（见下方 deny 用例）。
 */
import { describe, expect, it } from "vitest";

import { createGoalProposalToolHandler } from "../../../packages/core/src/tools/goal-proposal-tool.js";
import type { GoalContractProposalDraft } from "../../../packages/core/src/orchestration/goal-contract-proposal.js";

const validArguments = JSON.stringify({
  objectiveText: "把导出流程自动化",
  requirements: [
    {
      requirementIdentifier: "req-1",
      description: "导出产物与清单一致",
      weight: 1,
    },
  ],
});

interface ProposalCall {
  readonly draft: GoalContractProposalDraft;
  readonly sourceRequestReference: string;
}

function makeHandler(options: {
  isGoalModeActivated: boolean;
  missionIdentifier?: string | undefined;
}) {
  const calls: ProposalCall[] = [];
  const handler = createGoalProposalToolHandler({
    isGoalModeActivated: () => options.isGoalModeActivated,
    missionIdentifier: options.missionIdentifier,
    proposeGoalContract: async (request) => {
      calls.push(request);
      return {
        proposalIdentifier: `goal-proposal-${calls.length}`,
        expiresAtIso: "2026-11-22T01:00:00.000Z",
      };
    },
  });
  return { handler, calls };
}

describe("AUDIT-REPAIR-01 01：proposeGoal 处理器", () => {
  it("① 目标模式未激活 ⇒ 拒绝且不落提案", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: false, missionIdentifier: "m-1" });
    const result = await handler(validArguments, "call-1");
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "goal-mode-not-active",
      sideEffectStatus: "none",
    });
    expect(calls).toHaveLength(0);
  });

  it("② 无 mission 上下文 ⇒ 拒绝且不落提案", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: true, missionIdentifier: undefined });
    const result = await handler(validArguments, "call-1");
    expect(result).toMatchObject({ kind: "error", errorCode: "mission-context-missing" });
    expect(calls).toHaveLength(0);
  });

  it("③ 激活 + mission ⇒ 恰好一个提案，来源引用由本地 mission 生成", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: true, missionIdentifier: "m-1" });
    const result = await handler(validArguments, "call-1");
    expect(result).toMatchObject({ kind: "success", isSideEffectFree: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sourceRequestReference).toBe("mission:m-1");
  });

  it("④ 同一 callId 重试 ⇒ 幂等（不再落第二份）", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: true, missionIdentifier: "m-1" });
    const first = await handler(validArguments, "call-1");
    const second = await handler(validArguments, "call-1");
    expect(first).toMatchObject({ kind: "success" });
    expect(second).toMatchObject({ kind: "success" });
    expect(calls).toHaveLength(1);
  });

  it("⑤ 不同 callId ⇒ 各自落提案（不合并）", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: true, missionIdentifier: "m-1" });
    await handler(validArguments, "call-1");
    await handler(validArguments, "call-2");
    expect(calls).toHaveLength(2);
  });

  it("⑥ 参数非法 ⇒ 拒绝且不落提案", async () => {
    const { handler, calls } = makeHandler({ isGoalModeActivated: true, missionIdentifier: "m-1" });
    expect(await handler("{not-json", "call-1")).toMatchObject({
      kind: "error",
      errorCode: "invalid-arguments",
    });
    expect(
      await handler(JSON.stringify({ objectiveText: " ", requirements: [] }), "call-2"),
    ).toMatchObject({ kind: "error", errorCode: "invalid-arguments" });
    expect(
      await handler(JSON.stringify({ objectiveText: "x", requirements: "bad" }), "call-3"),
    ).toMatchObject({ kind: "error", errorCode: "invalid-arguments" });
    expect(calls).toHaveLength(0);
  });

  it("⑦ 提案存储失败 ⇒ 如实报错（不得返回成功/伪造完成）", async () => {
    const handler = createGoalProposalToolHandler({
      isGoalModeActivated: () => true,
      missionIdentifier: "m-1",
      proposeGoalContract: async () => {
        throw new Error("提案存储不可写");
      },
    });
    const result = await handler(validArguments, "call-1");
    expect(result).toMatchObject({
      kind: "error",
      errorCode: "goal-proposal-invalid",
      sideEffectStatus: "unknown",
    });
  });
});
