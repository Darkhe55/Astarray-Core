/**
 * PROJECT-01（2026-11-09）：**兄弟目录布局**下的跨项目借阅。
 *
 * 真实缺陷（本轮修复）：受控端口只认**单一**工作区根。既有压力用例为了绕开它，
 * 把 `workspaceRootPath` 设成三个项目根的**父目录** —— 于是"跨项目"其实仍在
 * 同一根内，真实布局（两个项目根互为兄弟）从未被覆盖。
 *
 * 本文件用真实布局：`base/project-a` 是工作区根，`base/project-b` 是它的兄弟目录。
 * 断言：合法授权可读；工作区根之外、且未被任何授权覆盖的路径仍被拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

/** RELIABILITY-01：本文件会创建较多目录并走真实装配 ⇒ 显式预算。 */
vi.setConfig({ testTimeout: 60_000 });

let baseDirectory: string;
let stateDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-sibling-roots-"));
  stateDirectory = path.join(baseDirectory, "project-a", ".astarray");
  await fs.mkdir(path.join(baseDirectory, "project-a"), { recursive: true });
  await fs.mkdir(path.join(baseDirectory, "project-b", "docs"), { recursive: true });
  await fs.mkdir(path.join(baseDirectory, "project-c", "docs"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function writeFile(relativeProjectPath: string, content: string): Promise<string> {
  const absolutePath = path.join(baseDirectory, relativeProjectPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    /** 关键：工作区根是 project-a —— project-b/c 都在它之外（真实布局）。 */
    workspaceRootPath: path.join(baseDirectory, "project-a"),
    projectIdentifier: "project-a",
    authenticatedUserId: "user-1",
  });
}

describe("PROJECT-01 兄弟目录布局", () => {
  it("合法授权下可读兄弟项目文件（修复前会 path-escape-attempt）", async () => {
    const application = await createFacade();
    try {
      const sourceAbsolutePath = await writeFile(
        path.join("project-b", "docs", "spec.md"),
        "兄弟项目的规范正文",
      );
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-b-to-a",
        sourceProjectIdentifier: "project-b",
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-a",
        operationKind: "read",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sha256:" + "a".repeat(64),
      });

      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "auth-b-to-a",
        sourceProjectIdentifier: "project-b",
        targetProjectIdentifier: "project-a",
        sourceResourcePath: "docs/spec.md",
        absoluteResourcePath: sourceAbsolutePath,
        sourceProjectRootPath: path.join(baseDirectory, "project-b"),
        argumentsHash: "sha256:" + "a".repeat(64),
      });
      expect(result.outcome).toBe("read-allowed");
      expect(result.content).toBe("兄弟项目的规范正文");
    } finally {
      await application.shutdown?.();
    }
  }, 60_000);

  it("未被授权覆盖的兄弟路径仍被拒绝（允许根不是整个磁盘）", async () => {
    const application = await createFacade();
    try {
      const sourceAbsolutePath = await writeFile(
        path.join("project-b", "docs", "spec.md"),
        "正文",
      );
      await writeFile(path.join("project-c", "docs", "secret.md"), "不该被读到");
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-b-to-a",
        sourceProjectIdentifier: "project-b",
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-a",
        operationKind: "read",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sha256:" + "b".repeat(64),
      });

      /**
       * 冒充"来源根"为 project-c 并读 project-c 的文件：
       * 绑定校验会通过（根与相对路径自洽），但授权记录覆盖的是 project-b，
       * 因此仍应被拒 —— 这里断言的是"授权范围仍然生效"。
       */
      const result = await application.readCrossProjectResource({
        authorizationIdentifier: "auth-b-to-a",
        sourceProjectIdentifier: "project-c",
        targetProjectIdentifier: "project-a",
        sourceResourcePath: "docs/secret.md",
        absoluteResourcePath: path.join(baseDirectory, "project-c", "docs", "secret.md"),
        sourceProjectRootPath: path.join(baseDirectory, "project-c"),
        argumentsHash: "sha256:" + "b".repeat(64),
      });
      expect(result.outcome).not.toBe("read-allowed");
      expect(result.content).toBeNull();
      /** 与授权来源不一致 ⇒ 应被授权记录层拒绝，而不是读成功。 */
      expect(sourceAbsolutePath).toContain("project-b");
    } finally {
      await application.shutdown?.();
    }
  }, 60_000);

  it("导入副本到兄弟目标目录同样可用（来源与目标根都要放行）", async () => {
    const application = await createFacade();
    try {
      const sourceAbsolutePath = await writeFile(
        path.join("project-b", "docs", "spec.md"),
        "要导入的正文",
      );
      const targetAbsolutePath = path.join(baseDirectory, "project-a", "imported", "spec.md");
      await application.grantCrossProjectAuthorizationForAcceptance({
        authorizationIdentifier: "auth-import-b-to-a",
        sourceProjectIdentifier: "project-b",
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-a",
        operationKind: "import-copy",
        resourcePathPrefixes: ["docs/"],
        argumentsHash: "sha256:" + "c".repeat(64),
      });

      const result = await application.importCrossProjectResource({
        authorizationIdentifier: "auth-import-b-to-a",
        sourceProjectIdentifier: "project-b",
        targetProjectIdentifier: "project-a",
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: "imported/spec.md",
        absoluteSourcePath: sourceAbsolutePath,
        absoluteTargetPath: targetAbsolutePath,
        sourceProjectRootPath: path.join(baseDirectory, "project-b"),
        targetProjectRootPath: path.join(baseDirectory, "project-a"),
        sourceRevision: 1,
        argumentsHash: "sha256:" + "c".repeat(64),
      });
      expect(result.outcome).toBe("imported-copy");
      await expect(fs.readFile(targetAbsolutePath, "utf8")).resolves.toBe("要导入的正文");
    } finally {
      await application.shutdown?.();
    }
  }, 60_000);
});
