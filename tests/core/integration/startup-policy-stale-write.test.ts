/**
 * WIRING-04 §36.2 反例：启动恢复**用户策略**的陈旧写入（2026-11-19）。
 *
 * 策略是用户意图：旧值覆盖新值等于偷偷改回旧策略。
 * A 先读（版本 0）→ B 提交（版本 1）→ A 用版本 0 提交 ⇒ 必须显式冲突，磁盘保留 B。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_STARTUP_RECOVERY_POLICY,
  StartupRecoveryPolicyStore,
} from "../../../packages/core/src/orchestration/startup-recovery-policy.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "startup-policy-cas-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): StartupRecoveryPolicyStore {
  return new StartupRecoveryPolicyStore({ baseDirectory: stateDirectory });
}

describe("WIRING-04 §36.2：启动恢复策略的陈旧写入", () => {
  it("① A 用旧版本提交 ⇒ 冲突；磁盘保留 B 的策略", async () => {
    const storeA = buildStore();
    const storeB = buildStore();

    /** A 先读：拿到版本 0（尚未落盘任何策略）。 */
    expect(await storeA.readPolicyRevision()).toBe(0);

    /** B 提交：最大恢复数 5，版本 0 → 1。 */
    const bWrite = await storeB.writePolicyIfRevision({
      policy: { ...DEFAULT_STARTUP_RECOVERY_POLICY, maximumResumePerStartup: 5 },
      expectedRevision: 0,
    });
    expect(bWrite.outcome).toBe("written");

    /** A 用旧的版本 0 提交不同策略：必须冲突。 */
    const staleWrite = await storeA.writePolicyIfRevision({
      policy: { ...DEFAULT_STARTUP_RECOVERY_POLICY, maximumResumePerStartup: 3 },
      expectedRevision: 0,
    });
    expect(staleWrite.outcome).toBe("conflict");
    expect(staleWrite.currentRevision).toBe(1);

    /** 磁盘仍是 B 的策略。 */
    const reloaded = await buildStore().readPolicy();
    expect(reloaded.policy.maximumResumePerStartup).toBe(5);
    expect(await buildStore().readPolicyRevision()).toBe(1);
  }, 60_000);

  it("② 兼容入口 writePolicy 也会递增版本（不制造回退）", async () => {
    const store = buildStore();
    await store.writePolicyIfRevision({
      policy: DEFAULT_STARTUP_RECOVERY_POLICY,
      expectedRevision: 0,
    });
    await store.writePolicy({ ...DEFAULT_STARTUP_RECOVERY_POLICY, maximumAttemptsPerTask: 4 });
    expect(await buildStore().readPolicyRevision()).toBe(2);
  }, 60_000);
});
