/**
 * GUI-04-06（2026-11-03）：休息门禁拒绝后确实登记，供 rest→working 恢复。
 *
 * 只验证"拒绝 ⇒ 落盘登记"这一半；rest→working 的恢复判定由纯函数单测覆盖。
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

describe("休息拒绝登记", () => {
  it("全天休息规则 ⇒ 任务被拒且 deferred 文件出现该 mission", async () => {
    const stateDirectory = await fs.mkdtemp(
      path.join(tmpdir(), "astarray-workwindow-record-"),
    );
    directories.push(stateDirectory);
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      statusPollIntervalMilliseconds: 20,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const current = await application.queryWorkWindowConfig();
      await application.updateWorkWindowConfig({
        expectedRevision: current.revision,
        rules: [
          {
            ruleIdentifier: "all-day-rest",
            mode: "rest-blacklist",
            scopeKind: "global",
            weekdays: [],
            startMinuteOfDay: 0,
            endMinuteOfDay: 1440,
            timeZone: "Asia/Shanghai",
            priority: "periodic",
            validFromUtcIso: null,
            validUntilUtcIso: null,
          },
        ],
      });

      await expect(
        application.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-1",
          prompt: "测试休息门禁",
        }),
      ).rejects.toBeDefined();

      const raw = await fs.readFile(
        path.join(stateDirectory, "work-window", "deferred-missions.json"),
        "utf8",
      );
      const document = JSON.parse(raw) as {
        records: Array<{ missionIdentifier: string; reason: string }>;
      };
      expect(document.records.length).toBeGreaterThan(0);
      expect(document.records[0]?.missionIdentifier).toBeTruthy();
      expect(document.records[0]?.reason).toBeTruthy();
    } finally {
      await application.shutdown();
    }
  });
});
