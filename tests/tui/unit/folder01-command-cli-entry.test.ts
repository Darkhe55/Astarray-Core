/**
 * FOLDER-01-03 CLI 的 **argv 级反例**（2026-10-18 R15）：真实 `dist/cli.js` 子进程。
 *
 * 钉住用户实际会用的界面：`astarray folder request|approve|revoke|check`，
 * 以及"未批准零新增权限""撤销后拒绝""用法错误 exit 2"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
const cliEntryPath = path.join(repositoryRoot, "dist", "cli.js");

let workingDirectory: string;

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdoutText: string; stderrText: string }> {
  const childProcess = spawn(process.execPath, [cliEntryPath, ...args], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  let stdoutText = "";
  let stderrText = "";
  childProcess.stdout.setEncoding("utf8");
  childProcess.stderr.setEncoding("utf8");
  childProcess.stdout.on("data", (chunk: string) => (stdoutText += chunk));
  childProcess.stderr.on("data", (chunk: string) => (stderrText += chunk));
  const exitCode = await new Promise<number>((resolve) => {
    childProcess.on("close", (code: number | null) => resolve(code ?? 1));
  });
  return { exitCode, stdoutText, stderrText };
}

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-folder01-cli-"));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("FOLDER-01-03：folder CLI 入口（argv 级）", () => {
  it("① request：只出卡片、exit 0，且不创建授权集合文件", async () => {
    const outcome = await runCli([
      "folder",
      "request",
      "--project",
      "project-a",
      "--path",
      "D:/Assets/Shared",
      "--permission",
      "read-only",
      "--include-subdirectories",
      "--json",
    ]);
    expect(outcome.exitCode).toBe(0);
    const payload = JSON.parse(outcome.stdoutText) as {
      cards: Array<{ classification: string; card: { displayAbsolutePath: string; isBatch: boolean } }>;
    };
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0]?.classification).toBe("acceptable");
    expect(payload.cards[0]?.card.displayAbsolutePath).toBe("D:/Assets/Shared");
    expect(payload.cards[0]?.card.isBatch).toBe(false);
    await expect(
      fs.readFile(path.join(workingDirectory, ".astarray", "folder-grants", "project-a.json")),
    ).rejects.toThrow();
  });

  it("② approve → check 允许 → revoke → check 拒绝（完整闭环）", async () => {
    expect(
      (
        await runCli([
          "folder",
          "approve",
          "--project",
          "project-a",
          "--path",
          "D:/Assets/Shared",
          "--permission",
          "read-only",
          "--include-subdirectories",
          "--grant-id",
          "grant-1",
          "--revision",
          "1",
          "--json",
        ])
      ).exitCode,
    ).toBe(0);

    const allowed = await runCli([
      "folder",
      "check",
      "--project",
      "project-a",
      "--path",
      "D:/Assets/Shared/file.txt",
      "--permission",
      "read-only",
      "--revision",
      "1",
      "--json",
    ]);
    expect(allowed.exitCode).toBe(0);
    expect(JSON.parse(allowed.stdoutText)).toMatchObject({ outcome: "allowed" });

    expect(
      (
        await runCli([
          "folder",
          "revoke",
          "--project",
          "project-a",
          "--grant-id",
          "grant-1",
          "--reason",
          "用户撤销",
          "--json",
        ])
      ).exitCode,
    ).toBe(0);

    const denied = await runCli([
      "folder",
      "check",
      "--project",
      "project-a",
      "--path",
      "D:/Assets/Shared/file.txt",
      "--permission",
      "read-only",
      "--revision",
      "1",
      "--json",
    ]);
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdoutText)).toMatchObject({ outcome: "denied" });
  });

  it("③ 未批准 ⇒ check 拒绝（exit 1，不得显示成功）", async () => {
    const denied = await runCli([
      "folder",
      "check",
      "--project",
      "project-a",
      "--path",
      "D:/Assets/Shared/file.txt",
      "--permission",
      "read-only",
      "--revision",
      "1",
      "--json",
    ]);
    expect(denied.exitCode).toBe(1);
    expect(JSON.parse(denied.stdoutText)).toMatchObject({ outcome: "denied", reasonCode: "no-grant" });
  });

  it("④ 用法错误：未知 --permission ⇒ exit 2；相对路径 request ⇒ exit 1", async () => {
    const badPermission = await runCli([
      "folder",
      "request",
      "--project",
      "project-a",
      "--path",
      "D:/Assets/Shared",
      "--permission",
      "full-access",
      "--json",
    ]);
    expect(badPermission.exitCode).toBe(2);

    const relativePath = await runCli([
      "folder",
      "request",
      "--project",
      "project-a",
      "--path",
      "Assets/Shared",
      "--json",
    ]);
    expect(relativePath.exitCode).toBe(1);
  });
});
