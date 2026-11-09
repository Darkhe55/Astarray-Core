/**
 * PROJECT-01-03（2026-10-30）：**受控的**跨项目资源 I/O 端口。
 *
 * ## 为什么需要它（卡内点名的缺口，2026-10-29 复查仍成立）
 *
 * `CrossProjectResourceIoPort` 此前**只有 CLI 的裸 `fs` 实现**
 * （`buildLocalResourceIoPort()`，注释自述"不引入核心包依赖"）⇒
 * `AstarrayApplicationFacade.create()` 的 `crossProjectResourceIo` 在 **SDK/GUI 路径恒为 `null`**
 * ⇒ 跨项目导入只能走 fail-closed 的 `cross-project-resource-io-unavailable`。
 *
 * 而**直接把 CLI 的裸端口搬进来是错的**：那等于"拿到绝对路径就能读写"，
 * 与 AGENTS.md"**权限在工具实际执行前检查**"和受保护存储禁令直接冲突。
 *
 * ## 本模块做什么
 *
 * 提供一个**受控**端口：**每一次**读写/建目录/存在性检查前，
 * 都必须先过两道本地确定性闸门：
 *  1. **工作区边界**（`WorkspaceBoundary.resolveWithinWorkspace`）——
 *     越界路径（`..` 逃逸、绝对路径指向工作区外）**拒绝**；
 *  2. **受保护存储禁令**（`ProtectedStoragePolicy.assertGenericToolAccessAllowed`）——
 *     保管库/删除审计等**拒绝**，且**词法与 realpath 双重比对**（防工作区内链接指向保管库）。
 *
 * 不做"先读后判"：**先判再读**，拒绝时**不触达资源**。
 */
import { promises as fs } from "node:fs";

import type {
  CrossProjectResourceIoPort,
  CrossProjectResourceIoScopeContext,
} from "../orchestration/cross-project-authorization-store.js";
import type { GenericToolFileOperation } from "./protected-storage-policy.js";
import type { ProtectedStoragePolicy } from "./protected-storage-policy.js";
import type { WorkspaceBoundary } from "./workspace-boundary.js";

export interface ControlledCrossProjectResourceIoOptions {
  /** 目标项目工作区边界（所有路径必须落在其内）。 */
  workspaceBoundary: WorkspaceBoundary;
  /** 受保护存储策略（保管库/审计文件等一律拒绝）。 */
  protectedStoragePolicy: ProtectedStoragePolicy;
  /**
   * PROJECT-01（2026-11-09）：**额外允许的根**（异步提供，每次判定重新读取）。
   *
   * 为什么需要：受控端口此前只认**单一**工作区根，而跨项目借阅的真实布局
   * 通常是"两个项目根互为兄弟目录"。此时来源/目标项目根都在工作区根之外，
   * 于是**合法授权也会被判 `path-escape-attempt`**（实测复现）。
   *
   * 安全边界（不得放宽）：
   * - 只接受**已经由认证控制面登记**的根（由装配方提供，不接受模型输入）；
   * - 路径必须落在这些根**之内**（realpath 归一后按目录前缀比对）；
   * - 受保护存储判定**照旧执行**，额外根不是绕过保管库禁令的理由。
   */
  additionalAllowedRootsProvider?: (() => Promise<readonly string[]>) | null;
}

/**
 * 受控跨项目资源端口。
 *
 * 每个操作都遵循同一顺序：**解析到工作区内 → 过受保护存储判定 → 才触达磁盘**。
 * 任一步拒绝即抛错，**绝不"先读了再判"**。
 */
export class ControlledCrossProjectResourceIo implements CrossProjectResourceIoPort {
  private readonly workspaceBoundary: WorkspaceBoundary;
  private readonly protectedStoragePolicy: ProtectedStoragePolicy;
  private readonly additionalAllowedRootsProvider:
    | (() => Promise<readonly string[]>)
    | null;

  constructor(options: ControlledCrossProjectResourceIoOptions) {
    this.workspaceBoundary = options.workspaceBoundary;
    this.protectedStoragePolicy = options.protectedStoragePolicy;
    this.additionalAllowedRootsProvider = options.additionalAllowedRootsProvider ?? null;
  }

  /**
   * PROJECT-01：路径是否落在某个**额外允许根**之内（realpath 归一后按目录前缀比对）。
   *
   * 返回归一后的真实路径；不在任何根内返回 null。根自身也算"在内"。
   */
  private async resolveWithinAdditionalRoots(
    absolutePath: string,
  ): Promise<string | null> {
    if (this.additionalAllowedRootsProvider === null) return null;
    const allowedRoots = await this.additionalAllowedRootsProvider();
    if (allowedRoots.length === 0) return null;
    return await this.resolveWithinRoots(absolutePath, allowedRoots);
  }

  /** 通用实现：路径是否落在给定根集合之内（realpath 归一后按目录前缀比对）。 */
  private async resolveWithinRoots(
    absolutePath: string,
    allowedRoots: readonly string[],
  ): Promise<string | null> {
    if (allowedRoots.length === 0) return null;
    let realCandidatePath: string;
    try {
      realCandidatePath = await fs.realpath(absolutePath);
    } catch {
      /** 目标尚不存在（例如导入时的新文件）：用父目录 realpath + 文件名归一。 */
      const parentDirectoryPath = pathDirname(absolutePath);
      try {
        const realParentPath = await fs.realpath(parentDirectoryPath);
        realCandidatePath = pathJoin(realParentPath, pathBasename(absolutePath));
      } catch {
        return null;
      }
    }
    for (const allowedRoot of allowedRoots) {
      let realRootPath: string;
      try {
        realRootPath = await fs.realpath(allowedRoot);
      } catch {
        continue;
      }
      /**
       * Windows 的 realpath 用反斜杠、POSIX 用正斜杠：比较前**统一成一种分隔符**，
       * 否则同一台机器上"根 + 子路径"的前缀判定会恒不成立（实测踩到）。
       */
      const normalizedRoot = realRootPath.replace(/[\\/]+$/u, "").replace(/\\/gu, "/");
      const normalizedCandidate = realCandidatePath.replace(/\\/gu, "/");
      if (
        normalizedCandidate === normalizedRoot ||
        normalizedCandidate.startsWith(normalizedRoot + "/")
      ) {
        return realCandidatePath;
      }
    }
    return null;
  }

  /**
   * 两道闸门合一的授权解析：**返回可用于磁盘访问的规范路径**。
   * 越界或命中受保护存储 ⇒ 抛错（DomainError），调用方不得继续。
   */
  private async authorizePath(
    absolutePath: string,
    operation: GenericToolFileOperation,
    scopeContext?: CrossProjectResourceIoScopeContext,
  ): Promise<string> {
    /**
     * ① 工作区边界：越界时**先看是否落在额外允许根内**（跨项目兄弟目录场景），
     * 两者都不满足才拒绝。判定顺序不变：仍在触达磁盘之前完成。
     */
    let resolvedWithinWorkspace: string;
    try {
      resolvedWithinWorkspace =
        await this.workspaceBoundary.resolveWithinWorkspace(absolutePath);
    } catch (workspaceBoundaryError) {
      /**
       * 先看**本次操作已证实**的项目根（来源/目标），再看全局额外允许根。
       * 两者都只是"允许根"，受保护存储判定照旧执行。
       */
      const resolvedWithinAdditionalRoot =
        (await this.resolveWithinRoots(
          absolutePath,
          scopeContext?.allowedProjectRootPaths ?? [],
        )) ?? (await this.resolveWithinAdditionalRoots(absolutePath));
      if (resolvedWithinAdditionalRoot === null) {
        /** 不在任何允许根内 ⇒ 保持原有 fail-closed 行为（抛原错误）。 */
        throw workspaceBoundaryError;
      }
      resolvedWithinWorkspace = resolvedWithinAdditionalRoot;
    }
    // ② 受保护存储：词法 + realpath 双重比对
    await this.protectedStoragePolicy.assertGenericToolAccessAllowed({
      canonicalTargetPath: resolvedWithinWorkspace,
      operation,
    });
    return resolvedWithinWorkspace;
  }

  async readTextFile(
    absolutePath: string,
    scopeContext?: CrossProjectResourceIoScopeContext,
  ): Promise<string> {
    const authorizedPath = await this.authorizePath(absolutePath, "read", scopeContext);
    return await fs.readFile(authorizedPath, "utf8");
  }

  async writeTextFile(
    absolutePath: string,
    content: string,
    scopeContext?: CrossProjectResourceIoScopeContext,
  ): Promise<void> {
    const authorizedPath = await this.authorizePath(absolutePath, "replace", scopeContext);
    await fs.mkdir(pathDirname(authorizedPath), { recursive: true });
    await fs.writeFile(authorizedPath, content, "utf8");
  }

  async ensureDirectory(
    absoluteDirectoryPath: string,
    scopeContext?: CrossProjectResourceIoScopeContext,
  ): Promise<void> {
    const authorizedPath = await this.authorizePath(
      absoluteDirectoryPath,
      "create",
      scopeContext,
    );
    await fs.mkdir(authorizedPath, { recursive: true });
  }

  async fileExists(
    absolutePath: string,
    scopeContext?: CrossProjectResourceIoScopeContext,
  ): Promise<boolean> {
    const authorizedPath = await this.authorizePath(absolutePath, "read", scopeContext);
    try {
      await fs.access(authorizedPath);
      return true;
    } catch {
      return false;
    }
  }
}

/** 取文件名（仅用于把"尚不存在的目标文件"拼回真实父目录）。 */
function pathBasename(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separatorIndex < 0 ? filePath : filePath.slice(separatorIndex + 1);
}

/** 拼接目录与文件名（统一用平台分隔符）。 */
function pathJoin(directoryPath: string, fileName: string): string {
  const separator = directoryPath.includes("\\") ? "\\" : "/";
  return directoryPath.replace(/[\\/]+$/u, "") + separator + fileName;
}

/** 仅在已授权的规范路径上取父目录（避免再引入一次未授权路径运算）。 */
function pathDirname(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separatorIndex <= 0 ? filePath : filePath.slice(0, separatorIndex);
}
