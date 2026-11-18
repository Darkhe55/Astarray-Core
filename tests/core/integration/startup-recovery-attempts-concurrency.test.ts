/**
 * WIRING-04 §36.2 反例：启动恢复尝试计数（2026-11-19）。
 *
 * 计数决定"还要不要再自动恢复"：并发失败若互相覆盖，会把上限判错
 * （无限重试，或已到上限却继续重试）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupRecoveryAttemptStore } from "../../../packages/core/src/orchestration/startup-recovery-runner.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "startup-attempts-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): StartupRecoveryAttemptStore {
  return new StartupRecoveryAttemptStore({ baseDirectory: stateDirectory });
}

describe("WIRING-04 §36.2：启动恢复尝试计数", () => {
  it("① 两个实例并发记录 40 个 mission 的失败 ⇒ 40 条全部落盘", async () => {
    const firstStore = buildStore();
    const secondStore = buildStore();
    const records: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      records.push(
        firstStore.recordAttempt({
          missionIdentifier: `mission-a-${String(index)}`,
          outcome: "failed",
          reason: "恢复失败",
          attemptedAtIso: "2026-11-18T00:00:00.000Z",
        }),
        secondStore.recordAttempt({
          missionIdentifier: `mission-b-${String(index)}`,
          outcome: "failed",
          reason: "恢复失败",
          attemptedAtIso: "2026-11-18T00:00:00.000Z",
        }),
      );
    }
    await Promise.all(records);

    const document = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "startup-recovery", "attempts.json"), "utf8"),
    ) as { attempts: Record<string, unknown> };
    expect(Object.keys(document.attempts)).toHaveLength(40);
  }, 60_000);

  it("② 同一 mission 并发两次失败 ⇒ 计数为 2（不丢一次尝试）", async () => {
    await Promise.all([
      buildStore().recordAttempt({
        missionIdentifier: "mission-1",
        outcome: "failed",
        reason: "恢复失败",
        attemptedAtIso: "2026-11-18T00:00:00.000Z",
      }),
      buildStore().recordAttempt({
        missionIdentifier: "mission-1",
        outcome: "failed",
        reason: "恢复失败",
        attemptedAtIso: "2026-11-18T00:00:01.000Z",
      }),
    ]);
    const record = await buildStore().readAttempt("mission-1");
    expect(record?.attemptCount).toBe(2);
  }, 60_000);
});
