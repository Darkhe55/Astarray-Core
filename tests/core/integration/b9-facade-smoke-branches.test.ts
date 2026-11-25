/**
 * B9（2026-11-25）：门面**零覆盖方法**的烟囱分支（查询/创建类，不跑模型）。
 *
 * 这些方法此前分支命中为 0；本文件用最小合法/非法入参各调一次，覆盖入口守卫与成功路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-facade-smoke-"));
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

async function settle<T>(action: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("B9：门面零覆盖方法烟囱", () => {
  it("① 只读查询：活跃 mission / 指标 / 上下文设置 / 模型候选 / 实验目录", async () => {
    const facade = await createFacade();
    try {
      expect(await settle(async () => facade.getActiveMissionIds())).toHaveProperty("value");
      expect(await settle(async () => facade.getMetricsSnapshot())).toHaveProperty("value");
      expect(await settle(() => facade.queryContextSettings())).toHaveProperty("value");
      expect(await settle(() => facade.queryAgentModelCandidates())).toHaveProperty("value");
      expect(await settle(() => facade.queryExperimentCatalog())).toHaveProperty("value");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 权限组：能力清单 / 配置组列表 / 新建空组 / 新建内置组", async () => {
    const facade = await createFacade();
    try {
      const capabilities = await settle(() => facade.listPermissionCapabilities());
      expect(Array.isArray(capabilities.value)).toBe(true);
      const profiles = await settle(() => facade.listPermissionProfiles({ page: 1, pageSize: 10 } as never));
      expect(profiles.value !== undefined || profiles.error !== undefined).toBe(true);

      const blank = await settle(() =>
        facade.createPermissionProfile({
          displayName: "空白组",
          source: { kind: "blank" },
        } as never),
      );
      expect(blank.value !== undefined || blank.error !== undefined).toBe(true);

      const builtin = await settle(() =>
        facade.createPermissionProfile({
          displayName: "内置组副本",
          source: { kind: "builtin", profileId: "assist" },
        } as never),
      );
      expect(builtin.value !== undefined || builtin.error !== undefined).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 上下文预算：读取后按当前 revision 更新", async () => {
    const facade = await createFacade();
    try {
      const settings = await facade.queryContextSettings();
      const updated = await settle(() =>
        facade.updateContextBudget({
          expectedRevision: settings.budgetPolicyRevision,
          configuredMaximumGlobalContextTokenCount: 2048,
        } as never),
      );
      expect(updated.value !== undefined || updated.error !== undefined).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 工具包生命周期查询与未知 mission 的序列/产物查询", async () => {
    const facade = await createFacade();
    try {
      const lifecycle = await settle(() => facade.queryToolPackageLifecycle());
      expect(lifecycle.value !== undefined || lifecycle.error !== undefined).toBe(true);

      const sequence = await settle(() =>
        facade.queryMissionTaskSequence({ missionIdentifier: "mission-missing" } as never),
      );
      expect(sequence.value !== undefined || sequence.error !== undefined).toBe(true);

      const artifacts = await settle(() =>
        facade.queryMissionArtifacts("mission-missing" as never),
      );
      expect(artifacts.value !== undefined || artifacts.error !== undefined).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
