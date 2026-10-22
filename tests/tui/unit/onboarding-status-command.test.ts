/**
 * ONBOARD-01-02 公开入口反例（2026-10-23）：`onboarding status`。
 *
 * 覆盖：首次提示、忙碌抑制、「不再提示」持久化、冷却、两处入口不抢焦点、损坏状态 fail-closed。
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeOnboardingStatusCommand } from "../../../packages/tui/src/cli/onboarding-command.js";

const temporaryDirectories: string[] = [];

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-onboarding-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeHintState(stateDirectory: string, content: unknown): Promise<void> {
  const directory = path.join(stateDirectory, "onboarding");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "hint-state.json"),
    typeof content === "string" ? content : JSON.stringify(content),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function options(stateDirectory: string, overrides: Record<string, unknown> = {}) {
  return {
    stateDirectory,
    nowIso: "2026-10-23T10:00:00.000Z",
    isUserTyping: false,
    isAuthorizationPending: false,
    isErrorRecovery: false,
    isEmergencyActive: false,
    isHighLoad: false,
    hasCompletedMilestone: false,
    hasAskedAboutEfficiency: false,
    hasDuplicateWorkDetected: false,
    isStateUnknownAfterMigration: false,
    isJsonOutput: true,
    ...overrides,
  };
}

interface OnboardingReport {
  decision: { kind: string; reasonCode?: string; reason?: string };
  entries: Array<{
    kind: string;
    doesStealFocus?: boolean;
    impliesAuthorization?: boolean;
  }>;
}

async function captureJson(
  execute: () => Promise<number>,
): Promise<{ status: number; report: OnboardingReport }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stdout.write);
  try {
    const status = await execute();
    const text = chunks.join("");
    if (text.trim() === "") throw new Error("命令没有输出 JSON");
    return { status, report: JSON.parse(text) as OnboardingReport };
  } finally {
    spy.mockRestore();
  }
}

describe("ONBOARD-01-02 onboarding status", () => {
  it("① 全新状态 ⇒ show-first，两处入口 show 且不抢焦点/不隐式授权", async () => {
    const stateDirectory = await createStateDirectory();
    const { report } = await captureJson(() => executeOnboardingStatusCommand(options(stateDirectory)));
    expect(await executeOnboardingStatusCommand(options(stateDirectory))).toBe(0);
    expect(report.decision.kind).toBe("show-first");
    expect(report.entries).toHaveLength(2);
    expect(
      report.entries.every((entry: OnboardingReport["entries"][number]) => entry.kind === "show" && entry.doesStealFocus === false && entry.impliesAuthorization === false),
    ).toBe(true);
  });

  it("② 用户输入中 ⇒ suppress/user-busy", async () => {
    const stateDirectory = await createStateDirectory();
    const { report } = await captureJson(() =>
      executeOnboardingStatusCommand(options(stateDirectory, { isUserTyping: true })),
    );
    expect(report.decision).toMatchObject({ kind: "suppress", reasonCode: "user-busy" });
    expect(report.entries.every((entry: OnboardingReport["entries"][number]) => entry.kind === "suppressed")).toBe(true);
  });

  it("③「不再提示」持久化生效 ⇒ never-show-again", async () => {
    const stateDirectory = await createStateDirectory();
    await writeHintState(stateDirectory, {
      schemaVersion: 1,
      hasSeenFirstHint: true,
      isNeverShowAgain: true,
      lastShownAtIso: "2026-10-20T10:00:00.000Z",
      shownCount: 2,
    });
    const { report } = await captureJson(() => executeOnboardingStatusCommand(options(stateDirectory)));
    expect(report.decision.reasonCode).toBe("never-show-again");
  });

  it("④ 冷却未到 ⇒ suppress/cooldown", async () => {
    const stateDirectory = await createStateDirectory();
    await writeHintState(stateDirectory, {
      schemaVersion: 1,
      hasSeenFirstHint: true,
      isNeverShowAgain: false,
      lastShownAtIso: "2026-10-22T10:00:00.000Z",
      shownCount: 1,
    });
    const { report } = await captureJson(() =>
      executeOnboardingStatusCommand(options(stateDirectory, { hasCompletedMilestone: true })),
    );
    expect(report.decision.reasonCode).toBe("cooldown");
  });

  it("⑤ 迁移后状态缺失（首次态）⇒ 不重复弹首次", async () => {
    const stateDirectory = await createStateDirectory();
    const { report } = await captureJson(() =>
      executeOnboardingStatusCommand(options(stateDirectory, { isStateUnknownAfterMigration: true })),
    );
    expect(report.decision.reasonCode).toBe("state-unknown-after-migration");
  });

  it("⑥ 状态文件损坏 ⇒ 非 0（fail-closed）", async () => {
    const stateDirectory = await createStateDirectory();
    await writeHintState(stateDirectory, "{ broken");
    await expect(executeOnboardingStatusCommand(options(stateDirectory))).resolves.toBe(1);
  });
});


