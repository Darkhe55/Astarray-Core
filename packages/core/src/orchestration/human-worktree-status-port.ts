import type { HumanWorktreeStatusPort } from "./human-worktree-observer.js";

/**
 * REPAIR（17 项分诊 · `HumanWorktreeObserver`）：
 * 观察器**写端从未被构造**，导致 `human-change-journal` 在生产里恒为空。
 *
 * 要让写端可达，先得有**生产的 status 端口**——此前只有测试里手写的桩。
 * 本模块提供两点：
 * 1. `parseGitStatusPorcelainV1`：纯解析（`git status --porcelain=v1 -z` 输出），可单测；
 * 2. `createHumanWorktreeStatusPort`：把"执行 git 命令"的能力**注入**进来——
 *    核心层不自己 spawn 进程（spawn 属工具/沙箱层职责）。
 */

export interface GitStatusSnapshot {
  readonly branchName: string;
  readonly headCommitIdentifier: string;
  readonly changedPaths: readonly string[];
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出（NUL 分隔，路径不做引号转义）。
 *
 * 只取"变更路径"：重命名/复制条目会带两个路径（旧 → 新），**两个都算变更**。
 */
export function parseGitStatusPorcelainV1(rawOutput: string): string[] {
  const entries = rawOutput.split("\u0000");
  const changedPaths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) continue;
    const statusCode = entry.slice(0, 2);
    const pathText = entry.slice(3);
    if (pathText !== "") changedPaths.push(pathText);
    /** 重命名/复制：`-z` 下旧路径在紧随其后的条目里（无状态位前缀）。 */
    if (statusCode.includes("R") || statusCode.includes("C")) {
      const sourcePath = entries[index + 1];
      if (sourcePath !== undefined && sourcePath !== "") {
        changedPaths.push(sourcePath);
        index += 1;
      }
    }
  }
  return changedPaths;
}

export interface HumanWorktreeStatusPortOptions {
  /** 执行 git 命令并返回 stdout；由工具/沙箱层注入（核心层不 spawn）。 */
  readonly runGitCommand: (argumentsList: readonly string[]) => Promise<string>;
}

/** 生产端口：分支名、HEAD 提交、变更路径都来自真实 git 输出。 */
export function createHumanWorktreeStatusPort(
  options: HumanWorktreeStatusPortOptions,
): HumanWorktreeStatusPort {
  return {
    async readStatus() {
      const branchName = (await options.runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const headCommitIdentifier = (await options.runGitCommand(["rev-parse", "HEAD"])).trim();
      const rawStatus = await options.runGitCommand(["status", "--porcelain=v1", "-z"]);
      return {
        branchName,
        headCommitIdentifier,
        changedPaths: parseGitStatusPorcelainV1(rawStatus),
      };
    },
  };
}

/**
 * 默认执行器（`node:child_process`）。
 *
 * **更正我上一轮的判断**：我曾写"核心层不 spawn 进程"，但 `orchestration/git-*`
 * 本来就在核心层执行 git（`git-integration-coordinator` 等）。所以这里提供默认实现
 * 不破坏既有分层；注入式签名仍保留，便于测试与替换。
 */
export function createDefaultGitCommandRunner(options: {
  readonly workingDirectoryPath: string;
}): (argumentsList: readonly string[]) => Promise<string> {
  return async (argumentsList) => {
    const { execFile } = await import("node:child_process");
    return await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [...argumentsList],
        { cwd: options.workingDirectoryPath, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error !== null) {
            reject(new Error("git-command-failed", { cause: error }));
            return;
          }
          resolve(stdout);
        },
      );
    });
  };
}
