/**
 * 提交身份跨实例并发（2026-11-18）。
 *
 * 身份记录是"同一次提交只受理一次"的依据：丢记录 ⇒ 同一请求被**重复受理**。
 * 两个独立实例并发提交不同请求，读-改-写必须串行化。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoordinationSubmissionIdentityStore } from "../../../packages/core/src/orchestration/coordination-submission-identity.js";

vi.setConfig({ testTimeout: 90_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "submission-identity-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CoordinationSubmissionIdentityStore {
  return new CoordinationSubmissionIdentityStore({
    stateDirectory,
    nowUnixMilliseconds: () => Date.parse("2026-11-18T00:00:00.000Z"),
  });
}

describe("提交身份跨实例并发", () => {
  it("① 两个实例并发提交 40 个请求 ⇒ 40 条身份记录全部落盘", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const submissions: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      submissions.push(
        firstStore.submit({
          partitionKey: "partition-1",
          sourceIdentifier: "source-1",
          requestIdentifier: `request-a-${String(index)}`,
          contentFingerprint: `sha256:${String(index).padStart(64, "0")}`,
        }),
        secondStore.submit({
          partitionKey: "partition-1",
          sourceIdentifier: "source-1",
          requestIdentifier: `request-b-${String(index)}`,
          contentFingerprint: `sha256:${String(index + 100).padStart(64, "0")}`,
        }),
      );
    }
    await Promise.all(submissions);

    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "partition-1.json"), "utf8"),
    ) as { records: Array<unknown> };
    expect(document.records).toHaveLength(40);
  }, 90_000);
});
