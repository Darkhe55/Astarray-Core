/**
 * GUI-03 F01（2026-11-03）：通知偏好服务端存储的单测。
 *
 * 覆盖：默认值、写入/读回、revision 冲突、非法字段、损坏文件、跨用户/项目隔离。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferenceStore,
} from "../../packages/core/src/orchestration/notification-preference-store.js";

let directory: string;
let store: NotificationPreferenceStore;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-notify-pref-"));
  store = new NotificationPreferenceStore({ baseDirectory: directory });
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
});

const base = { userId: "user-1", projectIdentifier: "project-a" };

describe("通知偏好存储", () => {
  it("未配置 ⇒ 返回默认值（不创建文件）", async () => {
    const result = await store.read(base);
    expect(result.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(result.revision).toBe(0);
    await expect(
      fs.stat(path.join(directory, "settings", "notification-preferences.json")),
    ).rejects.toThrow();
  });

  it("写入后读回，revision 递增；文件含 updatedBy", async () => {
    const updated = await store.update({
      ...base,
      preferences: { complete: false, failure: true, pending: false, system: true },
      updatedByUserId: "user-1",
    });
    expect(updated.revision).toBe(1);
    const readBack = await store.read(base);
    expect(readBack.preferences).toEqual({
      complete: false,
      failure: true,
      pending: false,
      system: true,
    });
    expect(readBack.revision).toBe(1);
    const raw = JSON.parse(
      await fs.readFile(
        path.join(directory, "settings", "notification-preferences.json"),
        "utf8",
      ),
    ) as { records: Array<{ updatedByUserId: string }> };
    expect(raw.records[0]?.updatedByUserId).toBe("user-1");
  });

  it("expectedRevision 陈旧 ⇒ 拒绝且不改动", async () => {
    await store.update({
      ...base,
      preferences: { complete: true, failure: false, pending: true, system: false },
      updatedByUserId: "user-1",
    });
    await expect(
      store.update({
        ...base,
        preferences: { complete: false, failure: false, pending: false, system: false },
        expectedRevision: 0,
        updatedByUserId: "user-1",
      }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    const readBack = await store.read(base);
    expect(readBack.preferences.complete).toBe(true);
    expect(readBack.revision).toBe(1);
  });

  it("未知字段 / 非布尔值 ⇒ 拒绝", async () => {
    await expect(
      store.update({
        ...base,
        preferences: { complete: true, failure: true, pending: true, system: false, extra: true },
        updatedByUserId: "user-1",
      }),
    ).rejects.toThrow(/未知字段/);
    await expect(
      store.update({
        ...base,
        preferences: { complete: "yes", failure: true, pending: true, system: false },
        updatedByUserId: "user-1",
      }),
    ).rejects.toThrow(/布尔值/);
  });

  it("损坏文件 ⇒ 回退默认值（不抛错）", async () => {
    await fs.mkdir(path.join(directory, "settings"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "settings", "notification-preferences.json"),
      "{ not json",
      "utf8",
    );
    const result = await store.read(base);
    expect(result.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(result.revision).toBe(0);
  });

  it("不同用户/项目互不影响", async () => {
    await store.update({
      userId: "user-1",
      projectIdentifier: "project-a",
      preferences: { complete: false, failure: false, pending: false, system: false },
      updatedByUserId: "user-1",
    });
    const otherProject = await store.read({ userId: "user-1", projectIdentifier: "project-b" });
    const otherUser = await store.read({ userId: "user-2", projectIdentifier: "project-a" });
    expect(otherProject.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(otherUser.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});
