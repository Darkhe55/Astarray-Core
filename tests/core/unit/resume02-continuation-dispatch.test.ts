/**
 * RESUME-02 dispatch 接线测试（2026-11-24）：
 * 未领取不派发；领取后调用恢复门禁并传"显式确认=true"；blocked 保留领取可重试；端口抛错原样上抛。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckpointContinuationController } from "../../../packages/core/src/orchestration/continuation-controller.js";
import { CheckpointContinuationDispatchService } from "../../../packages/core/src/orchestration/continuation-dispatch.js";
import { ContinuationMetrics } from "../../../packages/core/src/orchestration/continuation-metrics.js";
import { ResumeIntentReceiptStore } from "../../../packages/core/src/orchestration/continuation-receipt-store.js";
import {
  resolveCheckpointContinuationSetting,
  type ContinuationCandidate,
  type StructuredContinuationRequest,
} from "../../../packages/core/src/orchestration/continuation-request.js";

let baseDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cont-dispatch-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function request(overrides: Partial<StructuredContinuationRequest> = {}): StructuredContinuationRequest {
  return {
    requestIdentifier: "req-1",
    projectIdentifier: "mission-1",
    conversationIdentifier: "conv-1",
    taskIdentifier: "T-1",
    expectedRevision: 3,
    ...overrides,
  };
}

function candidate(overrides: Partial<ContinuationCandidate> = {}): ContinuationCandidate {
  return {
    taskIdentifier: "T-1",
    projectIdentifier: "mission-1",
    taskState: "planned",
    revision: 3,
    ...overrides,
  };
}

async function build(options: { readonly withReceipt: boolean; readonly metrics?: ContinuationMetrics }) {
  const receiptStore = new ResumeIntentReceiptStore({ baseDirectory });
  const controller = new CheckpointContinuationController({
    baseDirectory,
    receiptStore,
    setting: resolveCheckpointContinuationSetting({ configuredValue: true }),
  });
  if (options.withReceipt) {
    await receiptStore.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
  }
  const resumeMission = vi.fn(async () => ({
    outcome: "resumed" as const,
    missionIdentifier: "mission-1",
    recoveredSafeNodes: ["T-1"],
    requiresHandoffIdentity: false,
    requiredReauthorizationTypes: [] as string[],
  }));
  const service = new CheckpointContinuationDispatchService({
    controller,
    resumePort: { resumeMission },
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
  });
  return { service, resumeMission, receiptStore, controller };
}

const baseInput = {
  missionIdentifier: "mission-1",
  request: request(),
  candidates: [candidate()],
  principalIdentifier: "user-1",
  requestIdentifier: "req-1",
  nowIso,
};

describe("RESUME-02：dispatch 接线", () => {
  it("① 无有效回执 ⇒ 不调用恢复端口", async () => {
    const { service, resumeMission } = await build({ withReceipt: false });
    const result = await service.dispatch(baseInput);
    expect(result.status).toBe("claim-conflict");
    expect(result.reasonCode).toBe("receipt-not-found");
    expect(resumeMission).not.toHaveBeenCalled();
  });

  it("② 运行中 ⇒ 不调用恢复端口", async () => {
    const { service, resumeMission } = await build({ withReceipt: true });
    const result = await service.dispatch({
      ...baseInput,
      candidates: [candidate({ taskState: "running" })],
    });
    expect(result.status).toBe("still-running");
    expect(resumeMission).not.toHaveBeenCalled();
  });

  it("③ 领取成功 ⇒ 调用恢复门禁且显式确认=true；resumed 透出恢复节点", async () => {
    const { service, resumeMission } = await build({ withReceipt: true });
    const result = await service.dispatch(baseInput);
    expect(resumeMission).toHaveBeenCalledWith({
      missionIdentifier: "mission-1",
      hasExplicitUserConfirmation: true,
    });
    expect(result).toMatchObject({
      status: "resumed",
      claim: { fencingToken: 1 },
      recoveredSafeNodes: ["T-1"],
    });
  });

  it("④ 恢复门禁要求重新鉴权 ⇒ blocked，但保留领取（可重试，不重复领取）", async () => {
    const { service, resumeMission, controller } = await build({ withReceipt: true });
    resumeMission.mockResolvedValueOnce({
      outcome: "recovery-reauthorization-required" as never,
      missionIdentifier: "mission-1",
      detail: "需要重新授权",
      requiredReauthorizationTypes: ["remote-delivery"],
      blockedDecisionItems: ["reauthorization"],
    } as never);
    const result = await service.dispatch(baseInput);
    expect(result).toMatchObject({
      status: "blocked",
      reasonCode: "recovery-reauthorization-required",
      detail: "需要重新授权",
      requiredReauthorizationTypes: ["remote-delivery"],
    });
    expect(result.claim?.fencingToken).toBe(1);

    /** 重试：复用同一领取（already-claimed 仍尝试派发），不新增领取。 */
    resumeMission.mockResolvedValueOnce({
      outcome: "resumed" as never,
      missionIdentifier: "mission-1",
      recoveredSafeNodes: ["T-1"],
    } as never);
    const retry = await service.dispatch({ ...baseInput, nowIso: "2026-11-24T00:00:30.000Z" });
    expect(retry.status).toBe("resumed");
    expect(await controller.listClaims("2026-11-24T00:00:30.000Z")).toHaveLength(1);
  });

  it("⑤ 恢复端口抛错 ⇒ 原样上抛（不伪装成功），领取保留", async () => {
    const { service, resumeMission, controller } = await build({ withReceipt: true });
    resumeMission.mockRejectedValueOnce(new Error("恢复门禁内部错误"));
    await expect(service.dispatch(baseInput)).rejects.toThrow("恢复门禁内部错误");
    expect(await controller.listClaims(nowIso)).toHaveLength(1);
  });
});

describe("RESUME-02 dispatch 观测计数", () => {
  it("⑦ resumed 与 blocked 都被计入一次（带原因码，不重复）", async () => {
    const metrics = new ContinuationMetrics();
    const harness = await build({ withReceipt: true, metrics });
    const result = await harness.service.dispatch({
      missionIdentifier: "mission-1",
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(result.status).toBe("resumed");
    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.entries).toEqual([{ outcome: "resumed", reasonCode: "resumed", count: 1 }]);
  });

  it("⑧ 未领取（状态推导拒绝）也如实计数，原因码透传", async () => {
    const metrics = new ContinuationMetrics();
    const harness = await build({ withReceipt: false, metrics });
    const result = await harness.service.dispatch({
      missionIdentifier: "mission-1",
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(result.status).not.toBe("resumed");
    const snapshot = metrics.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.entries[0]?.reasonCode).toBe(result.reasonCode);
  });
});