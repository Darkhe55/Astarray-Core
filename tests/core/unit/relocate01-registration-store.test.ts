/**
 * RELOCATE-01：登记存储的**反例**（2026-10-18 第 18 轮）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectLocationRegistrationStore } from "../../../packages/core/src/orchestration/project-location-registration-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-relocate-store-"));
});

afterEach(() => {
  // 不删临时目录：避免与后台写盘竞态（§14.3 教训）。
  void baseDirectory;
});

const registration = {
  schemaVersion: 1 as const,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 3,
  confirmedBy: "user" as const,
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

describe("RELOCATE-01：登记存储", () => {
  it("① 无文件 ⇒ absent（不当作空登记）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    const outcome = await store.read("project-alpha");
    expect(outcome.kind).toBe("absent");
  });

  it("② 写入后读回 ⇒ valid，字段一致", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    await store.writeWithBackup(registration);
    const outcome = await store.read("project-alpha");
    expect(outcome.kind).toBe("valid");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    expect(outcome.registration.locationRevision).toBe(3);
    expect(outcome.registration.rootPath).toBe("D:/work/alpha");
  });

  it("③ 覆盖写 ⇒ **旧版本留下备份文件**（可回滚）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    await store.writeWithBackup(registration);
    await store.writeWithBackup({ ...registration, rootPath: "E:/moved", locationRevision: 4 });

    const backupDirectory = path.join(baseDirectory, "project-location-backups");
    const backupFiles = await fs.readdir(backupDirectory);
    expect(backupFiles).toContain("project-alpha.backup-r3.json");

    const outcome = await store.read("project-alpha");
    expect(outcome.kind).toBe("valid");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    expect(outcome.registration.locationRevision).toBe(4);
  });

  it("④ 登记文件是坏 JSON ⇒ invalid（不伪称成功）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    const directory = path.join(baseDirectory, "project-location");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "project-alpha.json"), "{not-json", "utf8");

    const outcome = await store.read("project-alpha");
    expect(outcome.kind).toBe("invalid");
  });

  it("⑤ 旧格式登记（无 schemaVersion）⇒ legacy（不自动升级）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory });
    const directory = path.join(baseDirectory, "project-location");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "project-alpha.json"),
      JSON.stringify({ projectIdentifier: "project-alpha", rootPath: "D:/work/alpha" }),
      "utf8",
    );

    const outcome = await store.read("project-alpha");
    expect(outcome.kind).toBe("legacy");
  });
});
