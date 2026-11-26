/**
 * AXIOMATIC-DESIGN 阶段①（2026-11-26）：mission 完成判定**有序三角化**的反例测试。
 *
 * 纪律：
 * - 顺序固定：task-chain → receipts → independent-verdict；
 * - 严格模式关闭 ⇒ 后两步 skipped（不伪造通过）；
 * - 任务链读失败必须上抛（不得当成"全 done"）；
 * - 端口抛错按"该步不通过"处理（fail-closed）；
 * - 原因文本与改造前一致（兼容既有调用方）。
 */
import { describe, expect, it } from "vitest";

import {
  decideMissionCompletion,
  type MissionCompletionDecisionPorts,
} from "../../../packages/core/src/orchestration/mission-completion-decision.js";

function task(id: string, status: string) {
  return { id, status };
}

function basePorts(overrides: Partial<MissionCompletionDecisionPorts> = {}): MissionCompletionDecisionPorts {
  return {
    readTaskChainTasks: async () => [task("T-1", "done")],
    isCompletionReceiptRequired: false,
    requireCompletionControlEvent: false,
    ...overrides,
  };
}

function receipt(taskIdentifier: string) {
  return {
    missionIdentifier: "mission-1",
    taskIdentifier,
    hasVerifiedCompletionControlEvent: true,
    toolCallCount: 1,
    artifactPaths: ["out.md"],
    recordedAtIso: "2026-11-26T00:00:00.000Z",
  };
}

describe("AXIOMATIC 阶段①：mission 完成判定", () => {
  it("① 严格关闭 + 全部 done ⇒ 允许；收据/裁决步骤为 skipped（不伪装通过）", async () => {
    const decision = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts(),
    });
    expect(decision.isAllowed).toBe(true);
    expect(decision.steps.map((step) => step.step)).toEqual([
      "task-chain",
      "receipts",
      "independent-verdict",
    ]);
    expect(decision.steps[1]?.status).toBe("skipped");
    expect(decision.steps[2]?.status).toBe("skipped");
  });

  it("② 有未完成任务 ⇒ 在 task-chain 阻断，并列出任务与状态", async () => {
    const decision = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        readTaskChainTasks: async () => [task("T-1", "done"), task("T-2", "running")],
      }),
    });
    expect(decision.isAllowed).toBe(false);
    expect(decision.steps[0]?.status).toBe("blocked");
    expect(decision.blockedReasons.join("")).toContain("T-2(running)");
    expect(decision.incompleteTaskIdentifiers).toEqual(["T-2(running)"]);
  });

  it("③ 任务链读取失败 ⇒ 上抛（不得 fail-open 成空任务链）", async () => {
    await expect(
      decideMissionCompletion({
        missionIdentifier: "mission-1",
        ports: basePorts({
          readTaskChainTasks: async () => {
            throw new Error("disk read failed");
          },
        }),
      }),
    ).rejects.toThrow("disk read failed");
  });

  it("④ 严格模式：缺收据 ⇒ 收据步骤阻断；裁决通过也不能放行", async () => {
    const decision = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        isCompletionReceiptRequired: true,
        readReceipt: async () => null,
        readIndependentVerdict: async () => ({ isAccepted: true, reasons: [] }),
      }),
    });
    expect(decision.isAllowed).toBe(false);
    const receipts = decision.steps.find((step) => step.step === "receipts");
    expect(receipts?.status).toBe("blocked");
    expect(receipts?.reasons.join("")).toContain("完成收据不足");
  });

  it("⑤ 严格模式：收据齐备但无已接受裁决 ⇒ 仅裁决步骤阻断", async () => {
    const decision = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        isCompletionReceiptRequired: true,
        readReceipt: async (_mission, taskIdentifier) => receipt(taskIdentifier),
        readIndependentVerdict: async () => null,
      }),
    });
    expect(decision.isAllowed).toBe(false);
    expect(decision.steps.find((step) => step.step === "receipts")?.status).toBe("passed");
    const verdict = decision.steps.find((step) => step.step === "independent-verdict");
    expect(verdict?.status).toBe("blocked");
    expect(verdict?.reasons.join("")).toContain("缺少已接受的独立完成裁决");
  });

  it("⑥ 严格模式：裁决被拒 ⇒ 原因包含逐项理由；收据端口抛错 ⇒ 视为不足（fail-closed）", async () => {
    const rejected = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        isCompletionReceiptRequired: true,
        readReceipt: async (_mission, taskIdentifier) => receipt(taskIdentifier),
        readIndependentVerdict: async () => ({ isAccepted: false, reasons: ["证据缺口: 缺验收"] }),
      }),
    });
    expect(rejected.isAllowed).toBe(false);
    expect(rejected.blockedReasons.join("")).toContain("缺验收");

    const throwing = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        isCompletionReceiptRequired: true,
        readReceipt: async () => {
          throw new Error("store unavailable");
        },
        readIndependentVerdict: async () => ({ isAccepted: true, reasons: [] }),
      }),
    });
    expect(throwing.isAllowed).toBe(false);
    expect(throwing.blockedReasons.join("")).toContain("完成收据不足");
  });

  it("⑦ 严格模式且全部满足 ⇒ 允许，三步均 passed", async () => {
    const decision = await decideMissionCompletion({
      missionIdentifier: "mission-1",
      ports: basePorts({
        isCompletionReceiptRequired: true,
        readReceipt: async (_mission, taskIdentifier) => receipt(taskIdentifier),
        readIndependentVerdict: async () => ({ isAccepted: true, reasons: [] }),
      }),
    });
    expect(decision.isAllowed).toBe(true);
    expect(decision.steps.every((step) => step.status === "passed")).toBe(true);
  });
});
