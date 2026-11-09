/**
 * HISTORY-01 / OBS-01（2026-11-10）：**历史查询不得因"运行态观测失败"而整体失败**。
 *
 * 真实缺陷（本会话实测捕获，约 1/70）：`queryMissionHistory` 的
 * `isMissionActivelyRunning` 端口读 mission 租约；租约文件在写入瞬间可能不可解析
 * （原子写 temp→rename 的窗口），`MissionLeaseStore` 抛 `journal-corrupted`，
 * 于是**整页历史查询失败**。
 *
 * 语义边界：历史是**只读观测**；"无法确认在运行"必须等价于"不显示为运行中"
 * （既有规则：重启后不得显示为运行中），而不是让观测面崩掉。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryMissionHistory } from "../../../packages/core/src/gui/mission-history-reader.js";

vi.setConfig({ testTimeout: 30_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-history-lease-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function writeMissionSummary(missionIdentifier: string): Promise<void> {
  const missionDirectoryPath = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectoryPath, { recursive: true });
  await fs.writeFile(
    path.join(missionDirectoryPath, "summary.json"),
    JSON.stringify({
      schemaVersion: 1,
      missionId: missionIdentifier,
      mode: "assist",
      prompt: "任务",
      createdAtIso: "2026-11-10T00:00:00.000Z",
      status: "running",
    }),
    "utf8",
  );
}

describe("历史查询对运行态观测失败的容错", () => {
  it("**租约读取抛错** ⇒ 查询仍成功，该 mission 不显示为运行中", async () => {
    await writeMissionSummary("mission-lease-broken");
    const page = await queryMissionHistory({
      stateDirectory,
      isMissionActivelyRunning: () => {
        throw new Error("mission 租约文件损坏，拒绝读取/覆盖");
      },
    });
    expect(page.entries).toHaveLength(1);
    const entry = page.entries[0];
    expect(entry?.isActivelyRunning).toBe(false);
    expect(entry?.runtimeState).toBe("interrupted-needs-reconciliation");
  }, 30_000);

  it("租约读取正常且确认在跑 ⇒ 仍显示为运行中（不误伤）", async () => {
    await writeMissionSummary("mission-running");
    const page = await queryMissionHistory({
      stateDirectory,
      isMissionActivelyRunning: () => true,
    });
    expect(page.entries[0]?.isActivelyRunning).toBe(true);
    expect(page.entries[0]?.runtimeState).toBe("running");
  }, 30_000);

  it("租约读取返回 false ⇒ interrupted（既有行为不变）", async () => {
    await writeMissionSummary("mission-idle");
    const page = await queryMissionHistory({
      stateDirectory,
      isMissionActivelyRunning: () => false,
    });
    expect(page.entries[0]?.runtimeState).toBe("interrupted-needs-reconciliation");
  }, 30_000);
});
