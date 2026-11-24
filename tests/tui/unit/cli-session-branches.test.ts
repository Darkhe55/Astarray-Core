/**
 * B9（2026-11-24）：`session` 与 `config install-enabled` 命令分支（真实临时状态目录）。
 *
 * 覆盖：提升列表（空/文本/JSON）、创建提升、撤销（存在/不存在）、会话关闭（文本/JSON）、
 * 安装开关的读写与 revision 递增。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

import {
  executeConfigInstallEnabledCommand,
  executeSessionElevateCommand,
  executeSessionElevationListCommand,
  executeSessionRevokeElevationCommand,
  executeSessionShutdownCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
const sessionId = "session-1";

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-session-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function run<T>(action: () => Promise<T>): Promise<{ exitCode: T; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

describe("B9：session 命令分支", () => {
  it("① elevation-list：空会话文本 ⇒「（无提升）」；JSON ⇒ 空数组", async () => {
    const text = await run(() =>
      executeSessionElevationListCommand({ stateDirectory, sessionId }),
    );
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain("（无提升）");

    const json = await run(() =>
      executeSessionElevationListCommand({ stateDirectory, sessionId, isJsonOutput: true }),
    );
    expect(JSON.parse(json.output)).toEqual([]);
  });

  it("② elevate ⇒ 创建成功；列表可见；JSON 列表含 capability", async () => {
    const created = await run(() =>
      executeSessionElevateCommand({
        stateDirectory,
        sessionId,
        capabilityId: "readFile",
        elevatedDecision: "allow",
        agentInstanceId: null,
        expiresAtIso: null,
      }),
    );
    expect(created.output).toContain("elevated");
    expect(created.output).toContain("readFile");

    const list = await run(() =>
      executeSessionElevationListCommand({ stateDirectory, sessionId, isJsonOutput: true }),
    );
    const elevations = JSON.parse(list.output) as Array<{ capabilityId: string }>;
    expect(elevations).toHaveLength(1);
    expect(elevations[0]?.capabilityId).toBe("readFile");
  });

  it("③ revoke-elevation：存在 ⇒ revoked；不存在 ⇒「（未找到）」", async () => {
    const created = await run(() =>
      executeSessionElevateCommand({
        stateDirectory,
        sessionId,
        capabilityId: "createProjectFile",
        elevatedDecision: "ask",
        agentInstanceId: "agent-1",
        expiresAtIso: null,
      }),
    );
    const elevationId = /elevated (\S+)\t/u.exec(created.output)?.[1];
    expect(elevationId).toBeDefined();

    const revoked = await run(() =>
      executeSessionRevokeElevationCommand({ stateDirectory, sessionId, elevationId: elevationId! }),
    );
    expect(revoked.output).toContain("revoked");

    const missing = await run(() =>
      executeSessionRevokeElevationCommand({ stateDirectory, sessionId, elevationId: "missing" }),
    );
    expect(missing.output).toContain("（未找到）");
  });

  it("④ shutdown：文本含 closed/revoked；JSON 含同名字段", async () => {
    const text = await run(() =>
      executeSessionShutdownCommand({ stateDirectory, sessionId, exportPath: null }),
    );
    expect(text.output).toContain("closed=");
    expect(text.output).toContain("revoked=");

    const json = await run(() =>
      executeSessionShutdownCommand({
        stateDirectory,
        sessionId,
        exportPath: null,
        isJsonOutput: true,
      }),
    );
    const parsed = JSON.parse(json.output) as {
      closed: boolean;
      revokedElevationCount: number;
      exportWrote: boolean;
    };
    expect(typeof parsed.closed).toBe("boolean");
    expect(typeof parsed.revokedElevationCount).toBe("number");
    expect(typeof parsed.exportWrote).toBe("boolean");
  });
});

describe("B9：config install-enabled", () => {
  it("⑤ 默认关闭；开启/关闭各自写入且 revision 单调递增", async () => {
    const revisionOf = (output: string): number => {
      const match = /revision=(\d+)/u.exec(output);
      if (match === null) throw new Error(`缺少 revision: ${output}`);
      return Number.parseInt(match[1]!, 10);
    };
    const off = await run(() =>
      executeConfigInstallEnabledCommand({ stateDirectory, isEnabled: false }),
    );
    expect(off.output).toContain("assist-installation-enabled=false");
    const firstRevision = revisionOf(off.output);

    const on = await run(() =>
      executeConfigInstallEnabledCommand({ stateDirectory, isEnabled: true }),
    );
    expect(on.output).toContain("assist-installation-enabled=true");
    const secondRevision = revisionOf(on.output);
    expect(secondRevision).toBeGreaterThan(firstRevision);

    const again = await run(() =>
      executeConfigInstallEnabledCommand({ stateDirectory, isEnabled: false }),
    );
    expect(again.output).toContain("assist-installation-enabled=false");
    expect(revisionOf(again.output)).toBeGreaterThan(secondRevision);
  });
});
