/**
 * `project reconcile` 的 argv 级反例（2026-10-19 R34）。
 *
 * 用户决策（按推荐）：命令名 `astarray project reconcile`；只读可自动恢复（exit 0）、
 * **含写/外部副作用必须人工确认（exit 1）**、blocked 即 exit 1、输入/用法错误 exit 2。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let workingDirectory: string;

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const childProcess = spawn(process.execPath, [cliEntryPath, ...args], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdoutText = "";
  let stderrText = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => (stdoutText += chunk));
  childProcess.stderr.on("data", (chunk: string) => (stderrText += chunk));
  const exitCode = await new Promise<number>((resolve) => {
    childProcess.on("close", (code: number | null) => resolve(code ?? 1));
  });
  return { exitCode, stdoutText, stderrText };
}

function sampleInput(overrides: Record<string, unknown> = {}) {
  return {
    projectIdentifier: "project-a",
    projectStatus: "in-progress",
    locationMappings: [
      {
        projectIdentifier: "project-a",
        deviceIdentifier: "device-1",
        fromLocationRevision: 2,
        oldRootPath: "/sample/projects/alpha-old",
        newRootPath: "/sample/projects/alpha-new",
      },
    ],
    declaredStructuredResourceKinds: ["document"],
    references: [
      {
        resourceKind: "document",
        requestedPath: "/sample/projects/alpha-old/docs/spec.md",
        owningProjectIdentifier: "project-a",
        owningDeviceIdentifier: "device-1",
        capturedLocationRevision: 1,
      },
    ],
    pendingOperations: [
      {
        operation: {
          operationIdentifier: "op-1",
          isCompleted: false,
          isIdempotent: true,
          hasUnknownSideEffect: false,
        },
        hasCurrentPermissionAtNewLocation: true,
        reliesOnPreviousOneTimeGrant: false,
        reliesOnTemporaryEscalation: false,
      },
    ],
    hasWriteOrExternalSideEffects: false,
    ...overrides,
  };
}

async function writeInputFile(content: unknown): Promise<string> {
  const filePath = path.join(workingDirectory, "reconcile-input.json");
  await fs.writeFile(filePath, JSON.stringify(content), "utf8");
  return filePath;
}

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-relocate-cli-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("RELOCATE-01-03：project reconcile CLI", () => {
  it("① 只读且全部解析 ⇒ exit 0，JSON 报告可自动恢复", async () => {
    const inputFilePath = await writeInputFile(sampleInput());
    const outcome = await runCli(["project", "reconcile", "--input", inputFilePath, "--json"]);
    expect(outcome.exitCode).toBe(0);
    const payload = JSON.parse(outcome.stdoutText) as {
      kind: string;
      isAutoResumeAllowed: boolean;
      isExecutionAllowed: boolean;
      resolvedReferenceCount: number;
    };
    expect(payload.kind).toBe("reconciled");
    expect(payload.isAutoResumeAllowed).toBe(true);
    expect(payload.isExecutionAllowed).toBe(true);
    expect(payload.resolvedReferenceCount).toBe(1);
  });

  it("② 含写/外部副作用 ⇒ exit 1 且提示人工确认（不得假装已恢复）", async () => {
    const inputFilePath = await writeInputFile(
      sampleInput({ hasWriteOrExternalSideEffects: true }),
    );
    const outcome = await runCli(["project", "reconcile", "--input", inputFilePath, "--json"]);
    expect(outcome.exitCode).toBe(1);
    const payload = JSON.parse(outcome.stdoutText) as {
      isAutoResumeAllowed: boolean;
      isExecutionAllowed: boolean;
      requiredUserAction: string;
    };
    expect(payload.isAutoResumeAllowed).toBe(false);
    expect(payload.isExecutionAllowed).toBe(false);
    expect(payload.requiredUserAction).toContain("人工确认");
  });

  it("③ 引用解析失败（.. 逃逸）⇒ exit 1 且给出稳定拒绝码", async () => {
    const inputFilePath = await writeInputFile(
      sampleInput({
        references: [
          {
            resourceKind: "document",
            requestedPath: "/sample/projects/alpha-old/../secret/notes.md",
            owningProjectIdentifier: "project-a",
            owningDeviceIdentifier: "device-1",
            capturedLocationRevision: 1,
          },
        ],
      }),
    );
    const outcome = await runCli(["project", "reconcile", "--input", inputFilePath, "--json"]);
    expect(outcome.exitCode).toBe(1);
    const payload = JSON.parse(outcome.stdoutText) as {
      kind: string;
      unresolvedReferences: Array<{ rejectionCode: string }>;
    };
    expect(payload.kind).toBe("blocked");
    expect(payload.unresolvedReferences[0]?.rejectionCode).toBe("outside-old-root");
  });

  it("④ 已完成项目 ⇒ exit 1（不可执行）并说明不重放", async () => {
    const inputFilePath = await writeInputFile(
      sampleInput({ projectStatus: "completed", pendingOperations: [] }),
    );
    const outcome = await runCli(["project", "reconcile", "--input", inputFilePath, "--json"]);
    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(outcome.stdoutText)).toMatchObject({
      kind: "skipped-already-completed",
      isExecutionAllowed: false,
    });
  });

  it("⑤ 非法 JSON / 字段非法 ⇒ exit 2", async () => {
    const badJsonPath = path.join(workingDirectory, "bad.json");
    await fs.writeFile(badJsonPath, "{ not json", "utf8");
    expect((await runCli(["project", "reconcile", "--input", badJsonPath])).exitCode).toBe(2);

    const badStatusPath = await writeInputFile(sampleInput({ projectStatus: "weird" }));
    expect((await runCli(["project", "reconcile", "--input", badStatusPath])).exitCode).toBe(2);

    const missingFieldPath = await writeInputFile(sampleInput({ locationMappings: undefined }));
    expect((await runCli(["project", "reconcile", "--input", missingFieldPath])).exitCode).toBe(2);

    expect((await runCli(["project", "reconcile"])).exitCode).not.toBe(0);
  });
});
