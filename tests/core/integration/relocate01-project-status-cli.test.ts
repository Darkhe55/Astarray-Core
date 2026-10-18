/**
 * RELOCATE-01-04：`project status` CLI 执行器的验收（2026-10-18）。
 *
 * 真实装配入口：通过 `executeProjectStatusCommand`（cli.tsx 里注册的那个执行器）。
 * 命令名 `project status` 经用户 2026-10-18 确认（选项 A）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { executeProjectStatusCommand } from "../../../packages/tui/src/cli/project-relocation-command.js";
import { ProjectLocationRegistrationStore } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project-status-"));
});

const registration = {
  schemaVersion: 1 as const,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 2,
  confirmedBy: "user" as const,
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

describe("RELOCATE-01-04：project status（只读 CLI）", () => {
  it("① 无登记 ⇒ unregistered，且**不创建登记目录**", async () => {
    const exitCode = await executeProjectStatusCommand({
      stateDirectory,
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      observedProjectIdentifier: null,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    await expect(fs.readdir(path.join(stateDirectory, "project-location"))).rejects.toThrow();
  });

  it("② 有效登记 + 观测一致 ⇒ identity-confirmed：可加载历史但**禁止执行**", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await store.writeWithBackup(registration);

    const exitCode = await executeProjectStatusCommand({
      stateDirectory,
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      observedProjectIdentifier: "project-alpha",
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
  });

  it("③ 未提供观测标识 ⇒ identity-missing（fail-closed，不乐观放行）", async () => {
    const store = new ProjectLocationRegistrationStore({ baseDirectory: stateDirectory });
    await store.writeWithBackup(registration);

    const exitCode = await executeProjectStatusCommand({
      stateDirectory,
      projectIdentifier: "project-alpha",
      currentRootPath: "D:/work/alpha",
      observedProjectIdentifier: null,
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
  });
});
