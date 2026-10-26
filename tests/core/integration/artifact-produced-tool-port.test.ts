/** GUI-03-06：写工具经 PolicyWrapper 真实产生结构化产物。 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ModeMachine } from "../../../packages/core/src/core/mode-machine.js";
import {
  PermissionDecider,
  SessionAuthorizationManager,
} from "../../../packages/core/src/core/permission-policy.js";
import {
  BUILTIN_TOOL_DESCRIPTORS,
} from "../../../packages/core/src/tools/builtins.js";
import { PolicyWrapper } from "../../../packages/core/src/tools/policy-wrapper.js";
import { ProtectedStoragePolicy } from "../../../packages/core/src/tools/protected-storage-policy.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { WorkspaceBoundary } from "../../../packages/core/src/tools/workspace-boundary.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<{ root: string; state: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-produce-"));
  directories.push(root);
  return { root, state: path.join(root, "state") };
}

describe("写工具产物", () => {
  it("① createProjectFile 成功时返回 producedArtifacts 且文件存在", async () => {
    const { root, state } = await createWorkspace();
    const modeMachine = new ModeMachine("devolve");
    const registry = new ToolRegistry();
    const descriptor = BUILTIN_TOOL_DESCRIPTORS.find(
      (candidate) => candidate.name === "createProjectFile",
    );
    if (descriptor === undefined) throw new Error("descriptor missing");
    registry.register(descriptor);
    const wrapper = new PolicyWrapper({
      permissionDecider: new PermissionDecider(
        modeMachine,
        new SessionAuthorizationManager(),
      ),
      registry,
      workspaceBoundary: new WorkspaceBoundary(root),
      temporaryDirectoryPath: path.join(root, "temp"),
      workerAllowedToolNames: null,
      nowUnixSeconds: () => Math.floor(Date.now() / 1000),
      getCurrentMode: () => modeMachine.getCurrentMode(),
      requestingAgentInstanceId: "agent-test",
      protectedStoragePolicy: new ProtectedStoragePolicy({ stateDirectoryPath: state }),
    });
    const result = await wrapper.execute(
      "createProjectFile",
      JSON.stringify({ filePath: "artifact.txt", content: "ARTIFACT" }),
      "call-1",
      new AbortController().signal,
    );
    expect(result.kind).toBe("success");
    if (result.kind === "success") {
      expect(result.producedArtifacts?.[0]?.artifactType).toBe("project-file");
    }
    await expect(fs.readFile(path.join(root, "artifact.txt"), "utf8")).resolves.toBe(
      "ARTIFACT",
    );
  });
});



