/**
 * REPAIR（`HumanWorktreeObserver` 写端缺失）：构造与写盘证据。
 *
 * 分诊结论是"读端有、写端从未构造 ⇒ journal 生产恒空"。
 * 本用例锁定两件事：装配层**确实构造了**观察器；调用 `observeWorktree` 后
 * `<stateDirectory>/human-change-journal/<id>.json` **真的存在**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplicationRuntime } from "../../../packages/core/src/application/application-runtime.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "observer-wiring-"));
});

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

describe("HumanWorktreeObserver 写端接线", () => {
  it("装配层构造观察器；观察后 journal 文件真的落盘", async () => {
    /** 用临时 git 仓库当工作区，避免依赖宿主仓库状态。 */
    const workspace = path.join(stateDirectory, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "example@example.invalid"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "test"], { cwd: workspace });
    await fs.writeFile(path.join(workspace, "a.txt"), "hello\n", "utf8");
    execFileSync("git", ["add", "a.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: workspace });
    /** 制造一处人工改动，让 status 有内容。 */
    await fs.writeFile(path.join(workspace, "a.txt"), "hello world\n", "utf8");

    const runtime = await createApplicationRuntime({
      mode: "assist",
      stateDirectory,
      workspaceRootPath: workspace,
      concurrency: 1,
      failureThreshold: 1,
      maxLoopIterations: 2,
      useFeedbackProcess: false,
      authenticatedUserId: "user-1",
      mainAgentInstanceId: "main-agent-1",
      streamOutput: () => {},
    } as never);

    try {
      expect(runtime.humanWorktreeObserver).toBeDefined();
      const result = await runtime.humanWorktreeObserver.observeWorktree({
        observationIdentifier: "obs-1",
        nowIso: "2026-11-11T00:00:00.000Z",
      });
      expect(result.observation.changedPaths).toContain("a.txt");

      const journalPath = path.join(stateDirectory, "human-change-journal", "obs-1.json");
      const raw = await fs.readFile(journalPath, "utf8");
      expect(JSON.parse(raw).observationIdentifier).toBe("obs-1");
    } finally {
      await runtime.shutdown().catch(() => undefined);
    }
  }, 60_000);
});
