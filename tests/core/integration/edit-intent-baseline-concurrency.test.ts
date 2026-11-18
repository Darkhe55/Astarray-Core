/**
 * WIRING-04 §36.2 反例：Agent 编辑意图基线（2026-11-19）。
 *
 * 同一个个体的意图文档是读-改-写：并发记录基线若互相覆盖，
 * 会让"人工改动后的内容"变成合法基线（越权覆盖）。此处证明并发不丢条目。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentEditIntentGuard } from "../../../packages/core/src/orchestration/agent-edit-intent-guard.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "edit-intent-concurrency-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildGuard(): AgentEditIntentGuard {
  return new AgentEditIntentGuard({
    baseDirectory: stateDirectory,
    nowUnixMilliseconds: () => Date.parse("2026-11-18T00:00:00.000Z"),
  });
}

describe("WIRING-04 §36.2：编辑意图基线并发", () => {
  it("① 同一 agent 并发记录 40 个路径基线 ⇒ 40 条都保留", async () => {
    const firstGuard = buildGuard();
    const secondGuard = buildGuard();
    const records: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      records.push(
        firstGuard.recordReadBaseline({
          agentInstanceId: "agent-1",
          taskExecutionIdentifier: "task-exec:agent-1",
          targetPath: `/workspace/a-${String(index)}.md`,
          contentFingerprint: `sha256:${String(index).padStart(64, "0")}`,
        }),
        secondGuard.recordReadBaseline({
          agentInstanceId: "agent-1",
          taskExecutionIdentifier: "task-exec:agent-1",
          targetPath: `/workspace/b-${String(index)}.md`,
          contentFingerprint: `sha256:${String(index + 100).padStart(64, "0")}`,
        }),
      );
    }
    await Promise.all(records);

    const document = JSON.parse(
      await fs.readFile(
        path.join(stateDirectory, "agent-edit-intents", "agent-1.json"),
        "utf8",
      ),
    ) as {
      intents: Array<{ initialResourceFingerprintsByPath: Record<string, string> }>;
    };
    const intent = document.intents[0];
    expect(Object.keys(intent?.initialResourceFingerprintsByPath ?? {})).toHaveLength(40);
  }, 60_000);
});
