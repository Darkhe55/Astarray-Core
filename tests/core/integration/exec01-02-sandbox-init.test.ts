/**
 * EXEC-01-02（2026-11-09）：**安装期一次性初始化**入口的拒绝路径。
 *
 * 用户裁决的约束：明确用户确认、每用户档案、运行期非管理员、**客户端整体不提权**。
 * 因此初始化入口必须：
 *  - 没有显式确认 ⇒ **拒绝**（不静默建档案）；
 *  - 有确认但当前进程无权限 ⇒ 如实失败并给出指引（**不声称成功**）。
 *
 * 本文件只在**辅助程序已构建**时运行；未构建则跳过（不伪造通过）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

/** RELIABILITY-01：本文件真的起子进程 ⇒ 显式预算。 */
vi.setConfig({ testTimeout: 30_000 });

const HELPER_PATH = path.join(
  process.cwd(),
  "native",
  "sandbox-helper",
  process.platform === "win32" ? "sandbox-helper.exe" : "sandbox-helper",
);

const isHelperAvailable = existsSync(HELPER_PATH);

describe.skipIf(!isHelperAvailable)("EXEC-01-02 安装期初始化入口", () => {
  it("没有 --confirm-create-profile ⇒ 拒绝执行（退出码 2，且明确说明原因）", () => {
    const result = spawnSync(HELPER_PATH, ["init-sandbox"], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("显式确认");
    /** 拒绝时不得出现任何"已创建"字样。 */
    expect(result.stdout).not.toContain("profile-created");
  }, 30_000);

  it("有确认但无创建权限 ⇒ 如实失败（非 0，且不声称成功）", () => {
    const result = spawnSync(HELPER_PATH, ["init-sandbox", "--confirm-create-profile"], {
      encoding: "utf8",
    });
    /**
     * 已提权环境里这一步会成功；未提权则必须失败。
     * 两种结果都合法，但**不允许**"失败却报成功"。
     */
    if (result.status === 0) {
      expect(result.stdout).toContain("profile-created");
      expect(result.stdout).toContain("derive-ok");
      return;
    }
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("profile-created");
    expect(result.stderr).toMatch(/0x80070005|权限/u);
  }, 30_000);

  it("探测在本机如实报告不可用（AppContainer 档案建不了）", () => {
    const result = spawnSync(HELPER_PATH, ["probe"], { encoding: "utf8" });
    /** 探测失败必须是**非 0**，不能"探测失败但退出 0"。 */
    if (result.stdout.includes("appcontainer-unavailable")) {
      expect(result.status).not.toBe(0);
    }
  }, 30_000);
});
