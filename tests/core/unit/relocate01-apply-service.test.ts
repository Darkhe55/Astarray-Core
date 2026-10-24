/**
 * RELOCATE-01-03 控制面重定位服务反例（2026-10-24）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectLocationRegistrationStore } from "../../../packages/core/src/orchestration/project-location-registration-store.js";
import { relocateProjectRegistration } from "../../../packages/core/src/orchestration/project-relocation-service.js";

const temporaryDirectories: string[] = [];
async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-relocate-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seedRegistration(store: ProjectLocationRegistrationStore, rootPath: string) {
  await store.writeWithBackup({
    schemaVersion: 1,
    projectIdentifier: "project-1",
    deviceIdentifier: "device-1",
    rootPath,
    previousRootPath: null,
    locationRevision: 1,
    confirmedBy: "user",
    confirmedAtIso: "2026-10-24T00:00:00.000Z",
  });
}

function baseInput(store: ProjectLocationRegistrationStore, newRootPath: string) {
  return {
    store,
    projectIdentifier: "project-1",
    newRootPath,
    observedProjectIdentifierAtNewRoot: "project-1",
    isNewRootAccessible: true,
    expectedLocationRevision: 1,
    isHumanConfirmed: true,
    confirmedAtIso: "2026-10-24T01:00:00.000Z",
  };
}

describe("RELOCATE-01 控制面重定位", () => {
  it("① 用户确认 + 身份一致 ⇒ 写入新根、保留旧根、revision+1", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await seedRegistration(store, "D:/project-a");

    const result = await relocateProjectRegistration(baseInput(store, "E:/project-a"));
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") return;
    expect(result.registration.rootPath).toBe("E:/project-a");
    expect(result.registration.previousRootPath).toBe("D:/project-a");
    expect(result.registration.locationRevision).toBe(2);
    expect(result.registration.confirmedBy).toBe("user");

    const persisted = await store.read("project-1");
    expect(persisted.kind).toBe("valid");
    if (persisted.kind === "valid") {
      expect(persisted.registration.rootPath).toBe("E:/project-a");
      expect(persisted.registration.locationRevision).toBe(2);
    }
  });

  it("② 非用户确认 ⇒ 拒绝（模型/自动流程不得代签）", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await seedRegistration(store, "D:/project-a");
    const result = await relocateProjectRegistration({
      ...baseInput(store, "E:/project-a"),
      isHumanConfirmed: false,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reasonCode).toBe("not-human-confirmed");
  });

  it("③ 新根不可达 / 身份不符 ⇒ 拒绝且不写登记", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await seedRegistration(store, "D:/project-a");

    const unreachable = await relocateProjectRegistration({
      ...baseInput(store, "E:/project-a"),
      isNewRootAccessible: false,
    });
    expect(unreachable.kind).toBe("rejected");

    const mismatch = await relocateProjectRegistration({
      ...baseInput(store, "E:/project-a"),
      observedProjectIdentifierAtNewRoot: "someone-else",
    });
    expect(mismatch.kind).toBe("rejected");
    const persisted = await store.read("project-1");
    if (persisted.kind === "valid") {
      expect(persisted.registration.rootPath).toBe("D:/project-a");
      expect(persisted.registration.locationRevision).toBe(1);
    }
  });

  it("④ 陈旧 revision / 相同根 ⇒ 拒绝", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await seedRegistration(store, "D:/project-a");

    const stale = await relocateProjectRegistration({
      ...baseInput(store, "E:/project-a"),
      expectedLocationRevision: 0,
    });
    expect(stale.kind).toBe("rejected");
    if (stale.kind === "rejected") expect(stale.reasonCode).toBe("stale-location-revision");

    const same = await relocateProjectRegistration(baseInput(store, "D:/project-a"));
    expect(same.kind).toBe("rejected");
    if (same.kind === "rejected") expect(same.reasonCode).toBe("same-root");
  });

  it("⑤ 未登记 ⇒ 拒绝（不自动建立登记）", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    const result = await relocateProjectRegistration(baseInput(store, "E:/project-a"));
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") expect(result.reasonCode).toBe("not-registered");
  });
});
