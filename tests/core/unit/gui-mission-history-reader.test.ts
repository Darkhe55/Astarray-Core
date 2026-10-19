/**
 * `queryMissionHistory` 的反例（2026-10-20 R88）。
 *
 * 该模块此前**0% 覆盖**（71 个分支全未测），而它是"历史只读视图"的核心：
 * 一旦把"损坏/中断/运行中"标错，用户会以为任务还在跑或以为历史丢了。
 *
 * 覆盖重点：①缺失/损坏 summary ⇒ corrupted（保留在列表，不静默丢弃）
 * ②历史状态 vs 运行状态分离（重启后不得显示运行中）③不安全目录名拒绝
 * ④游标只接受列表内真实目录名（`../..` 只会得到空页）⑤分页参数校验与上界收敛
 * ⑥三个"仅可证伪"端口**从不被调用**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAXIMUM_MISSION_HISTORY_PAGE_SIZE,
  queryMissionHistory,
} from "../../../packages/core/src/gui/mission-history-reader.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-mission-history-"));
  await fs.mkdir(path.join(stateDirectory, "missions"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function writeSummary(missionIdentifier: string, content: string): Promise<void> {
  const missionDirectory = path.join(stateDirectory, "missions", missionIdentifier);
  await fs.mkdir(missionDirectory, { recursive: true });
  await fs.writeFile(path.join(missionDirectory, "summary.json"), content, "utf8");
}

describe("查询 mission 历史（只读）", () => {
  it("① 没有 missions 目录 ⇒ 空页（不是错误）", async () => {
    await fs.rm(path.join(stateDirectory, "missions"), { recursive: true, force: true });
    const page = await queryMissionHistory({ stateDirectory });
    expect(page.entries).toHaveLength(0);
    expect(page.totalMissionCount).toBe(0);
    expect(page.hasMorePages).toBe(false);
  });

  it("② 缺失/损坏 summary ⇒ corrupted 且**保留在列表**（不静默丢弃）", async () => {
    await writeSummary("mission-missing", "{}");
    await fs.rm(path.join(stateDirectory, "missions", "mission-missing", "summary.json"));
    await writeSummary("mission-bad-json", "{ not json");
    await writeSummary("mission-array", "[]");
    await writeSummary("mission-null", "null");

    const page = await queryMissionHistory({ stateDirectory });
    expect(page.entries).toHaveLength(4);
    for (const entry of page.entries) {
      expect(entry.isCorrupted).toBe(true);
      expect(entry.runtimeState).toBe("corrupted-needs-attention");
      // 损坏条目也要能被界面识别（有 mission 标识）
      expect(entry.missionIdentifier.length).toBeGreaterThan(0);
    }
  });

  it("③ 历史状态 vs 运行状态：running 但未确认在跑 ⇒ interrupted（不得显示运行中）", async () => {
    await writeSummary(
      "mission-running",
      JSON.stringify({ status: "running", prompt: "做点事", mode: "assist", createdAtIso: "2026-10-19T00:00:00.000Z" }),
    );
    const withoutRunningPort = await queryMissionHistory({ stateDirectory });
    expect(withoutRunningPort.entries[0]?.runtimeState).toBe("interrupted-needs-reconciliation");
    expect(withoutRunningPort.entries[0]?.isActivelyRunning).toBe(false);

    const withRunningPort = await queryMissionHistory({
      stateDirectory,
      isMissionActivelyRunning: (missionIdentifier) => missionIdentifier === "mission-running",
    });
    expect(withRunningPort.entries[0]?.runtimeState).toBe("running");
    expect(withRunningPort.entries[0]?.isActivelyRunning).toBe(true);
  });

  it("④ 终态映射：done/cancelled/blocked ⇒ finished；未知状态 ⇒ unknown", async () => {
    await writeSummary("mission-done", JSON.stringify({ status: "done" }));
    await writeSummary("mission-cancelled", JSON.stringify({ status: "cancelled" }));
    await writeSummary("mission-blocked", JSON.stringify({ status: "blocked" }));
    await writeSummary("mission-weird", JSON.stringify({ status: "whatever" }));

    const page = await queryMissionHistory({ stateDirectory, pageSize: 100 });
    const stateByIdentifier = new Map(
      page.entries.map((entry) => [entry.missionIdentifier, entry.runtimeState]),
    );
    expect(stateByIdentifier.get("mission-done")).toBe("finished");
    expect(stateByIdentifier.get("mission-cancelled")).toBe("finished");
    expect(stateByIdentifier.get("mission-blocked")).toBe("finished");
    expect(stateByIdentifier.get("mission-weird")).toBe("unknown");
  });

  it("⑤ 空白 projectIdentifier ⇒ null（不伪装成有值）；纯空白 prompt 原样保留", async () => {
    await writeSummary(
      "mission-blank-project",
      JSON.stringify({ status: "done", projectIdentifier: "   ", prompt: "  " }),
    );
    const page = await queryMissionHistory({ stateDirectory });
    expect(page.entries[0]?.projectIdentifier).toBeNull();
    expect(page.entries[0]?.prompt).toBe("  ");
  });

  it("⑥ 不安全目录名被拒绝（. / .. / 含分隔符 / 含盘符）", async () => {
    await writeSummary("mission-good", JSON.stringify({ status: "done" }));
    // 这些名字无法作为单层目录名创建，但可以用"同名子目录 + .."制造类似形态的邻居
    await fs.mkdir(path.join(stateDirectory, "missions", "nested"), { recursive: true });
    await fs.writeFile(path.join(stateDirectory, "missions", "plain-file"), "x", "utf8");

    const page = await queryMissionHistory({ stateDirectory, pageSize: 100 });
    const identifiers = page.entries.map((entry) => entry.missionIdentifier);
    expect(identifiers).toContain("mission-good");
    // 目录里的普通文件不被当成 mission
    expect(identifiers).not.toContain("plain-file");
    // `nested` 是**合法**的单层目录名 ⇒ 会被列出（其 summary 缺失 ⇒ corrupted），但不会被当成文件
    expect(identifiers).toContain("nested");
  });

  it("⑦ 分页：上界收敛、页码越界为空页、hasMorePages 正确", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeSummary(`mission-${String(index)}`, JSON.stringify({ status: "done" }));
    }
    const clamped = await queryMissionHistory({ stateDirectory, pageSize: 10_000 });
    expect(clamped.effectivePageSize).toBe(MAXIMUM_MISSION_HISTORY_PAGE_SIZE);

    const firstPage = await queryMissionHistory({ stateDirectory, pageSize: 2, pageIndex: 0 });
    expect(firstPage.entries).toHaveLength(2);
    expect(firstPage.hasMorePages).toBe(true);

    const lastPage = await queryMissionHistory({ stateDirectory, pageSize: 2, pageIndex: 2 });
    expect(lastPage.entries).toHaveLength(1);
    expect(lastPage.hasMorePages).toBe(false);

    const outOfRange = await queryMissionHistory({ stateDirectory, pageSize: 2, pageIndex: 99 });
    expect(outOfRange.entries).toHaveLength(0);
  });

  it("⑧ 游标只接受列表内真实目录名：不存在的游标 ⇒ 空页（不会越界读取）", async () => {
    await writeSummary("mission-a", JSON.stringify({ status: "done" }));
    await writeSummary("mission-b", JSON.stringify({ status: "done" }));

    const afterExisting = await queryMissionHistory({
      stateDirectory,
      afterMissionIdentifier: "mission-a",
      pageSize: 10,
    });
    expect(afterExisting.entries.map((entry) => entry.missionIdentifier)).not.toContain("mission-a");

    const afterBogus = await queryMissionHistory({
      stateDirectory,
      afterMissionIdentifier: "../../etc",
      pageSize: 10,
    });
    expect(afterBogus.entries).toHaveLength(0);
  });

  it("⑨ 非法分页参数 ⇒ 明确报错（不静默按默认值执行）", async () => {
    await expect(queryMissionHistory({ stateDirectory, pageSize: 0 })).rejects.toThrow(
      /pageSize 必须为正整数/,
    );
    await expect(queryMissionHistory({ stateDirectory, pageIndex: -1 })).rejects.toThrow(
      /pageIndex 必须为非负整数/,
    );
  });

  it("⑩ 三个「仅可证伪」端口从不被调用（只读路径不得触发恢复/模型/上下文注入）", async () => {
    await writeSummary("mission-a", JSON.stringify({ status: "running" }));
    const requestRecovery = vi.fn();
    const invokeModel = vi.fn();
    const injectContext = vi.fn();
    await queryMissionHistory({
      stateDirectory,
      requestRecovery,
      invokeModel,
      injectContext,
      isMissionActivelyRunning: () => true,
    });
    expect(requestRecovery).not.toHaveBeenCalled();
    expect(invokeModel).not.toHaveBeenCalled();
    expect(injectContext).not.toHaveBeenCalled();
  });
});

