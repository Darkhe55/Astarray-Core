/**
 * B3/B6 前置检查脚本的平台分支（2026-11-24）。
 *
 * 用 `--probes <json>` 注入确定性探测值，验证：
 * - Windows：helper/rustc/提权三项缺一即 blocked；齐全才 ready；
 * - Linux：只查 bwrap 与用户命名空间，**不**要求 .exe；
 * - macOS：平台未交付 ⇒ blocked；
 * - `--strict` 未就绪 ⇒ exit 2。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scriptPath = path.join(repositoryRoot, "scripts", "verify-exec01-03-preconditions.mjs");

function runScript(probes: Record<string, unknown>, extraArguments: readonly string[] = []) {
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--probes", JSON.stringify(probes), ...extraArguments],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseRecord(stdout: string) {
  return JSON.parse(stdout) as {
    platform: string;
    items: Array<{ itemIdentifier: string; status: string }>;
    readyForAcceptance: boolean;
    blockers: string[];
  };
}

describe("B3/B6：验收前置检查的平台分支", () => {
  it("① Windows 缺 helper/rustc/提权 ⇒ 三项 blocked，不可验收", () => {
    const { status, stdout } = runScript({
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v26.13.1",
      helperExists: false,
      rustcVersion: null,
      cargoVersion: null,
      elevated: false,
    });
    expect(status).toBe(0);
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(false);
    expect(record.items.map((item) => item.itemIdentifier)).toEqual([
      "platform-supported",
      "node-version-supported",
      "sandbox-helper-built",
      "rust-toolchain",
      "elevated-for-appcontainer",
    ]);
    expect(record.items.filter((item) => item.status === "blocked")).toHaveLength(3);
  });

  it("② Windows 三项齐全 ⇒ readyForAcceptance=true，--strict exit 0", () => {
    const probes = {
      platform: "win32",
      architecture: "x64",
      nodeVersion: "v26.13.1",
      helperExists: true,
      rustcVersion: "rustc 1.83.0",
      cargoVersion: "cargo 1.83.0",
      elevated: true,
    };
    const { status, stdout } = runScript(probes, ["--strict"]);
    expect(status).toBe(0);
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(true);
    expect(record.blockers).toEqual([]);
  });

  it("③ Linux：bwrap 与用户命名空间齐全 ⇒ ready；不要求 .exe", () => {
    const { status, stdout } = runScript({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "v22.11.0",
      bwrapVersion: "bubblewrap 0.8.0",
      isUserNamespaceUsable: true,
    });
    expect(status).toBe(0);
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(true);
    expect(record.items.map((item) => item.itemIdentifier)).toEqual([
      "platform-supported",
      "node-version-supported",
      "bubblewrap-installed",
      "bubblewrap-user-namespace",
    ]);
    expect(record.items.some((item) => item.itemIdentifier === "sandbox-helper-built")).toBe(false);
  });

  it("④ Linux 缺 bwrap ⇒ blocked 且 --strict exit 2", () => {
    const { status, stdout, stderr } = runScript(
      {
        platform: "linux",
        architecture: "x64",
        nodeVersion: "v22.11.0",
        bwrapVersion: null,
        isUserNamespaceUsable: false,
      },
      ["--strict"],
    );
    expect(status).toBe(2);
    expect(stderr).toContain("未就绪");
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(false);
    expect(record.items.filter((item) => item.status === "blocked").map((item) => item.itemIdentifier)).toEqual([
      "bubblewrap-installed",
      "bubblewrap-user-namespace",
    ]);
  });

  it("⑤ macOS ⇒ 平台未交付后端（blocked），不冒充可用", () => {
    const { status, stdout } = runScript({
      platform: "darwin",
      architecture: "arm64",
      nodeVersion: "v22.11.0",
    });
    expect(status).toBe(0);
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(false);
    expect(record.items[0]).toMatchObject({ itemIdentifier: "platform-supported", status: "blocked" });
  });

  it("⑥ Node 低于 20 ⇒ node-version-supported blocked", () => {
    const { status, stdout } = runScript({
      platform: "linux",
      architecture: "x64",
      nodeVersion: "v18.20.0",
      bwrapVersion: "bubblewrap 0.8.0",
      isUserNamespaceUsable: true,
    });
    expect(status).toBe(0);
    const record = parseRecord(stdout);
    expect(record.readyForAcceptance).toBe(false);
    expect(record.items.find((item) => item.itemIdentifier === "node-version-supported")?.status).toBe(
      "blocked",
    );
  });
});
