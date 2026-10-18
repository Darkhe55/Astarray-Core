/**
 * `project reconcile` 的**进程内**反例（2026-10-19 R34）。
 *
 * 为什么还要进程内：argv 级用例跑的是 `dist/cli.js`，而变异验证注入的是 **src** 反事实
 * ⇒ 没有构建时 argv 用例看不到变异。进程内用例直接导入 src，保证变异必被拦下。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeProjectReconcileCommand } from "../../../packages/tui/src/cli/project-relocation-command.js";

let workingDirectory: string;
let stdoutText: string;
let stderrText: string;

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
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-relocate-inproc-"));
  stdoutText = "";
  stderrText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("RELOCATE-01-03：project reconcile（进程内）", () => {
  it("① 只读且解析成功 ⇒ exit 0，报告改写计数与可执行状态", async () => {
    const inputFilePath = await writeInputFile(sampleInput());
    const exitCode = await executeProjectReconcileCommand({
      inputFilePath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      kind: string;
      isExecutionAllowed: boolean;
      resolvedReferenceCount: number;
      rewrittenReferenceCount: number;
    };
    expect(payload.kind).toBe("reconciled");
    expect(payload.isExecutionAllowed).toBe(true);
    expect(payload.resolvedReferenceCount).toBe(1);
    // 旧根引用必须被改写（计数不得恒为 0）
    expect(payload.rewrittenReferenceCount).toBe(1);
  });

  it("② 含写/外部副作用 ⇒ exit 1 且要求人工确认", async () => {
    const inputFilePath = await writeInputFile(sampleInput({ hasWriteOrExternalSideEffects: true }));
    const exitCode = await executeProjectReconcileCommand({
      inputFilePath,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(1);
    const payload = JSON.parse(stdoutText) as {
      isAutoResumeAllowed: boolean;
      isExecutionAllowed: boolean;
      requiredUserAction: string;
    };
    expect(payload.isAutoResumeAllowed).toBe(false);
    expect(payload.isExecutionAllowed).toBe(false);
    expect(payload.requiredUserAction).toContain("人工确认");
  });

  it("③ 解析失败 ⇒ exit 1 且给出稳定拒绝码；文本模式也打印原因", async () => {
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
    const exitCode = await executeProjectReconcileCommand({
      inputFilePath,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(1);
    expect(stdoutText).toContain("outside-old-root");
    expect(stdoutText).toContain("需要你做的");
  });

  it("④ 输入非法 ⇒ 以 2 退出（文件缺失/JSON 非法/字段非法）", async () => {
    // `failWith` 内部是 `process.exit(code)`；进程内测试把它替换成"记录并抛哨兵"，
    // 从而既能断言退出码，又不会真的结束测试进程。
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code ?? 0)}`);
    }) as never);

    const expectUsageError = async (inputFilePath: string): Promise<void> => {
      await expect(
        executeProjectReconcileCommand({ inputFilePath, isJsonOutput: false }),
      ).rejects.toThrow("process.exit:2");
    };

    await expectUsageError(path.join(workingDirectory, "missing.json"));

    const badJsonPath = path.join(workingDirectory, "bad.json");
    await fs.writeFile(badJsonPath, "{ not json", "utf8");
    await expectUsageError(badJsonPath);

    await expectUsageError(await writeInputFile(sampleInput({ projectStatus: "weird" })));
    await expectUsageError(await writeInputFile(sampleInput({ references: undefined })));

    expect(exitSpy).toHaveBeenCalled();
    expect(stderrText.length).toBeGreaterThan(0);
  });
});

