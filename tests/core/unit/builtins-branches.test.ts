/**
 * B9（2026-11-24）：内置工具的**参数校验/未装配**分支。
 *
 * 这些分支的共同纪律：参数非法或端口未装配时必须**显式报错**，
 * 不能静默返回空结果或伪装成功。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";

let temporaryDirectory: string;
let workspaceDirectory: string;
let temporaryDirectoryPath: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-builtins-branches-"));
  workspaceDirectory = path.join(temporaryDirectory, "workspace");
  temporaryDirectoryPath = path.join(temporaryDirectory, "temp");
  await fs.mkdir(workspaceDirectory);
  await fs.mkdir(temporaryDirectoryPath);
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function executionContext() {
  return {
    workspaceBoundary: new WorkspaceBoundary(workspaceDirectory),
    temporaryDirectoryPath,
    requestingAgentInstanceId: "agent-test",
    backupServicePort: null,
    vault: null,
    deletionController: null,
    protectedStoragePolicy: new ProtectedStoragePolicy({
      stateDirectoryPath: temporaryDirectory,
    }),
  };
}

describe("B9：内置工具参数/装配分支", () => {
  it("① readFile 缺 filePath ⇒ 显式报错（不返回空内容）", async () => {
    await expect(
      executeBuiltinTool("readFile", JSON.stringify({}), executionContext()),
    ).rejects.toThrowError(/filePath/);
  });

  it("② createProjectFile 缺 content ⇒ 显式报错", async () => {
    await expect(
      executeBuiltinTool(
        "createProjectFile",
        JSON.stringify({ filePath: "a.txt" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/content/);
  });

  it("③ replaceFileContent 缺 content ⇒ 显式报错", async () => {
    await expect(
      executeBuiltinTool(
        "replaceFileContent",
        JSON.stringify({ filePath: "a.txt" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/content/);
  });

  it("④ taskSequenceStatus 缺 sequenceId ⇒ 显式报错", async () => {
    await expect(
      executeBuiltinTool("taskSequenceStatus", JSON.stringify({}), executionContext()),
    ).rejects.toThrowError(/sequenceId/);
  });

  it("⑤ searchProjectText 缺 pattern ⇒ 显式报错", async () => {
    await expect(
      executeBuiltinTool("searchProjectText", JSON.stringify({ pattern: "" }), executionContext()),
    ).rejects.toThrowError(/pattern/);
  });

  it("⑥ gitReadonlyView 未装配本地策略引擎 ⇒ 明确拒绝（不猜）", async () => {
    await expect(
      executeBuiltinTool(
        "gitReadonlyView",
        JSON.stringify({ action: "status" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/本地策略引擎未装配/);
  });

  it("⑦ processExecution 缺调用主体 ⇒ 明确拒绝", async () => {
    const context = {
      ...executionContext(),
      requestingAgentInstanceId: "",
      /** 只验证"缺主体"分支在控制器已装配时触发；其余方法本用例不会调用。 */
      processExecutionController: {} as never,
    };
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({ action: "status", executionId: "e-1" }),
        context,
      ),
    ).rejects.toThrowError(/缺少调用主体/);
  });

  it("⑧ processExecution 非法 action ⇒ 显式报错", async () => {
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({ action: "explode" }),
        executionContext(),
      ),
    ).rejects.toThrowError(/action/);
  });
});
