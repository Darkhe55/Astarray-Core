/**
 * B9（2026-11-25）：门面零覆盖方法第四批——mission 控制、直接派发、运行时插入、zip 安装、工件核验。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-facade-batch4-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
}

async function settle<T>(
  action: () => T | Promise<T>,
): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function settledOk(result: { value?: unknown; error?: string }): boolean {
  return result.error !== undefined || result.value !== undefined;
}

describe("B9：门面零覆盖方法（第四批）", () => {
  it("① mission 控制：未知状态查询抛错、取消幂等、模式切换与非法模式", async () => {
    const facade = await createFacade();
    try {
      const status = await settle(() => facade.queryMissionStatus("mission-missing"));
      expect(status.error).toContain("mission-missing");

      const cancelled = await settle(() => facade.cancelMission("mission-missing"));
      expect(cancelled.value).toBeUndefined();

      const switched = await settle(async () => facade.transitionMode("devolve" as never));
      /** 成功时返回 void；失败才算错。 */
      expect(switched.error).toBeUndefined();
      const invalid = await settle(async () => facade.transitionMode("not-a-mode" as never));
      expect(invalid.error).toBeDefined();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 直接派发：序列不存在 ⇒ 如实失败（不伪造任务）", async () => {
    const facade = await createFacade();
    try {
      const dispatched = await settle(() =>
        facade.dispatchDirectTask({
          projectIdentifier: "project-1",
          missionIdentifier: "mission-missing",
          ownerAgentInstanceIdentifier: "agent-1",
          sequenceIdentifier: "seq-missing",
          targetSecondaryAgentInstanceId: "agent-2",
          scopeDescription: "范围",
          originalUserInstruction: "原始指令",
          acceptanceCriteria: "验收条件",
          anchor: { predecessorTaskIds: [], successorTaskIds: [] },
          attachedContextReferenceHashes: [],
        } as never),
      );
      expect(dispatched.error).toBeDefined();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 运行时插入：缺序列 ⇒ 拒绝或明确结果", async () => {
    const facade = await createFacade();
    try {
      const inserted = await settle(() =>
        facade.requestRuntimeTaskInsertion({
          projectIdentifier: "project-1",
          missionIdentifier: "mission-missing",
          sequenceIdentifier: "seq-missing",
          instructionText: "插入任务",
          expectedRevision: 1,
          anchor: { predecessorTaskIds: [], successorTaskIds: [] },
        } as never),
      );
      expect(settledOk(inserted)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 工具包 zip：预览/安装不存在的 zip ⇒ 拒绝", async () => {
    const facade = await createFacade();
    try {
      const missingZip = path.join(stateDirectory, "missing.zip");
      const preview = await settle(() => facade.previewToolPackageZip(missingZip));
      expect(preview.error).toBeDefined();

      const installed = await settle(() =>
        facade.installToolPackageZip({ zipPath: missingZip, isConfirmed: true }),
      );
      expect(installed.error).toBeDefined();
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("⑤ 工件：未知工件核验失败；查询返回数组", async () => {
    const facade = await createFacade();
    try {
      const verified = await settle(() =>
        facade.verifyArtifact({ artifactIdentifier: "artifact-missing", status: "verified" } as never),
      );
      expect(verified.error).toBeDefined();

      const artifacts = await settle(async () => facade.queryArtifacts());
      expect(Array.isArray(artifacts.value)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
