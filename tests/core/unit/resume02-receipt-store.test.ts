/**
 * RESUME-02（2026-11-24）：恢复意图回执仓库的反例。
 *
 * - 同一请求重复登记 ⇒ 同一回执（不延长期限、不新增记录）；
 * - 过期 ⇒ 既查不到也会被清理；
 * - 损坏文件 ⇒ 视为无回执（fail-closed），不把坏数据当有效许可；
 * - 跨实例（重启）仍可查阅——但过期后一律无效。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ResumeIntentReceiptStore } from "../../../packages/core/src/orchestration/continuation-receipt-store.js";
import type { StructuredContinuationRequest } from "../../../packages/core/src/orchestration/continuation-request.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-resume-receipt-"));
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

const nowIso = "2026-11-24T00:00:00.000Z";

describe("RESUME-02：回执仓库", () => {
  it("① 同一请求重复登记 ⇒ 同一回执、不延长期限、revision 不增长", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    const first = await store.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const second = await store.issue({
      receiptIdentifier: "receipt-2",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso: "2026-11-24T00:01:00.000Z",
    });
    expect(second.isDuplicate).toBe(true);
    expect(second.receipt.receiptIdentifier).toBe("receipt-1");
    expect(second.receipt.expiresAtIso).toBe(first.receipt.expiresAtIso);
    const raw = JSON.parse(
      await fs.readFile(path.join(baseDirectory, "resume-intent", "receipts.json"), "utf8"),
    ) as { revision: number; receipts: unknown[] };
    expect(raw.receipts).toHaveLength(1);
    expect(raw.revision).toBe(1);
  });

  it("② 跨实例（重启）仍可查阅并复核", async () => {
    const writer = new ResumeIntentReceiptStore({ baseDirectory });
    await writer.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const reader = new ResumeIntentReceiptStore({ baseDirectory });
    const found = await reader.findValid({
      requestIdentifier: "req-1",
      principalIdentifier: "user-1",
      taskIdentifier: "T-1",
      expectedRevision: 3,
      nowIso: "2026-11-24T00:02:00.000Z",
    });
    expect(found.receipt?.receiptIdentifier).toBe("receipt-1");
    expect(found.reasonCode).toBeNull();
  });

  it("③ 过期 ⇒ 查不到，并可被清理", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    await store.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const afterExpiry = "2026-11-24T00:05:00.000Z";
    const found = await store.findValid({
      requestIdentifier: "req-1",
      principalIdentifier: "user-1",
      taskIdentifier: "T-1",
      expectedRevision: 3,
      nowIso: afterExpiry,
    });
    expect(found.receipt).toBeNull();
    expect(found.reasonCode).toBe("receipt-expired");
    expect(await store.pruneExpired(afterExpiry)).toBe(1);
    expect(await store.count(afterExpiry)).toBe(0);
  });

  it("④ 主体/目标/版本不一致 ⇒ 拒绝并给原因码", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    await store.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const base = {
      requestIdentifier: "req-1",
      principalIdentifier: "user-1",
      taskIdentifier: "T-1",
      expectedRevision: 3,
      nowIso: "2026-11-24T00:01:00.000Z",
    };
    expect((await store.findValid({ ...base, principalIdentifier: "user-2" })).reasonCode).toBe(
      "principal-mismatch",
    );
    expect((await store.findValid({ ...base, taskIdentifier: "T-2" })).reasonCode).toBe(
      "target-mismatch",
    );
    expect((await store.findValid({ ...base, expectedRevision: 4 })).reasonCode).toBe(
      "revision-changed",
    );
  });

  it("⑤ 未登记的请求 ⇒ receipt-not-found（不给出猜测许可）", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    expect(
      (
        await store.findValid({
          requestIdentifier: "unknown",
          principalIdentifier: "user-1",
          taskIdentifier: "T-1",
          expectedRevision: 3,
          nowIso,
        })
      ).reasonCode,
    ).toBe("receipt-not-found");
  });

  it("⑥ 文件损坏 ⇒ 视为无回执（fail-closed），不是有效许可", async () => {
    await fs.mkdir(path.join(baseDirectory, "resume-intent"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "resume-intent", "receipts.json"),
      "{ broken",
      "utf8",
    );
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    expect(
      (
        await store.findValid({
          requestIdentifier: "req-1",
          principalIdentifier: "user-1",
          taskIdentifier: "T-1",
          expectedRevision: 3,
          nowIso,
        })
      ).reasonCode,
    ).toBe("receipt-not-found");
    expect(await store.count(nowIso)).toBe(0);
  });

  it("⑦ 不同请求各自登记（不互相覆盖）", async () => {
    const store = new ResumeIntentReceiptStore({ baseDirectory });
    await store.issue({
      receiptIdentifier: "receipt-1",
      request: request(),
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    await store.issue({
      receiptIdentifier: "receipt-2",
      request: request({ requestIdentifier: "req-2", taskIdentifier: "T-2" }),
      principalIdentifier: "user-1",
      sourceChannel: "sdk",
      nowIso,
    });
    expect(await store.count(nowIso)).toBe(2);
  });
});
