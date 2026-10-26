/** GUI-03-05：工具包生命周期持久化。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ToolPackageLifecycleService } from "../../../packages/core/src/toolkit/tool-package-lifecycle-service.js";

const directories: string[] = [];
async function createService(): Promise<{ directory: string; service: ToolPackageLifecycleService }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-tool-lifecycle-"));
  directories.push(directory);
  return { directory, service: new ToolPackageLifecycleService({ baseDirectory: directory }) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function registration(version: number) {
  return {
    toolPackageId: "pkg",
    version,
    contentHash: "sha256:" + String(version).repeat(64),
    sourceProjectIdentifier: "project",
    declaredSideEffects: [],
    declaredDependencies: [],
    permissionRequirements: [],
  };
}

describe("工具包生命周期服务", () => {
  it("① 安装/锁定/启用/升级/回滚并持久化", async () => {
    const { directory, service } = await createService();
    await service.install(registration(1));
    await service.install(registration(2));
    const lock = await service.lock({
      projectIdentifier: "project",
      toolPackageId: "pkg",
      version: 1,
      contentHash: "sha256:" + "1".repeat(64),
    });
    expect(lock.isApplied).toBe(true);
    const enable = await service.enable({
      projectIdentifier: "project",
      toolPackageId: "pkg",
      version: 1,
    });
    expect(enable.isApplied).toBe(true);
    const upgrade = await service.upgrade({
      projectIdentifier: "project",
      toolPackageId: "pkg",
      targetVersion: 2,
      targetContentHash: "sha256:" + "2".repeat(64),
      isReauthorized: true,
    });
    expect(upgrade.isApplied).toBe(true);
    const reloaded = new ToolPackageLifecycleService({ baseDirectory: directory });
    const snapshot = await reloaded.list();
    expect(snapshot.versions).toHaveLength(2);
    expect(snapshot.locks[0]?.version).toBe(2);
    const rollback = await reloaded.rollback({
      projectIdentifier: "project",
      toolPackageId: "pkg",
      targetVersion: 1,
    });
    expect(rollback.isApplied).toBe(true);
  });
});
