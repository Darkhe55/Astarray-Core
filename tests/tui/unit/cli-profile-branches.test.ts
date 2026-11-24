/**
 * B9（2026-11-24）：`profile` 命令群分支（本地状态目录，无运行时）。
 *
 * 覆盖：列表（文本/JSON/分页/当前标记）、创建/切换/删除（当前组保护）、显示（内置/JSON/未选择）、
 * 导出（stdout/文件）、导入往返、改名/重置的"不存在"失败路径。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeProfileCreateCommand,
  executeProfileDeleteCommand,
  executeProfileExportCommand,
  executeProfileImportCommand,
  executeProfileListCommand,
  executeProfileRenameCommand,
  executeProfileResetCommand,
  executeProfileShowCommand,
  executeProfileSwitchCommand,
} from "../../../packages/tui/src/cli/commands.js";
import { EXIT_CODES } from "../../../packages/tui/src/cli/json-output.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-profile-"));
});

afterEach(async () => {
  process.exitCode = undefined;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function run<T>(action: () => Promise<T>): Promise<{ exitCode: T; output: string }> {
  const capture = captureStdout();
  try {
    const exitCode = await action();
    return { exitCode, output: capture.text() };
  } finally {
    capture.restore();
  }
}

function silenceStderr(): () => void {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => {
    process.stderr.write = original;
  };
}

let profileNameSequence = 0;
async function createProfile(source = "blank"): Promise<{ id: string; name: string }> {
  profileNameSequence += 1;
  const name = `测试组-${String(profileNameSequence)}`;
  const { output } = await run(() =>
    executeProfileCreateCommand({ stateDirectory, displayName: name, source }),
  );
  const match = /created (\S+)\t/u.exec(output);
  if (match === null) throw new Error(`创建失败: ${output}`);
  return { id: match[1]!, name };
}

describe("B9：profile 命令分支", () => {
  it("① 列表 JSON：三个内置组、无选择", async () => {
    const { exitCode, output } = await run(() =>
      executeProfileListCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(output) as {
      profiles: Array<{ permissionProfileId: string; isBuiltin: boolean }>;
      total: number;
      currentSelection: unknown;
    };
    expect(parsed.total).toBe(3);
    expect(parsed.currentSelection).toBeNull();
    expect(parsed.profiles.map((profile) => profile.permissionProfileId)).toEqual([
      "ponder",
      "assist",
      "devolve",
    ]);
  });

  it("② 列表分页：pageSize=2 且 page=2 返回最后一项", async () => {
    const { output } = await run(() =>
      executeProfileListCommand({ stateDirectory, page: 2, pageSize: 2 }),
    );
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(output).toContain("devolve");
  });

  it("③ 创建后切换 ⇒ 文本列表以 * 标记当前组", async () => {
    const { id: profileId } = await createProfile();
    await run(() =>
      executeProfileSwitchCommand({ stateDirectory, reference: `custom:${profileId}` }),
    );
    const { output } = await run(() =>
      executeProfileListCommand({ stateDirectory }),
    );
    const currentLine = output
      .split("\n")
      .find((line) => line.includes(profileId));
    expect(currentLine?.startsWith("*")).toBe(true);
  });

  it("④ 导出到 stdout 后再导入 ⇒ 往返成功（id 不同）", async () => {
    const { id: profileId } = await createProfile("assist");
    const exported = await run(() =>
      executeProfileExportCommand({
        stateDirectory,
        reference: `custom:${profileId}`,
        outputPath: null,
      }),
    );
    const exportedPath = path.join(stateDirectory, "exported-profile.json");
    const exportedDocument = JSON.parse(exported.output) as { displayName?: string };
    /** 导入要求名称唯一：改名为"导入组"再导入（导出/导入本身不改名）。 */
    exportedDocument.displayName = "导入组";
    await fs.writeFile(exportedPath, JSON.stringify(exportedDocument), "utf8");
    const imported = await run(() =>
      executeProfileImportCommand({ stateDirectory, inputPath: exportedPath }),
    );
    expect(imported.output).toMatch(/imported \S+\t/u);
  });

  it("⑤ 导出到文件：写文件并打印路径", async () => {
    const { id: profileId, name } = await createProfile();
    const outputPath = path.join(stateDirectory, "out", "profile.json");
    const { output } = await run(() =>
      executeProfileExportCommand({
        stateDirectory,
        reference: `custom:${profileId}`,
        outputPath,
      }),
    );
    expect(output).toContain("exported");
    const content = JSON.parse(await fs.readFile(outputPath, "utf8")) as { displayName?: string };
    expect(content.displayName).toBe(name);
  });

  it("⑥ 删除当前使用组 ⇒ 拒绝（exit 2）；删除非当前组 ⇒ 成功", async () => {
    const { id: first } = await createProfile();
    const { id: second } = await createProfile();
    await run(() =>
      executeProfileSwitchCommand({ stateDirectory, reference: `custom:${first}` }),
    );
    const restoreStderr = silenceStderr();
    try {
      await expect(
        executeProfileDeleteCommand({ stateDirectory, permissionProfileId: first }),
      ).rejects.toThrow(/不能直接删除/u);
    } finally {
      restoreStderr();
    }
    expect(process.exitCode).toBe(EXIT_CODES.USAGE_ERROR);
    process.exitCode = undefined;
    const { output } = await run(() =>
      executeProfileDeleteCommand({ stateDirectory, permissionProfileId: second }),
    );
    expect(output).toContain("deleted");
  });

  it("⑦ show：未选择 ⇒ 拒绝；指定内置组 JSON ⇒ 公开字段", async () => {
    const restoreStderr = silenceStderr();
    try {
      await expect(
        executeProfileShowCommand({ stateDirectory, reference: null, isJsonOutput: true }),
      ).rejects.toThrow(/未选择权限组/u);
    } finally {
      restoreStderr();
    }
    process.exitCode = undefined;
    const { output } = await run(() =>
      executeProfileShowCommand({ stateDirectory, reference: "assist", isJsonOutput: true }),
    );
    const parsed = JSON.parse(output) as { permissionProfileId: string; isBuiltin: boolean };
    expect(parsed.permissionProfileId).toBe("assist");
    expect(parsed.isBuiltin).toBe(true);
  });

  it("⑧ 改名/重置不存在组 ⇒ 失败路径（exit 2）", async () => {
    const restoreStderr = silenceStderr();
    try {
      await expect(
        executeProfileRenameCommand({
          stateDirectory,
          permissionProfileId: "missing",
          newDisplayName: "新名字",
        }),
      ).rejects.toThrow(/不存在/u);
      process.exitCode = undefined;
      await expect(
        executeProfileResetCommand({ stateDirectory, permissionProfileId: "missing", source: "blank" }),
      ).rejects.toThrow(/不存在/u);
    } finally {
      restoreStderr();
    }
  });
});
