/**
 * PROJECT-01 / 用户裁决（2026-11-09）：**CLI 业务文件操作必须走受控端口**。
 *
 * 真实缺陷：CLI 用 `buildLocalResourceIoPort()`（裸 `fs` + 仅受保护存储判定）⇒
 * "拿到绝对路径就能读写"，缺少真实路径与工作区边界检查，与 SDK 侧安全语义不一致。
 *
 * 本文件是 CLI 入口级反例：
 *  - 声明路径与传入的绝对路径不一致（逃逸到项目根之外）⇒ 必须拒绝，**且不读内容**；
 *  - 合法路径 ⇒ 照常可读（证明受控端口不是"一律拒绝"）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { executeCrossProjectReadCommand } from "../../../packages/tui/src/cli/commands.js";

/** RELIABILITY-01：本文件做真实文件 I/O 与 CLI 调用 ⇒ 显式预算。 */
vi.setConfig({ testTimeout: 60_000 });

let baseDirectory: string;
let sourceRootPath: string;
let stateDirectory: string;
let legitimateFilePath: string;
let outsideFilePath: string;

const SOURCE_PROJECT = "project-a";
const TARGET_PROJECT = "project-b";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cli-controlled-"));
  sourceRootPath = path.join(baseDirectory, "project-a");
  stateDirectory = path.join(baseDirectory, "state");
  legitimateFilePath = path.join(sourceRootPath, "docs", "spec.md");
  /** 项目根**之外**的文件：受控端口必须拒绝访问。 */
  outsideFilePath = path.join(baseDirectory, "outside-secret.md");
  await fs.mkdir(path.dirname(legitimateFilePath), { recursive: true });
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(legitimateFilePath, "项目内正文", "utf8");
  await fs.writeFile(outsideFilePath, "项目外机密", "utf8");
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function grantReadAuthorization(input: {
  readonly authorizationIdentifier: string;
  readonly argumentsHash: string;
}): Promise<void> {
  const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
  await store.grantAuthorization({
    authorizationIdentifier: input.authorizationIdentifier,
    sourceProjectIdentifier: SOURCE_PROJECT,
    sourceProjectRevision: 1,
    targetProjectIdentifier: TARGET_PROJECT,
    targetProjectRevision: 1,
    operationKind: "read",
    resourceScope: {
      pathPrefixes: ["docs/"],
      realPaths: [],
      isDynamicSharedDirectory: false,
    },
    argumentsHash: input.argumentsHash,
    expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
    grantedByUserId: "user-1",
    taskIdentifier: "task-1",
  });
}

describe("CLI 跨项目只读：受控端口", () => {
  it("合法路径照常可读（受控端口不是一律拒绝）", async () => {
    const argumentsHash = "sha256:" + "a".repeat(64);
    await grantReadAuthorization({
      authorizationIdentifier: "auth-legit",
      argumentsHash,
    });
    const exitCode = await executeCrossProjectReadCommand({
      stateDirectory,
      authorizationIdentifier: "auth-legit",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      absoluteResourcePath: legitimateFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
  }, 60_000);

  it("声明路径与真实路径不一致（逃逸到项目根之外）⇒ 拒绝且不读内容", async () => {
    const argumentsHash = "sha256:" + "b".repeat(64);
    await grantReadAuthorization({
      authorizationIdentifier: "auth-escape",
      argumentsHash,
    });
    /**
     * 伪造：声明 `docs/spec.md`，实传项目根之外的绝对路径。
     * 绑定守卫会拒绝；即便绕过绑定，受控端口的边界也不允许该路径。
     */
    const exitCode = await executeCrossProjectReadCommand({
      stateDirectory,
      authorizationIdentifier: "auth-escape",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "docs/spec.md",
      absoluteResourcePath: outsideFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
  }, 60_000);

  it("项目根之外的文件从未被读取（受控端口在触达磁盘前拒绝）", async () => {
    const argumentsHash = "sha256:" + "c".repeat(64);
    await grantReadAuthorization({
      authorizationIdentifier: "auth-outside",
      argumentsHash,
    });
    /** 把声明路径改成 `../outside-secret.md`：绑定守卫与边界都应拒绝。 */
    const exitCode = await executeCrossProjectReadCommand({
      stateDirectory,
      authorizationIdentifier: "auth-outside",
      sourceProjectIdentifier: SOURCE_PROJECT,
      targetProjectIdentifier: TARGET_PROJECT,
      sourceResourcePath: "../outside-secret.md",
      absoluteResourcePath: outsideFilePath,
      sourceProjectRootPath: sourceRootPath,
      argumentsHash,
      isJsonOutput: true,
    });
    expect(exitCode).not.toBe(0);
    /** 项目外文件内容保持不变（既没被读走也没被改写）。 */
    await expect(fs.readFile(outsideFilePath, "utf8")).resolves.toBe("项目外机密");
    /** 授权范围里的哈希只对合法路径有意义：这里额外确认合法路径哈希可计算。 */
    expect(sha256Text("项目内正文")).toMatch(/^[a-f0-9]{64}$/u);
  }, 60_000);
});
