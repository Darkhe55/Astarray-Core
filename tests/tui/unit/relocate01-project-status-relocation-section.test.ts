/**
 * `project status --json` 的 `relocation` 可选段（RELOCATE-01-04 余项，2026-10-19 R36）。
 *
 * 用户 2026-10-19 决策（按推荐）：`relocation` 段**可选**，只在**存在重定位状态**时出现，
 * 其余情况保持既有输出结构不变（向后兼容）。
 *
 * 本文件先在实现前失败：现状 `project status --json` **没有** `relocation` 段。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeProjectStatusCommand } from "../../../packages/tui/src/cli/project-relocation-command.js";

let stateDirectory: string;
let projectRootPath: string;
let stdoutText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project-status-"));
  projectRootPath = path.join(stateDirectory, "project-root");
  await fs.mkdir(projectRootPath, { recursive: true });
  stdoutText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 写一份"旧格式"登记（无 schemaVersion ⇒ store 判为 legacy）。 */
async function writeLegacyRegistration(): Promise<void> {
  const directoryPath = path.join(stateDirectory, "project-location");
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, "project-a.json"),
    JSON.stringify({ projectIdentifier: "project-a", rootPath: path.join(stateDirectory, "old-root") }),
    "utf8",
  );
}

/** 写一份有效登记（schemaVersion 1），且当前根与登记根一致。 */
async function writeValidRegistration(): Promise<void> {
  const directoryPath = path.join(stateDirectory, "project-location");
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(
    path.join(directoryPath, "project-a.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectIdentifier: "project-a",
      deviceIdentifier: "device-1",
      rootPath: projectRootPath,
      previousRootPath: null,
      locationRevision: 1,
      confirmedBy: "user",
      confirmedAtIso: "2026-10-19T00:00:00.000Z",
    }),
    "utf8",
  );
}

async function runStatus(): Promise<Record<string, unknown>> {
  stdoutText = "";
  const exitCode = await executeProjectStatusCommand({
    stateDirectory,
    projectIdentifier: "project-a",
    currentRootPath: projectRootPath,
    observedProjectIdentifier: "project-a",
    isJsonOutput: true,
  });
  expect(exitCode).toBe(0);
  return JSON.parse(stdoutText) as Record<string, unknown>;
}

describe("project status --json：relocation 可选段", () => {
  it("① 存在旧格式登记（重定位状态）⇒ 出现 relocation 段且含对账入口提示", async () => {
    await writeLegacyRegistration();
    const payload = await runStatus();
    expect(payload["registrationReadKind"]).toBe("legacy");
    const relocation = payload["relocation"] as Record<string, unknown> | undefined;
    expect(relocation, "legacy 登记必须带 relocation 段").toBeDefined();
    expect(relocation?.["registrationReadKind"]).toBe("legacy");
    expect(typeof relocation?.["classification"]).toBe("string");
    expect(typeof relocation?.["isHistoryLoadable"]).toBe("boolean");
    expect(relocation?.["isExecutionAllowed"]).toBe(false);
    expect(String(relocation?.["requiredUserAction"]).length).toBeGreaterThan(0);
    expect(String(relocation?.["reconcileCommandHint"])).toContain("project reconcile");
  });

  it("② 有效登记且身份一致 ⇒**不出现** relocation 段（向后兼容）", async () => {
    await writeValidRegistration();
    const payload = await runStatus();
    expect(payload["registrationReadKind"]).toBe("valid");
    expect(payload["relocation"]).toBeUndefined();
    // 既有字段保持原样
    expect(payload["projectIdentifier"]).toBe("project-a");
    expect(payload["classification"]).toBe("identity-confirmed");
  });

  it("③ 无登记 ⇒ 不出现 relocation 段", async () => {
    const payload = await runStatus();
    expect(payload["registrationReadKind"]).toBe("absent");
    expect(payload["relocation"]).toBeUndefined();
  });
});

