/**
 * B9（2026-11-25）：`processExecution` 内置工具的**守卫与参数契约**。
 *
 * 安全契约：没有装配沙箱后端时**拒绝执行**（不得降级到宿主进程）；
 * 缺少调用主体 / 执行归属不一致 ⇒ 拒绝；readOutput 必须指定 stream。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { BackupVault } from "../../../packages/core/src/tools/backup-vault.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

let temporaryDirectory: string;
let workspaceDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-proc-tool-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(path.join(temporaryDirectory, "temp"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function buildContext(overrides: Record<string, unknown> = {}) {
  const vault = new BackupVault({ baseDirectory: temporaryDirectory });
  await vault.initialize();
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath: path.join(temporaryDirectory, "temp"),
    requestingAgentInstanceId: "worker:mission-1:T-1:1",
    backupServicePort: vault,
    vault,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
    ...overrides,
  } as never;
}

describe("B9：processExecution 守卫", () => {
  it("① 非法 action ⇒ 拒绝（不进入任何执行路径）", async () => {
    const context = await buildContext();
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({ action: "delete-everything" }),
        context,
      ),
    ).rejects.toThrow(/action 必须为 start\/status\/readOutput\/cancel|统一工具入口调用非法|action 组合/u);
  });

  it("② 未装配沙箱后端 ⇒ 拒绝且不降级到宿主进程", async () => {
    const context = await buildContext();
    const outcome = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({ action: "status", executionId: "exec-1" }),
      context,
    ).catch((error: Error) => ({ error: error.message }));
    expect(JSON.stringify(outcome)).toMatch(/未装配沙箱执行后端|参数非法/u);
  });

  it("③ 缺少调用主体标识 ⇒ 拒绝", async () => {
    const context = await buildContext({ requestingAgentInstanceId: "", processExecutionController: fakeController() });
    const outcome = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({ action: "status", executionId: "exec-1" }),
      context,
    ).catch((error: Error) => ({ error: error.message }));
    expect(JSON.stringify(outcome)).toMatch(/缺少调用主体标识|参数非法/u);
  });

  it("④ readOutput 未指定 stream ⇒ 拒绝", async () => {
    const context = await buildContext({ processExecutionController: fakeController() });
    const outcome = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({ action: "readOutput", executionId: "exec-1" }),
      context,
    ).catch((error: Error) => ({ error: error.message }));
    expect(JSON.stringify(outcome)).toMatch(/stream=stdout\|stderr|参数非法/u);
  });

  it("⑤ cancel 的 reason 非字符串 ⇒ 拒绝", async () => {
    const context = await buildContext({ processExecutionController: fakeController() });
    const outcome = await executeBuiltinTool(
      "processExecution",
      JSON.stringify({ action: "cancel", executionId: "exec-1", reason: 42 }),
      context,
    ).catch((error: Error) => ({ error: error.message }));
    expect(JSON.stringify(outcome)).toMatch(/reason 必须是字符串|参数非法|cancel 不/u);
  });
});

function fakeController() {
  return {
    start: async () => ({ executionId: "exec-1", status: "running", isReusedByIdempotencyKey: false }),
    status: async () => ({ executionId: "exec-1", status: "running" }),
    readOutput: async () => ({ executionId: "exec-1", stream: "stdout", text: "", nextCursorBytes: 0 }),
    cancel: async () => ({ executionId: "exec-1", status: "cancelled" }),
  } as never;
}
