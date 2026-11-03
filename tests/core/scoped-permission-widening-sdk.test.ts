/**
 * GUI-04-01（2026-11-03）：门面层"放宽必须预览+确认"的强制。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function createApplication(authenticatedUserId?: string) {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-perm-sdk-"));
  directories.push(stateDirectory);
  return AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    ...(authenticatedUserId === undefined ? {} : { authenticatedUserId }),
  });
}

describe("放宽权限需要预览与确认", () => {
  it("直接放宽被拒；预览+确认后生效；再收紧可直接保存", async () => {
    const application = await createApplication("user-1");
    try {
      await application.updateScopedPermission({
        scope: "project",
        identifier: "project-a",
        expectedRevision: 1,
        permissionProfileId: null,
      });
      await expect(
        application.updateScopedPermission({
          scope: "project",
          identifier: "project-a",
          expectedRevision: 2,
          permissionProfileId: "devolve",
        }),
      ).rejects.toMatchObject({
        errorCode: "permission-widening-confirmation-required",
      });

      const preview = await application.previewScopedPermissionChange({
        scope: "project",
        identifier: "project-a",
        permissionProfileId: "devolve",
        expectedRevision: 2,
      });
      expect(preview.isWidening).toBe(true);

      const applied = await application.confirmScopedPermissionChange({
        previewIdentifier: preview.previewIdentifier,
        fingerprint: preview.fingerprint,
        expectedRevision: preview.expectedRevision,
      });
      expect(applied.projects["project-a"]?.permission?.permissionProfileId).toBe(
        "devolve",
      );

      const tightened = await application.updateScopedPermission({
        scope: "project",
        identifier: "project-a",
        expectedRevision: applied.revision,
        permissionProfileId: "assist",
      });
      expect(tightened.projects["project-a"]?.permission?.permissionProfileId).toBe(
        "assist",
      );
    } finally {
      await application.shutdown();
    }
  });

  it("未认证 ⇒ 拒绝写入", async () => {
    const application = await createApplication();
    try {
      await expect(
        application.updateScopedPermission({
          scope: "project",
          identifier: "project-a",
          expectedRevision: 1,
          permissionProfileId: null,
        }),
      ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    } finally {
      await application.shutdown();
    }
  });
});
