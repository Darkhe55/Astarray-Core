/**
 * B9（2026-11-24）：`cross-project list` 只读过滤与 `doctor errors` 参数校验分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import {
  executeCrossProjectListCommand,
  executeDoctorErrorsCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-cpx-doctor-"));
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

function silenceStderr(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}

async function run(action: () => Promise<number>): Promise<{ exitCode: number; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

async function seedAuthorization(): Promise<void> {
  const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
  await store.grantAuthorization({
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: { pathPrefixes: ["src/"], realPaths: [], isDynamicSharedDirectory: false },
    argumentsHash: "sha256:abc",
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-1",
    receivingAgentInstanceId: "agent-1",
    nowIso: "2026-11-24T00:00:00.000Z",
  });
}

describe("B9：cross-project list", () => {
  it("① 空状态（JSON/文本）⇒ 0 授权、0 副本", async () => {
    const json = await run(() =>
      executeCrossProjectListCommand({ stateDirectory, isJsonOutput: true }),
    );
    const parsed = JSON.parse(json.output) as {
      authorizations: unknown[];
      copyReceipts: { count: number };
    };
    expect(parsed.authorizations).toEqual([]);
    expect(parsed.copyReceipts.count).toBe(0);

    const text = await run(() =>
      executeCrossProjectListCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(text.output).toContain("authorizations: 0");
    expect(text.output).toContain("copy-receipts: 0");
  });

  it("② 已登记授权：无过滤可见；按来源/目标/接收个体过滤；不匹配返回空", async () => {
    await seedAuthorization();

    const all = await run(() =>
      executeCrossProjectListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect((JSON.parse(all.output) as { authorizations: unknown[] }).authorizations).toHaveLength(1);

    const bySource = await run(() =>
      executeCrossProjectListCommand({
        stateDirectory,
        sourceProjectIdentifier: "project-a",
        isJsonOutput: true,
      }),
    );
    expect((JSON.parse(bySource.output) as { authorizations: unknown[] }).authorizations).toHaveLength(1);

    const byTarget = await run(() =>
      executeCrossProjectListCommand({
        stateDirectory,
        targetProjectIdentifier: "project-b",
        isJsonOutput: true,
      }),
    );
    expect((JSON.parse(byTarget.output) as { authorizations: unknown[] }).authorizations).toHaveLength(1);

    const byAgent = await run(() =>
      executeCrossProjectListCommand({
        stateDirectory,
        receivingAgentInstanceId: "agent-1",
        isJsonOutput: true,
      }),
    );
    expect((JSON.parse(byAgent.output) as { authorizations: unknown[] }).authorizations).toHaveLength(1);

    const mismatch = await run(() =>
      executeCrossProjectListCommand({
        stateDirectory,
        sourceProjectIdentifier: "project-z",
        isJsonOutput: true,
      }),
    );
    expect((JSON.parse(mismatch.output) as { authorizations: unknown[] }).authorizations).toEqual([]);
  });

  it("③ 文本视图列出授权与任务标识", async () => {
    await seedAuthorization();
    const { output } = await run(() =>
      executeCrossProjectListCommand({ stateDirectory, isJsonOutput: false }),
    );
    expect(output).toContain("auth-1");
    expect(output).toContain("task=T-1");
    expect(output).toContain("authorizations: 1");
  });
});

describe("B9：doctor errors 参数校验", () => {
  it("④ 非法 --since / --until / --page-size ⇒ usage error（exit 2）", async () => {
    const restoreStderr = silenceStderr();
    try {
      expect(
        (
          await run(() =>
            executeDoctorErrorsCommand({
              stateDirectory,
              isJsonOutput: true,
              windowStartIso: "not-a-time",
            }),
          )
        ).exitCode,
      ).toBe(2);
      expect(
        (
          await run(() =>
            executeDoctorErrorsCommand({
              stateDirectory,
              isJsonOutput: true,
              windowEndIso: "not-a-time",
            }),
          )
        ).exitCode,
      ).toBe(2);
      for (const pageSize of ["0", "abc", "-1"]) {
        expect(
          (
            await run(() =>
              executeDoctorErrorsCommand({ stateDirectory, isJsonOutput: true, pageSize }),
            )
          ).exitCode,
        ).toBe(2);
      }
    } finally {
      restoreStderr();
    }
  });

  it("⑤ 合法参数 + 空事件库 ⇒ exit 0（不伪造错误）", async () => {
    const { exitCode, output } = await run(() =>
      executeDoctorErrorsCommand({
        stateDirectory,
        isJsonOutput: true,
        pageSize: "2",
        windowStartIso: "2026-11-24T00:00:00.000Z",
        windowEndIso: "2026-11-25T00:00:00.000Z",
      }),
    );
    expect(exitCode).toBe(0);
    expect(output.trim().startsWith("{")).toBe(true);
  });
});
