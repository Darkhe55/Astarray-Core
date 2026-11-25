/**
 * B9（2026-11-25）：本地保全的触发判定与读取失败分支。
 *
 * 纪律：同步失败才保全（成功/未尝试不保全）；清单缺失/非法/哈希不符都必须显式失败。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LocalPreservationService,
  evaluateRemoteSyncPreservationTrigger,
} from "../../../packages/core/src/orchestration/local-preservation-service.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-preserve-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("B9：本地保全触发与读取", () => {
  it("① 触发矩阵：成功/未尝试/进行中不保全；网络失败与其他失败都保全", () => {
    expect(evaluateRemoteSyncPreservationTrigger({ status: "succeeded" } as never)).toMatchObject({
      shouldPreserve: false,
    });
    expect(evaluateRemoteSyncPreservationTrigger({ status: "not-attempted" } as never)).toMatchObject({
      shouldPreserve: false,
    });
    expect(evaluateRemoteSyncPreservationTrigger({ status: "attempting" } as never)).toMatchObject({
      shouldPreserve: false,
    });
    const networkFailure = evaluateRemoteSyncPreservationTrigger({
      status: "failed-network",
    } as never);
    expect(networkFailure.shouldPreserve).toBe(true);
    expect(networkFailure.reason).toContain("网络失败");

    const otherFailure = evaluateRemoteSyncPreservationTrigger({
      status: "failed-rejected",
    } as never);
    expect(otherFailure.shouldPreserve).toBe(true);
    expect(otherFailure.reason).toContain("failed-rejected");
  });

  it("② 同步成功 ⇒ 不创建保全点（shouldPreserve=false 且 manifest 为 null）", async () => {
    const service = new LocalPreservationService({ baseDirectory });
    const outcome = await service.preserveAfterRemoteSyncOutcome({
      missionId: "mission-1",
      repositoryPath: baseDirectory,
      remoteSyncOutcome: { status: "succeeded" },
    } as never);
    expect(outcome).toMatchObject({ shouldPreserve: false, manifest: null, isReused: false });
  });

  it("③ 空目录：list 返回空数组；缺失保全点读取 ⇒ task-sequence-not-found", async () => {
    const service = new LocalPreservationService({ baseDirectory });
    expect(await service.listPreservationPoints("mission-1")).toEqual([]);
    await expect(
      service.readPreservationPoint("mission-1", "point-missing"),
    ).rejects.toMatchObject({ errorCode: "task-sequence-not-found" });
  });

  it("④ 清单非法 JSON / 哈希不符 ⇒ journal-corrupted（不返回不可信快照）", async () => {
    const service = new LocalPreservationService({ baseDirectory });
    const pointDirectory = path.join(baseDirectory, "local-preservation", "mission-1", "point-1");
    await fs.mkdir(pointDirectory, { recursive: true });

    await fs.writeFile(path.join(pointDirectory, "preservation-manifest.json"), "{ 损坏", "utf8");
    await expect(
      service.readPreservationPoint("mission-1", "point-1"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });

    await fs.writeFile(
      path.join(pointDirectory, "preservation-manifest.json"),
      JSON.stringify({
        manifestIdentifier: "m",
        createdAtIso: "2026-11-25T00:00:00.000Z",
        snapshot: { manifestSha256: "sha256:wrong" },
        localPreservation: { status: "complete" },
      }),
      "utf8",
    );
    await expect(
      service.readPreservationPoint("mission-1", "point-1"),
    ).rejects.toMatchObject({ errorCode: "journal-corrupted" });
  });

  it("⑤ list 跳过损坏目录与 .tmp- 前缀（不静默当作完整快照）", async () => {
    const service = new LocalPreservationService({ baseDirectory });
    const missionDirectory = path.join(baseDirectory, "local-preservation", "mission-1");
    await fs.mkdir(path.join(missionDirectory, ".tmp-1"), { recursive: true });
    await fs.mkdir(path.join(missionDirectory, "point-broken"), { recursive: true });
    await fs.writeFile(
      path.join(missionDirectory, "point-broken", "preservation-manifest.json"),
      "{ 损坏",
      "utf8",
    );
    expect(await service.listPreservationPoints("mission-1")).toEqual([]);
  });
});
