/**
 * GUI-04-01（2026-11-03）：权限放宽预览/确认的单测。
 *
 * 直接构造 profile/scoped store：收紧不要求预览、放宽需要；指纹/过期/主体不符拒绝；
 * 重复确认幂等。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PermissionProfileStore } from "../../packages/core/src/tools/permission-profile-store.js";
import { ScopedSettingsStore } from "../../packages/core/src/orchestration/scoped-settings-store.js";
import { ScopedPermissionChangeService } from "../../packages/core/src/orchestration/scoped-permission-change-service.js";

let directory: string;
let profileStore: PermissionProfileStore;
let scopedStore: ScopedSettingsStore;
let nowMilliseconds: number;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "astarray-perm-preview-"));
  profileStore = new PermissionProfileStore({ baseDirectory: directory });
  scopedStore = new ScopedSettingsStore({ baseDirectory: directory });
  nowMilliseconds = Date.parse("2026-11-03T00:00:00.000Z");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

function createService(ttlMilliseconds = 60_000): ScopedPermissionChangeService {
  return new ScopedPermissionChangeService({
    profileStore,
    scopedStore,
    nowMilliseconds: () => nowMilliseconds,
    previewTtlMilliseconds: ttlMilliseconds,
  });
}

const previewInput = {
  scope: "project" as const,
  identifier: "project-a",
  expectedRevision: 1,
  subjectIdentifier: "user-1",
};

describe("权限放宽预览", () => {
  it("assist → devolve 为放宽；devolve → assist 为收紧", async () => {
    const service = createService();
    const widening = await service.preview({
      ...previewInput,
      permissionProfileId: "devolve",
      currentProfileReference: { kind: "builtin", profileId: "assist" },
    });
    expect(widening.isWidening).toBe(true);
    expect(widening.changes.length).toBeGreaterThan(0);

    const tightening = await service.preview({
      ...previewInput,
      permissionProfileId: "assist",
      currentProfileReference: { kind: "builtin", profileId: "devolve" },
    });
    expect(tightening.isWidening).toBe(false);
  });

  it("确认应用；重复确认幂等；指纹/到期/主体不符拒绝", async () => {
    const service = createService(60_000);
    const preview = await service.preview({
      ...previewInput,
      permissionProfileId: "devolve",
      currentProfileReference: { kind: "builtin", profileId: "assist" },
    });

    await expect(
      service.confirm({
        previewIdentifier: preview.previewIdentifier,
        fingerprint: "wrong",
        expectedRevision: preview.expectedRevision,
        subjectIdentifier: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "permission-preview-stale" });

    await expect(
      service.confirm({
        previewIdentifier: preview.previewIdentifier,
        fingerprint: preview.fingerprint,
        expectedRevision: preview.expectedRevision,
        subjectIdentifier: "user-2",
      }),
    ).rejects.toMatchObject({ errorCode: "permission-preview-stale" });

    const applied = await service.confirm({
      previewIdentifier: preview.previewIdentifier,
      fingerprint: preview.fingerprint,
      expectedRevision: preview.expectedRevision,
      subjectIdentifier: "user-1",
    });
    expect(applied.revision).toBe(2);
    expect(applied.projects["project-a"]?.permission?.permissionProfileId).toBe(
      "devolve",
    );

    const repeated = await service.confirm({
      previewIdentifier: preview.previewIdentifier,
      fingerprint: preview.fingerprint,
      expectedRevision: preview.expectedRevision,
      subjectIdentifier: "user-1",
    });
    expect(repeated.revision).toBe(2);
  });

  it("过期预览拒绝确认", async () => {
    const service = createService(1_000);
    const preview = await service.preview({
      ...previewInput,
      permissionProfileId: "devolve",
      currentProfileReference: { kind: "builtin", profileId: "assist" },
    });
    nowMilliseconds += 2_000;
    await expect(
      service.confirm({
        previewIdentifier: preview.previewIdentifier,
        fingerprint: preview.fingerprint,
        expectedRevision: preview.expectedRevision,
        subjectIdentifier: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "permission-preview-expired" });
  });

  it("未知预览拒绝；空主体拒绝预览", async () => {
    const service = createService();
    await expect(
      service.confirm({
        previewIdentifier: "missing",
        fingerprint: "f",
        expectedRevision: 1,
        subjectIdentifier: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "permission-preview-not-found" });
    await expect(
      service.preview({
        ...previewInput,
        permissionProfileId: "assist",
        currentProfileReference: null,
        subjectIdentifier: "  ",
      }),
    ).rejects.toThrow();
  });
});
