/**
 * REPAIR（`HumanWorktreeObserver` 写端缺失）：生产 status 端口与 porcelain 解析。
 *
 * 反例重点：重命名条目必须**两个路径都算变更**（否则观察会漏掉旧路径）；
 * 端口不得自己 spawn 进程（spawn 属工具层），只能消费注入的执行器。
 */
import { describe, expect, it, vi } from "vitest";

import {
  createHumanWorktreeStatusPort,
  parseGitStatusPorcelainV1,
} from "../../../packages/core/src/orchestration/human-worktree-status-port.js";

describe("HumanWorktreeObserver 生产 status 端口", () => {
  it("解析普通变更条目", () => {
    const raw = " M src/a.ts\u0000?? docs/b.md\u0000A  lib/c.ts\u0000";
    expect(parseGitStatusPorcelainV1(raw)).toEqual(["src/a.ts", "docs/b.md", "lib/c.ts"]);
  });

  it("**重命名条目两个路径都算变更**", () => {
    const raw = "R  new/path.ts\u0000old/path.ts\u0000";
    expect(parseGitStatusPorcelainV1(raw)).toEqual(["new/path.ts", "old/path.ts"]);
  });

  it("空输出 ⇒ 无变更", () => {
    expect(parseGitStatusPorcelainV1("")).toEqual([]);
  });

  it("端口消费注入的执行器（核心层不 spawn），并返回分支/HEAD/路径", async () => {
    const runGitCommand = vi.fn(async (argumentsList: readonly string[]) => {
      if (argumentsList[0] === "rev-parse" && argumentsList[1] === "--abbrev-ref") return "main\n";
      if (argumentsList[0] === "rev-parse") return "abc123\n";
      return " M a.ts\u0000";
    });
    const port = createHumanWorktreeStatusPort({ runGitCommand });
    const status = await port.readStatus();
    expect(status).toEqual({
      branchName: "main",
      headCommitIdentifier: "abc123",
      changedPaths: ["a.ts"],
    });
    expect(runGitCommand).toHaveBeenCalledTimes(3);
  });
});
