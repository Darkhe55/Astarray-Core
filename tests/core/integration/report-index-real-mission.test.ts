/**
 * ALIGN-01-06（2026-11-08）：真实 mission 终态 → 报告索引 → 按需读回。
 *
 * 之前的证据都是**合成调用**（直接 `ingestTertiaryTerminalReport` 手填数据）：
 * 卡内如实写着"没有用真实 mission 跑通 终态 → 索引文件 → 读回"。
 * 这里用真实 runtime 跑一次任务，让终态写入路径自己产生报告。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000 });

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 6 });
    }
  }
});

async function createRuntime() {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-report-index-"));
  directories.push(stateDirectory);
  return createApplicationRuntime({
    mode: "assist",
    stateDirectory,
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 4,
    runtimeKind: "mock",
    useFeedbackProcess: false,
    authenticatedUserId: "user-1",
    streamOutput: () => {},
  });
}

async function waitForTerminal(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  missionId: string,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  let status = await runtime.controller.queryMissionStatus(missionId);
  while (
    !["done", "blocked", "cancelled"].includes(status?.summary?.status ?? "") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await runtime.controller.queryMissionStatus(missionId);
  }
  return status?.summary?.status ?? "unknown";
}

describe("报告索引：真实 mission 终态", () => {
  it("mission 跑完 ⇒ 索引可读回；按需读取有预算且有来源", async () => {
    const runtime = await createRuntime();
    try {
      const missionId = await runtime.controller.handleUserMessage("报告索引测试", {
        projectIdentifier: "project-a",
      });
      const terminalStatus = await waitForTerminal(runtime, missionId);
      expect(["done", "blocked"]).toContain(terminalStatus);

      /** 终态写入是异步尾声：给它一点时间落盘（不无限等）。 */
      const deadline = Date.now() + 5_000;
      let index = await runtime.controller.listReportIndex(missionId);
      while (index.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        index = await runtime.controller.listReportIndex(missionId);
      }
      expect(index.length).toBeGreaterThan(0);
      const entry = index[0]!;
      expect(entry.missionId).toBe(missionId);
      expect(entry.reportingAgentInstanceId).not.toBe("");
      expect(entry.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);

      const reports = await runtime.controller.selectRelevantReports({
        missionId,
        maxReports: 3,
        tokenBudgetTokens: 2048,
      });
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0]?.missionId).toBe(missionId);
      expect(reports[0]?.reportingAgentInstanceId).toBe(entry.reportingAgentInstanceId);

      /** 预算为 0 ⇒ 不返回任何报告（预算优先，不静默超发）。 */
      const none = await runtime.controller.selectRelevantReports({
        missionId,
        maxReports: 3,
        tokenBudgetTokens: 0,
      });
      expect(none).toEqual([]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });

  it("未登记的来源写入 ⇒ 被拒（非空字符串不是认证）", async () => {
    const runtime = await createRuntime();
    try {
      await expect(
        runtime.controller.ingestTertiaryTerminalReport({
          reportId: "report-unregistered",
          missionId: "mission-any",
          taskBundleId: "bundle-any",
          reportingAgentInstanceId: "not-registered-agent",
          reportKind: "completed",
          summary: "未登记来源的汇报",
          executedChecks: [],
          createdAtIso: new Date().toISOString(),
          contentHash: "sha256:" + "0".repeat(64),
        }),
      ).rejects.toThrow(/报告来源认证失败/u);
      expect(await runtime.controller.listReportIndex("mission-any")).toEqual([]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  });
});
