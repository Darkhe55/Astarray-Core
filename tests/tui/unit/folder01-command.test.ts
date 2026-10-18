/**
 * FOLDER-01-03（CLI 侧）的反例（2026-10-18 R15）：`folder request|approve|revoke|check`。
 *
 * 卡内验收：**共用同一实现**、**一张卡一个文件夹**、批量逐项、**路径/读写/期限可分辨**、
 * **未批准零新增权限**、撤销只影响之后、复检 fail-closed。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeFolderApproveCommand,
  executeFolderCheckCommand,
  executeFolderRequestCommand,
  executeFolderRevokeCommand,
  loadRegisteredProjectRoots,
  mergeProjectRoots,
  parseKnownProjectRootSpecifications,
  resolveFolderDurationKind,
  resolveFolderPermissionKind,
} from "../../../packages/tui/src/cli/folder-command.js";

let stateDirectory: string;
let stdoutText: string;
let stderrText: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-folder-cli-"));
  stdoutText = "";
  stderrText = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutText += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrText += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function readGrantsFile(projectIdentifier: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(stateDirectory, "folder-grants", `${projectIdentifier}.json`),
      "utf8",
    );
  } catch {
    return null;
  }
}

describe("FOLDER-01-03：folder CLI 共用入口（进程内）", () => {
  it("① request：输出授权卡（完整路径/只读·含子目录·期限），且**不落库**", async () => {
    const exitCode = await executeFolderRequestCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPaths: ["D:/Assets/Shared"],
      permissionKind: "read-only",
      includesSubdirectories: true,
      durationKind: "session",
      registeredRoots: [],
      isJsonOutput: false,
    });
    expect(exitCode).toBe(0);
    expect(stdoutText).toContain("D:/Assets/Shared");
    expect(stdoutText).toContain("只读 · 含子目录 · 仅本次会话");
    expect(stdoutText).toContain("approve");
    expect(await readGrantsFile("project-a")).toBeNull();
  });

  it("② request：多个 --path ⇒ 逐项卡片（每张 isBatch=false、无默认勾选、无'全部批准'）", async () => {
    const exitCode = await executeFolderRequestCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPaths: ["D:/Assets/One", "D:/Assets/Two"],
      permissionKind: "read-write",
      includesSubdirectories: false,
      durationKind: "until-revoked",
      registeredRoots: [],
      isJsonOutput: true,
    });
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdoutText) as {
      cards: Array<{ card: { isBatch: boolean; isDefaultApproved: boolean; permissionSummary: string } }>;
    };
    expect(payload.cards).toHaveLength(2);
    for (const entry of payload.cards) {
      expect(entry.card.isBatch).toBe(false);
      expect(entry.card.isDefaultApproved).toBe(false);
      expect(entry.card.permissionSummary).toBe("读写 · 不含子目录 · 直到撤销");
    }
    expect(stdoutText).not.toContain("全部批准");
    expect(stdoutText).not.toContain("approve-all");
  });

  it("③ request：不可登记的候选（相对路径/父目录）⇒ exit 1 且不落库", async () => {
    expect(
      await executeFolderRequestCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        requestedPaths: ["Assets/relative"],
        permissionKind: "read-only",
        includesSubdirectories: false,
        durationKind: "session",
        registeredRoots: [],
        isJsonOutput: false,
      }),
    ).toBe(1);

    expect(
      await executeFolderRequestCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        requestedPaths: ["D:/Work"],
        permissionKind: "read-only",
        includesSubdirectories: true,
        durationKind: "session",
        registeredRoots: [{ projectIdentifier: "project-a", rootPath: "D:/Work/ProjectA" }],
        isJsonOutput: false,
      }),
    ).toBe(1);
    expect(stderrText).toContain("产生任何授权");
    expect(await readGrantsFile("project-a")).toBeNull();
  });

  it("④ approve：落库一条授权（revision=1）；同参数重放 ⇒ 幂等且 revision 不变", async () => {
    const input = {
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPath: "D:/Assets/Shared",
      permissionKind: "read-only" as const,
      includesSubdirectories: true,
      durationKind: "session" as const,
      grantIdentifier: "grant-cli-1",
      projectRevision: 1,
      expiresAtIso: null,
      registeredRoots: [],
      isJsonOutput: true,
    };
    expect(await executeFolderApproveCommand(input)).toBe(0);
    const first = JSON.parse(stdoutText) as { outcomeKind: string; collectionRevision: number };
    expect(first.outcomeKind).toBe("issued");
    expect(first.collectionRevision).toBe(1);

    stdoutText = "";
    expect(await executeFolderApproveCommand(input)).toBe(0);
    const replay = JSON.parse(stdoutText) as { outcomeKind: string; collectionRevision: number };
    expect(replay.outcomeKind).toBe("idempotent-replay");
    expect(replay.collectionRevision).toBe(1);
  });

  it("⑤ approve：候选不可登记（相对路径）⇒ exit 1；陈旧 revision ⇒ exit 1", async () => {
    expect(
      await executeFolderApproveCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        requestedPath: "relative/path",
        permissionKind: "read-only",
        includesSubdirectories: false,
        durationKind: "session",
        grantIdentifier: "grant-x",
        projectRevision: 1,
        expiresAtIso: null,
        registeredRoots: [],
        isJsonOutput: false,
      }),
    ).toBe(1);

    await executeFolderApproveCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPath: "D:/Assets/Shared",
      permissionKind: "read-only",
      includesSubdirectories: false,
      durationKind: "session",
      grantIdentifier: "grant-y",
      projectRevision: 1,
      expiresAtIso: null,
      registeredRoots: [],
      isJsonOutput: true,
    });
    expect(
      await executeFolderApproveCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        requestedPath: "D:/Assets/Other",
        permissionKind: "read-only",
        includesSubdirectories: false,
        durationKind: "session",
        grantIdentifier: "grant-z",
        projectRevision: 0,
        expiresAtIso: null,
        registeredRoots: [],
        isJsonOutput: true,
      }),
    ).toBe(1);
  });

  it("⑥ check：已批准 ⇒ 0；未批准/只读写请求/撤销后 ⇒ 1（fail-closed）", async () => {
    expect(
      await executeFolderCheckCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        targetPath: "D:/Assets/Shared/file.txt",
        requiredPermission: "read-only",
        projectRevision: 1,
        isJsonOutput: false,
      }),
    ).toBe(1);

    await executeFolderApproveCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPath: "D:/Assets/Shared",
      permissionKind: "read-only",
      includesSubdirectories: true,
      durationKind: "session",
      grantIdentifier: "grant-1",
      projectRevision: 1,
      expiresAtIso: null,
      registeredRoots: [],
      isJsonOutput: true,
    });
    expect(
      await executeFolderCheckCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        targetPath: "D:/Assets/Shared/file.txt",
        requiredPermission: "read-only",
        projectRevision: 1,
        isJsonOutput: true,
      }),
    ).toBe(0);
    expect(
      await executeFolderCheckCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        targetPath: "D:/Assets/Shared/file.txt",
        requiredPermission: "read-write",
        projectRevision: 1,
        isJsonOutput: true,
      }),
    ).toBe(1);
  });

  it("⑦ revoke：撤销后复检拒绝（revoked），且记录保留", async () => {
    await executeFolderApproveCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPath: "D:/Assets/Shared",
      permissionKind: "read-only",
      includesSubdirectories: true,
      durationKind: "session",
      grantIdentifier: "grant-1",
      projectRevision: 1,
      expiresAtIso: null,
      registeredRoots: [],
      isJsonOutput: true,
    });
    expect(
      await executeFolderRevokeCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        grantIdentifier: "grant-1",
        reason: "用户撤销",
        isJsonOutput: true,
      }),
    ).toBe(0);

    expect(
      await executeFolderCheckCommand({
        stateDirectory,
        projectIdentifier: "project-a",
        targetPath: "D:/Assets/Shared/file.txt",
        requiredPermission: "read-only",
        projectRevision: 1,
        isJsonOutput: true,
      }),
    ).toBe(1);
    const raw = await readGrantsFile("project-a");
    expect(raw).toContain("用户撤销");
    expect(raw).toContain("\"isRevoked\": true");
  });

  it("⑧ loadRegisteredProjectRoots：只返回未撤销的已批准根；读不到 ⇒ 空", async () => {
    expect(
      await loadRegisteredProjectRoots({ stateDirectory, projectIdentifier: "project-a" }),
    ).toEqual([]);
    await executeFolderApproveCommand({
      stateDirectory,
      projectIdentifier: "project-a",
      requestedPath: "D:/Assets/Shared",
      permissionKind: "read-only",
      includesSubdirectories: true,
      durationKind: "session",
      grantIdentifier: "grant-1",
      projectRevision: 1,
      expiresAtIso: null,
      registeredRoots: [],
      isJsonOutput: true,
    });
    const roots = await loadRegisteredProjectRoots({ stateDirectory, projectIdentifier: "project-a" });
    expect(roots).toHaveLength(1);
    expect(roots[0]?.rootPath).toBe("d:/assets/shared");
  });

  it("⑨ 显式项目根解析与合并：非法规格被报告、重复项去重", () => {
    const parsed = parseKnownProjectRootSpecifications(
      ["project-b=D:/Work/ProjectB", "broken", "=D:/NoId", "project-c="],
      "project-a",
    );
    expect(parsed.roots).toHaveLength(1);
    expect(parsed.roots[0]).toEqual({
      projectIdentifier: "project-b",
      rootPath: "D:/Work/ProjectB",
    });
    expect(parsed.invalidSpecifications).toEqual(["broken", "=D:/NoId", "project-c="]);

    const merged = mergeProjectRoots(
      [{ projectIdentifier: "project-a", rootPath: "D:/Work/ProjectA" }],
      [
        { projectIdentifier: "project-a", rootPath: "d:/work/projecta" },
        { projectIdentifier: "project-b", rootPath: "D:/Work/ProjectB" },
      ],
    );
    expect(merged).toHaveLength(2);
  });

  it("⑩ 取值校验：权限/期限只接受固定枚举（未知值不猜）", () => {
    expect(resolveFolderPermissionKind("read-only")).toBe("read-only");
    expect(resolveFolderPermissionKind("read-write")).toBe("read-write");
    expect(resolveFolderPermissionKind("full-access")).toBeNull();
    expect(resolveFolderPermissionKind(undefined)).toBeNull();
    expect(resolveFolderDurationKind("session")).toBe("session");
    expect(resolveFolderDurationKind("until-revoked")).toBe("until-revoked");
    expect(resolveFolderDurationKind("forever")).toBeNull();
  });
});
