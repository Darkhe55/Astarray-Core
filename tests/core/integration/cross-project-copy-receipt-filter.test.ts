/**
 * PROJECT-01-04 的反例（2026-10-19 R26）：**副本回执必须按个体/来源过滤，不串数据**。
 *
 * 卡内验收："A/B/C 项目及多个同级个体可追溯、**不串数据**；人工能分辨副本与原件"。
 *
 * 现状缺口（本文件在修复前必须失败）：`cross-project list --agent <id>` 只过滤授权列表，
 * 但 `copyReceipts` 仍返回**所有个体**的副本回执 ⇒ 甲个体的副本被乙个体的查询看到（串数据），
 * 且摘要条目未携带"接收个体"，无法追溯。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CrossProjectAuthorizationStore,
  CrossProjectTransferService,
  summarizeCopyReceipts,
  type CrossProjectResourceIoPort,
} from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";
import { executeCrossProjectListCommand } from "../../../packages/tui/src/cli/commands.js";

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_C = "project-c";
const AGENT_ONE = "secondary-agent-1";
const AGENT_TWO = "secondary-agent-2";

let baseDirectory: string;
let stdoutText: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project04-receipt-filter-"));
  stdoutText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildResourceIo(): CrossProjectResourceIoPort {
  return {
    readTextFile: (absolutePath: string) => fs.readFile(absolutePath, "utf8"),
    writeTextFile: (absolutePath: string, content: string) =>
      fs.writeFile(absolutePath, content, "utf8"),
    ensureDirectory: async (absoluteDirectory: string) => {
      await fs.mkdir(absoluteDirectory, { recursive: true });
    },
    fileExists: async (absolutePath: string) => {
      try {
        await fs.stat(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function writeResource(projectId: string, relativePath: string, content: string) {
  const absolutePath = path.join(baseDirectory, projectId, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

/** 两个来源项目、两个不同接收个体，各自导入到项目 C。 */
async function seedTwoAgentsCouples() {
  const store = new CrossProjectAuthorizationStore({ baseDirectory });
  const service = new CrossProjectTransferService({ store, resourceIo: buildResourceIo() });

  const sources = [
    { project: PROJECT_A, agent: AGENT_ONE, content: "# A 内容\n", auth: "auth-a", hash: "hash-a" },
    { project: PROJECT_B, agent: AGENT_TWO, content: "# B 内容\n", auth: "auth-b", hash: "hash-b" },
  ] as const;

  for (const source of sources) {
    const absoluteSource = await writeResource(source.project, "docs/spec.md", source.content);
    await store.grantAuthorization({
      authorizationIdentifier: source.auth,
      sourceProjectIdentifier: source.project,
      sourceProjectRevision: 3,
      targetProjectIdentifier: PROJECT_C,
      targetProjectRevision: 1,
      operationKind: "import-copy",
      resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
      argumentsHash: source.hash,
      expiresAtIso: "2030-01-01T00:00:00.000Z",
      grantedByUserId: "user-1",
      taskIdentifier: "T-" + source.auth,
      receivingAgentInstanceId: source.agent,
    });
    const outcome = await service.importCopy({
      authorizationIdentifier: source.auth,
      sourceProjectIdentifier: source.project,
      targetProjectIdentifier: PROJECT_C,
      sourceResourcePath: "docs/spec.md",
      targetResourcePath: `docs/from-${source.project}.md`,
      absoluteSourcePath: absoluteSource,
      sourceProjectRootPath: path.join(baseDirectory, source.project),
      absoluteTargetPath: path.join(baseDirectory, PROJECT_C, `docs/from-${source.project}.md`),
      targetProjectRootPath: path.join(baseDirectory, PROJECT_C),
      sourceRevision: 3,
      contentHash: sha256Text(source.content),
      argumentsHash: source.hash,
      nowIso: "2026-10-19T00:00:00.000Z",
    });
    expect(String(outcome.outcome)).toContain("import");
  }
  return store;
}

describe("PROJECT-01-04：副本回执按个体过滤（不串数据）", () => {
  it("① list --agent：只返回该接收个体的副本，另一个个体不可见", async () => {
    await seedTwoAgentsCouples();
    stdoutText = "";
    const exitCode = await executeCrossProjectListCommand({
      stateDirectory: baseDirectory,
      isJsonOutput: true,
      receivingAgentInstanceId: AGENT_ONE,
    });
    expect(exitCode).toBe(0);

    const payload = JSON.parse(stdoutText) as {
      copyReceipts: {
        count: number;
        receipts: Array<{ sourceProjectIdentifier: string; receivingAgentInstanceId: string | null }>;
      };
    };
    expect(payload.copyReceipts.count).toBe(1);
    expect(payload.copyReceipts.receipts).toHaveLength(1);
    expect(payload.copyReceipts.receipts[0]?.sourceProjectIdentifier).toBe(PROJECT_A);
    expect(payload.copyReceipts.receipts[0]?.receivingAgentInstanceId).toBe(AGENT_ONE);
  });

  it("② 无过滤 ⇒ 两条副本都在，且各自带接收个体（可追溯）", async () => {
    await seedTwoAgentsCouples();
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const summary = await summarizeCopyReceipts({ store });
    expect(summary.count).toBe(2);
    const agents = summary.receipts
      .map((receipt) => receipt.receivingAgentInstanceId)
      .sort();
    expect(agents).toEqual([AGENT_ONE, AGENT_TWO]);
    // 人工可分辨副本与原件
    expect(summary.receipts.every((receipt) => receipt.isCopyOfExternalSource === true)).toBe(true);
    expect(summary.receipts.every((receipt) => receipt.isOriginal === false)).toBe(true);
  });

  it("③ 按来源项目过滤 ⇒ 只留下该来源的副本", async () => {
    await seedTwoAgentsCouples();
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const summary = await summarizeCopyReceipts({
      store,
      filter: { sourceProjectIdentifier: PROJECT_B },
    });
    expect(summary.count).toBe(1);
    expect(summary.receipts[0]?.sourceProjectIdentifier).toBe(PROJECT_B);
  });
});
