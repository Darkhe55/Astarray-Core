/**
 * GUI-03-02 / F06（2026-11-10）：**项目/会话上下文预算覆盖**的端到端行为。
 *
 * 卡内此前只验证了"设置面板与路由存在"，没有验证"写入后真的读得回、陈旧 revision 真的被拒"。
 * 本文件补上这一层（GUI 面板只是调用这些门面方法）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-scoped-context-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
  });
}

describe("GUI-03-02 作用域上下文预算覆盖", () => {
  it("默认无覆盖 ⇒ 写入后**读得回**，revision 递增", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryScopedSettings();
      expect(Object.keys(before.projects)).toHaveLength(0);

      const updated = await facade.updateScopedContextBudget({
        scope: "project",
        identifier: "project-alpha",
        expectedRevision: before.revision,
        configuredMaximumGlobalContextTokenCount: 120_000,
      });
      expect(updated.revision).toBeGreaterThan(before.revision);

      const readBack = await facade.queryScopedSettings();
      const projectEntry = readBack.projects["project-alpha"];
      expect(projectEntry?.context?.configuredMaximumGlobalContextTokenCount).toBe(120_000);
    } finally {
      await facade.shutdown();
    }
  }, 60_000);

  it("**陈旧 revision 被拒**（CAS：不得覆盖别人刚写的值）", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryScopedSettings();
      await facade.updateScopedContextBudget({
        scope: "project",
        identifier: "project-alpha",
        expectedRevision: before.revision,
        configuredMaximumGlobalContextTokenCount: 90_000,
      });
      await expect(
        facade.updateScopedContextBudget({
          scope: "project",
          identifier: "project-beta",
          expectedRevision: before.revision,
          configuredMaximumGlobalContextTokenCount: 80_000,
        }),
      ).rejects.toThrow(/revision|stale/iu);
    } finally {
      await facade.shutdown();
    }
  }, 60_000);

  it("会话作用域与项目作用域**互不覆盖**", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryScopedSettings();
      const afterProject = await facade.updateScopedContextBudget({
        scope: "project",
        identifier: "project-alpha",
        expectedRevision: before.revision,
        configuredMaximumGlobalContextTokenCount: 100_000,
      });
      await facade.updateScopedContextBudget({
        scope: "session",
        identifier: "session-1",
        expectedRevision: afterProject.revision,
        configuredMaximumGlobalContextTokenCount: 50_000,
      });
      const readBack = await facade.queryScopedSettings();
      expect(
        readBack.projects["project-alpha"]?.context?.configuredMaximumGlobalContextTokenCount,
      ).toBe(100_000);
      expect(
        readBack.sessions["session-1"]?.context?.configuredMaximumGlobalContextTokenCount,
      ).toBe(50_000);
    } finally {
      await facade.shutdown();
    }
  }, 60_000);
});
