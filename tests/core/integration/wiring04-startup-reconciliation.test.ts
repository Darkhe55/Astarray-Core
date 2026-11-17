/**
 * WIRING-04-01 产品入口反例（2026-11-17）：**启动恢复不重放已应用的业务**。
 *
 * 复现窗口：意图 pending + 权威状态已应用（完成回执未写）。
 * 通过真实入口 `runtime.runStartupRecovery()` 验证：只补 completed，`appliedMessages` 不增加。
 *
 * 说明：这里直接在状态目录里构造"崩溃后的磁盘现场"（台账 + 分区状态），
 * 而不是驱动一整条 mission —— 因为启动恢复的对账只依赖这两份持久化证据，
 * 造出真实 mission 只会引入与对账语义无关的调度噪声。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 120_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "wiring04-rec-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createRuntime() {
  return await createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    projectIdentifier: "project-alpha",
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    mainAgentInstanceId: "main-agent-1",
    streamOutput: () => {},
  } as never);
}

const MESSAGE_IDENTIFIER = "message-recover-1";

describe("WIRING-04-01：启动恢复对账（真实入口）", () => {
  it("① 意图 pending + 权威已应用 ⇒ 补 completed 且不重复应用", async () => {
    const runtime = await createRuntime();
    try {
      const partitionKey = runtime.coordinationPartitionKey;
      const partitionStatePath = path.join(
        stateDirectory,
        "coordination",
        "state",
        `${partitionKey.replace(/[^a-zA-Z0-9._-]/gu, "_")}.json`,
      );
      const ledgerPath = path.join(
        stateDirectory,
        "coordination",
        "task-application-ledger.json",
      );

      /** 造现场：消息已应用（appliedMessages），但意图仍是 pending（回执未写）。 */
      await fs.mkdir(path.dirname(partitionStatePath), { recursive: true });
      await fs.writeFile(
        partitionStatePath,
        JSON.stringify({
          schemaVersion: 1,
          partitionKey,
          stateVersion: 1,
          snapshot: { marker: "applied" },
          appliedMessages: [
            {
              messageIdentifier: MESSAGE_IDENTIFIER,
              appliedAtIso: "2026-11-17T00:00:00.000Z",
              resultingStateVersion: 1,
            },
          ],
          pendingWakeCount: 0,
        }),
        "utf8",
      );
      await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fs.writeFile(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          documentRevision: 1,
          entries: [
            {
              messageIdentifier: MESSAGE_IDENTIFIER,
              missionIdentifier: "mission-1",
              taskIdentifier: "T-1",
              status: "pending",
              reason: null,
              updatedAtIso: "2026-11-17T00:00:00.000Z",
            },
          ],
        }),
        "utf8",
      );

      await runtime.runStartupRecovery();

      const ledgerAfter = JSON.parse(await fs.readFile(ledgerPath, "utf8")) as {
        entries: Array<{ messageIdentifier: string; status: string }>;
      };
      const entry = ledgerAfter.entries.find(
        (candidate) => candidate.messageIdentifier === MESSAGE_IDENTIFIER,
      );
      expect(entry?.status).toBe("completed");

      /** 关键断言：没有发生第二次业务应用。 */
      const stateAfter = JSON.parse(await fs.readFile(partitionStatePath, "utf8")) as {
        appliedMessages: unknown[];
        stateVersion: number;
      };
      expect(stateAfter.appliedMessages).toHaveLength(1);
      expect(stateAfter.stateVersion).toBe(1);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 120_000);
});
