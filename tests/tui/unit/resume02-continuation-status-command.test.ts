/**
 * RESUME-02 状态命令测试（2026-11-24）：
 * 默认关闭；配置显式开启后才报告 enabled；只列活动领取，不宣称已恢复。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTINUATION_CONFIG_FILE_NAME,
  executeContinuationStatusCommand,
  readCheckpointContinuationSetting,
} from "../../../packages/tui/src/cli/continuation-command.js";
import { CheckpointContinuationController } from "../../../packages/core/src/orchestration/continuation-controller.js";
import { ResumeIntentReceiptStore } from "../../../packages/core/src/orchestration/continuation-receipt-store.js";
import { resolveCheckpointContinuationSetting } from "../../../packages/core/src/orchestration/continuation-request.js";

let stateDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-continuation-cli-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { lines, restore: () => { process.stdout.write = originalWrite; } };
}

describe("RESUME-02：continuation status", () => {
  it("① 配置缺失 ⇒ 关闭（config-missing），且不因存在领取而声称可用", async () => {
    const setting = await readCheckpointContinuationSetting(stateDirectory);
    expect(setting).toEqual({ isEnabled: false, reason: "config-missing" });
    const capture = captureStdout();
    try {
      expect(
        await executeContinuationStatusCommand({
          stateDirectory,
          nowIso,
          isJsonOutput: true,
        }),
      ).toBe(0);
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.lines.join("")) as {
      isEnabled: boolean;
      settingReason: string;
      activeClaims: unknown[];
      note: string;
    };
    expect(parsed.isEnabled).toBe(false);
    expect(parsed.settingReason).toBe("config-missing");
    expect(parsed.activeClaims).toEqual([]);
    expect(parsed.note).toContain("不等于已恢复");
  });

  it("② 配置损坏 ⇒ 关闭（config-invalid）", async () => {
    const configPath = path.join(stateDirectory, CONTINUATION_CONFIG_FILE_NAME);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "{ broken", "utf8");
    expect(await readCheckpointContinuationSetting(stateDirectory)).toEqual({
      isEnabled: false,
      reason: "config-invalid",
    });
  });

  it("③ 显式开启 + 领取 + 回执 ⇒ 如实列出（只读，不改状态）", async () => {
    const configPath = path.join(stateDirectory, CONTINUATION_CONFIG_FILE_NAME);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ isCheckpointContinuationEnabled: true }),
      "utf8",
    );
    const receiptStore = new ResumeIntentReceiptStore({ baseDirectory: stateDirectory });
    await receiptStore.issue({
      receiptIdentifier: "receipt-1",
      request: {
        requestIdentifier: "req-1",
        projectIdentifier: "project-a",
        conversationIdentifier: "conv-1",
        taskIdentifier: "T-1",
        expectedRevision: 3,
      },
      principalIdentifier: "user-1",
      sourceChannel: "cli",
      nowIso,
    });
    const controller = new CheckpointContinuationController({
      baseDirectory: stateDirectory,
      receiptStore,
      setting: resolveCheckpointContinuationSetting({ configuredValue: true }),
    });
    const claim = await controller.requestContinuation({
      request: {
        requestIdentifier: "req-1",
        projectIdentifier: "project-a",
        conversationIdentifier: "conv-1",
        taskIdentifier: "T-1",
        expectedRevision: 3,
      },
      candidates: [
        { taskIdentifier: "T-1", projectIdentifier: "project-a", taskState: "planned", revision: 3 },
      ],
      principalIdentifier: "user-1",
      requestIdentifier: "req-1",
      nowIso,
    });
    expect(claim.status).toBe("claimed");

    const capture = captureStdout();
    try {
      await executeContinuationStatusCommand({ stateDirectory, nowIso, isJsonOutput: true });
    } finally {
      capture.restore();
    }
    const parsed = JSON.parse(capture.lines.join("")) as {
      isEnabled: boolean;
      activeReceiptCount: number;
      activeClaims: Array<{ taskIdentifier: string; fencingToken: number }>;
    };
    expect(parsed.isEnabled).toBe(true);
    expect(parsed.activeReceiptCount).toBe(1);
    expect(parsed.activeClaims).toHaveLength(1);
    expect(parsed.activeClaims[0]).toMatchObject({ taskIdentifier: "T-1", fencingToken: 1 });

    /** 只读：命令执行后领取仍在（未被消费/推进）。 */
    expect(await controller.listClaims(nowIso)).toHaveLength(1);
  });
});
