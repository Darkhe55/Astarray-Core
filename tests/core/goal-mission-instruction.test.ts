/**
 * R113（2026-11-01）：调度器指令入口的单测（门面层）。
 *
 * 只验证"没有活动调度器时是安全 no-op"，并固定"仅同进程有效"这一约束
 * （跨进程的 mission 由租约隔离，指令不会送达）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("调度器指令入口", () => {
  it("没有活动调度器时发送指令是安全 no-op", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-instruct-"));
    directories.push(stateDirectory);
    const application = await AstarrayApplicationFacade.create({
      stateDirectory,
      mode: "assist",
      runtime: "mock",
    });
    try {
      expect(() =>
        application.sendMissionInstruction("mission-none", "retry T-001"),
      ).not.toThrow();
    } finally {
      await application.shutdown();
    }
  });
});
