/**
 * RESUME-02（2026-11-24）：续接领取控制器反例。
 *
 * - 关闭/不可续/回执无效 ⇒ 不产生领取（不派发、不写状态）；
 * - 可续 ⇒ 领取一次，带单调 fencing token；同一请求幂等返回同一领取；
 * - 不同请求对同任务同版本 ⇒ claim-conflict（合并到一个在途请求，不重复派发）；
 * - 版本前进后的新领取 token 递增，旧 token fencing 复核失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContinuationController } from "../../../packages/core/src/orchestration/continuation-controller.js";
import { ResumeIntentReceiptStore } from "../../../packages/core/src/orchestration/continuation-receipt-store.js";
import {
  resolveCheckpointContinuationSetting,
  type ContinuationCandidate,
  type StructuredContinuationRequest,
} from "../../../packages/core/src/orchestration/continuation-request.js";

let baseDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-continuation-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function request(overrides: Partial<StructuredContinuationRequest> = {}): StructuredContinuationRequest {
  return {
    requestIdentifier: "req-1",
    projectIdentifier: "project-a",
    conversationIdentifier: "conv-1",
    taskIdentifier: "T-1",
    expectedRevision: 3,
    ...overrides,
  };
}

function candidate(overrides: Partial<ContinuationCandidate> = {}): ContinuationCandidate {
  return {
    taskIdentifier: "T-1",
    projectIdentifier: "project-a",
    taskState: "planned",
    revision: 3,
    ...overrides,
  };
}

async function build(options: { readonly isEnabled: boolean }) {
  const receiptStore = new ResumeIntentReceiptStore({ baseDirectory });
  const controller = new ContinuationController({
    baseDirectory,
    receiptStore,
    setting: resolveCheckpointContinuationSetting({ configuredValue: options.isEnabled }),
  });
  return { receiptStore, controller };
}

describe("RESUME-02：领取控制器", () => {
  it("① 关闭 ⇒ disabled 且不写领取文件", async () => {
    const { controller } = await build({ isEnabled: false });
    const result = await controller.requestContinuation({
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(result.status).toBe("disabled");
    expect(result.claim).toBeNull();
    await expect(
      fs.access(path.join(baseDirectory, "continuation", "claims.json")),
    ).rejects.toBeTruthy();
  });

  it("② 运行中 ⇒ still-running，不领取", async () => {
    const { controller } = await build({ isEnabled: true });
    const result = await controller.requestContinuation({
      request: request(),
      candidates: [candidate({ taskState: "running" })],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(result.status).toBe("still-running");
    expect(result.claim).toBeNull();
  });

  it("③ 没有有效回执 ⇒ 拒绝（不能凭状态自行恢复）", async () => {
    const { controller } = await build({ isEnabled: true });
    const result = await controller.requestContinuation({
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(result.status).toBe("claim-conflict");
    expect(result.reasonCode).toBe("receipt-not-found");
    expect(result.claim).toBeNull();
  });

  it("④ 有回执且可续 ⇒ 领取一次（token=1）；同一请求重试幂等", async () => {
    const { controller, receiptStore } = await build({ isEnabled: true });
    await receiptStore.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const first = await controller.requestContinuation({
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(first.status).toBe("claimed");
    expect(first.claim?.fencingToken).toBe(1);

    const retry = await controller.requestContinuation({
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso: "2026-11-24T00:00:30.000Z",
    });
    expect(retry.status).toBe("already-claimed");
    expect(retry.claim?.fencingToken).toBe(1);
    expect(await controller.listClaims("2026-11-24T00:00:30.000Z")).toHaveLength(1);
  });

  it("⑤ 另一请求对同任务同版本 ⇒ claim-conflict（合并到一个在途请求）", async () => {
    const { controller, receiptStore } = await build({ isEnabled: true });
    await receiptStore.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    await receiptStore.issue({
      receiptIdentifier: "receipt-2",
      request: request({ requestIdentifier: "req-2" }),
      principalIdentifier: "user-1",
      sourceChannel: "sdk",
      nowIso,
    });
    await controller.requestContinuation({
      request: request(),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    const conflict = await controller.requestContinuation({
      request: request({ requestIdentifier: "req-2" }),
      candidates: [candidate()],
      principalIdentifier: "user-1",
      requestIdentifier: "req-2",
      nowIso: "2026-11-24T00:00:10.000Z",
    });
    expect(conflict.status).toBe("claim-conflict");
    expect(conflict.reasonCode).toBe("claim-conflict-active");
    expect(conflict.claim).toBeNull();
  });

  it("⑥ 版本前进的新领取 token 递增；旧 token 复核失败（fencing）", async () => {
    const { controller, receiptStore } = await build({ isEnabled: true });
    await receiptStore.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    await receiptStore.issue({
      receiptIdentifier: "receipt-3",
      request: request({ requestIdentifier: "req-3", expectedRevision: 4 }),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const oldClaim = (
      await controller.requestContinuation({
        request: request(),
        candidates: [candidate()],
        principalIdentifier: "user-1",
        requestIdentifier: "req-1",
        nowIso,
      })
    ).claim;
    expect(oldClaim?.fencingToken).toBe(1);

    const newClaim = (
      await controller.requestContinuation({
        request: request({ requestIdentifier: "req-3", expectedRevision: 4 }),
        candidates: [candidate({ revision: 4 })],
        principalIdentifier: "user-1",
        requestIdentifier: "req-3",
        nowIso: "2026-11-24T00:00:20.000Z",
      })
    ).claim;
    expect(newClaim?.fencingToken).toBe(2);
    expect(
      await controller.isFencingTokenCurrent({ claim: newClaim!, nowIso: "2026-11-24T00:00:30.000Z" }),
    ).toBe(true);
    expect(
      await controller.isFencingTokenCurrent({ claim: oldClaim!, nowIso: "2026-11-24T00:00:30.000Z" }),
    ).toBe(false);
  });

  it("⑦ 损坏的领取文件 ⇒ 无有效领取（fail-closed）", async () => {
    const { controller } = await build({ isEnabled: true });
    await fs.mkdir(path.join(baseDirectory, "continuation"), { recursive: true });
    await fs.writeFile(path.join(baseDirectory, "continuation", "claims.json"), "{ broken", "utf8");
    expect(await controller.listClaims(nowIso)).toEqual([]);
  });
});
