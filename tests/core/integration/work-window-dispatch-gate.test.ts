/** GUI-03-05：休息时段阻止新任务派发。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("工作时段派发门禁", () => {
  it("① 全天休息时拒绝新任务，且不创建任务", async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "astarray-work-gate-"));
    directories.push(stateDirectory);
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
      useFeedbackProcess: false,
    });
    try {
      application.createSession({ sessionId: "session-1", mode: "assist" });
      const current = await application.queryWorkWindowConfig();
      await application.updateWorkWindowConfig({
        expectedRevision: current.revision,
        rules: [
          {
            ruleIdentifier: "always-rest",
            mode: "rest-blacklist",
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            startMinuteOfDay: 0,
            endMinuteOfDay: 1440,
            timeZone: "Asia/Shanghai",
            priority: "periodic",
            validFromUtcIso: null,
            validUntilUtcIso: null,
            scopeKind: "global",
          },
        ],
      });
      await expect(
        application.submitTask({
          sessionId: "session-1",
          taskIdentifier: "task-1",
          prompt: "休息时段不应派发",
        }),
      ).rejects.toThrow(/休息时段/);
    } finally {
      await application.shutdown();
    }
  });
});
