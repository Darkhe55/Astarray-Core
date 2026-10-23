/**
 * RELOCATE-01 `project entry` 反例（2026-10-23）。
 *
 * 未登记 ⇒ 退出码 3（阻断）；登记且根一致 ⇒ 退出码 0（信息级，仍提示不自动重跑）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeProjectEntryCommand } from "../../../packages/tui/src/cli/project-relocation-command.js";
import { ProjectLocationRegistrationStore } from "../../../packages/core/src/orchestration/project-location-registration-store.js";

const temporaryDirectories: string[] = [];

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-project-entry-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("RELOCATE-01 project entry", () => {
  it("① 未登记 ⇒ 阻断（退出码 3），提示需要建立登记", async () => {
    const stateDirectory = await createStateDirectory();
    const exitCode = await executeProjectEntryCommand({
      stateDirectory,
      projectIdentifier: "project-1",
      currentRootPath: stateDirectory,
      observedProjectIdentifier: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(3);
  });

  it("② 登记一致 ⇒ 退出码 0（仍提示，不自动重跑）", async () => {
    const stateDirectory = await createStateDirectory();
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await store.writeWithBackup({
      schemaVersion: 1,
      projectIdentifier: "project-1",
      deviceIdentifier: "device-1",
      rootPath: stateDirectory,
      previousRootPath: null,
      locationRevision: 1,
      confirmedBy: "user",
      confirmedAtIso: "2026-10-23T00:00:00.000Z",
    });
    const exitCode = await executeProjectEntryCommand({
      stateDirectory,
      projectIdentifier: "project-1",
      currentRootPath: stateDirectory,
      observedProjectIdentifier: "project-1",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
  });
  it("③ 未登记且不给选择 ⇒ 退出码 3（只展示三个选项）", async () => {
    const stateDirectory = await createStateDirectory();
    const exitCode = await executeProjectEntryCommand({
      stateDirectory,
      projectIdentifier: "project-1",
      currentRootPath: stateDirectory,
      observedProjectIdentifier: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(3);
  });

  it("④ 三选项退出码：exit=0 / view-history-only=4 / relocate=5 / unknown=2", async () => {
    const stateDirectory = await createStateDirectory();
    const base = {
      stateDirectory,
      projectIdentifier: "project-1",
      currentRootPath: stateDirectory,
      observedProjectIdentifier: null,
      isJsonOutput: true,
    };
    expect(await executeProjectEntryCommand({ ...base, choice: "exit" })).toBe(0);
    expect(await executeProjectEntryCommand({ ...base, choice: "view-history-only" })).toBe(4);
    expect(await executeProjectEntryCommand({ ...base, choice: "relocate" })).toBe(5);
    expect(await executeProjectEntryCommand({ ...base, choice: "unknown" })).toBe(2);
  });
});
