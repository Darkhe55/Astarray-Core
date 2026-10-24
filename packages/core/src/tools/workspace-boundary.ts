/**
 * 工作区边界（T06/T12）。
 * 拒绝路径穿越（../ 逃逸）与符号链接逃逸；路径解析后必须位于工作区内。
 * 目标不存在时对最近存在的祖先目录做 realpath 校验。
 *
 * 2026-10-24：新增 `additionalRootsProvider` —— 文件夹授权（FolderGrantStore）
 * 在本任务内**扩展**工具边界（用户选择 A）。授权根仍逐次做 realpath 校验；
 * 授权被撤销/过期后 provider 不再返回该根，下一次调用立即失效。
 */
import path from "node:path";
import { realpath } from "node:fs/promises";

import { DomainError } from "../core/errors.js";
import { hasWindowsStyleAbsolutePathPrefix } from "./cross-platform-path-canonicalization.js";

export interface WorkspaceBoundaryOptions {
  /** 额外允许的根（异步读取；例如本项目的文件夹授权）。 */
  readonly additionalRootsProvider?: () => Promise<ReadonlyArray<string>>;
}

export class WorkspaceBoundary {
  private readonly workspaceRootPath: string;
  private readonly additionalRootsProvider: (() => Promise<ReadonlyArray<string>>) | null;

  constructor(workspaceRoot: string, options?: WorkspaceBoundaryOptions) {
    this.workspaceRootPath = path.resolve(workspaceRoot);
    this.additionalRootsProvider = options?.additionalRootsProvider ?? null;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRootPath;
  }

  private async resolveAllowedRoots(): Promise<ReadonlyArray<string>> {
    const roots = [this.workspaceRootPath];
    if (this.additionalRootsProvider !== null) {
      try {
        const additionalRoots = await this.additionalRootsProvider();
        for (const root of additionalRoots) {
          if (typeof root === "string" && path.isAbsolute(root)) {
            roots.push(path.resolve(root));
          }
        }
      } catch {
        // 授权读取失败 ⇒ 只保留主根（fail-closed，不因读取错误放宽边界）。
      }
    }
    return roots;
  }

  /**
   * 将请求路径解析为允许范围内绝对路径；任何逃逸尝试抛
   * DomainError（path-escape-attempt）。
   */
  async resolveWithinWorkspace(requestedPath: string): Promise<string> {
    // LINUX-PORT-01：盘符/UNC 前缀在任何平台都是绝对路径。POSIX 上若不显式拒绝，
    // path.resolve 会把它当作普通相对名并"留在工作区内"，判定结果随平台改变。
    // 宿主已认定为绝对路径时仍交给下面的包含性判定（Windows 上工作区内绝对路径必须可用）。
    if (
      !path.isAbsolute(requestedPath) &&
      hasWindowsStyleAbsolutePathPrefix(requestedPath)
    ) {
      throw new DomainError(
        "path-escape-attempt",
        `跨平台绝对路径被拒绝: ${requestedPath}`,
      );
    }
    const allowedRoots = await this.resolveAllowedRoots();
    const resolvedPath = path.isAbsolute(requestedPath)
      ? path.resolve(requestedPath)
      : path.resolve(this.workspaceRootPath, requestedPath);
    const matchedRoot = allowedRoots.find((root) => isPathWithin(root, resolvedPath));
    if (matchedRoot === undefined) {
      throw new DomainError(
        "path-escape-attempt",
        `路径逃逸工作区被拒绝: ${requestedPath}`,
      );
    }
    await this.assertNoSymlinkEscape(resolvedPath, matchedRoot);
    return resolvedPath;
  }

  private async assertNoSymlinkEscape(
    resolvedPath: string,
    allowedRootPath: string,
  ): Promise<void> {
    const anchorPath = await findNearestExistingAncestor(resolvedPath);
    if (anchorPath === null) {
      return;
    }
    const realAnchorPath = await realpath(anchorPath);
    if (!isPathWithin(allowedRootPath, realAnchorPath)) {
      throw new DomainError(
        "path-escape-attempt",
        `符号链接逃逸工作区被拒绝: ${resolvedPath}`,
      );
    }
  }
}

function isPathWithin(workspaceRootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(workspaceRootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function findNearestExistingAncestor(
  targetPath: string,
): Promise<string | null> {
  let currentPath = targetPath;
  while (true) {
    try {
      await realpath(currentPath);
      return currentPath;
    } catch {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  }
}
