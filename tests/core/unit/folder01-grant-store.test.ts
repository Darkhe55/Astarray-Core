/**
 * FOLDER-01-02 的反例（2026-10-18 R4）：根登记事务与**执行前复检**。
 *
 * 卡内要点：授权绑定项目/路径/权限/revision，**原子更新 + 自动备份**；
 * **重放同请求不重复登记**、**同 ID 异参拒绝**；撤销只影响之后的操作；
 * 执行前复检必须 fail-closed。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { FolderGrantStore } from "../../../packages/core/src/orchestration/folder-grant-store.js";
import type {
  FolderGrantCandidateInput,
  ProjectRootRegistration,
} from "../../../packages/core/src/orchestration/folder-grant-request.js";

const registeredRoots: ReadonlyArray<ProjectRootRegistration> = [
  { projectIdentifier: "project-a", rootPath: "D:/Work/ProjectA" },
];

let baseDirectory: string;
let store: FolderGrantStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-folder-grants-"));
  store = new FolderGrantStore({ baseDirectory });
});

function candidate(overrides: Partial<FolderGrantCandidateInput> = {}): FolderGrantCandidateInput {
  return {
    projectIdentifier: "project-a",
    requestedPath: "D:/Assets/Shared",
    permissionKind: "read-only",
    includesSubdirectories: true,
    durationKind: "session",
    proposedBy: "model",
    ...overrides,
  };
}

const issuedAtIso = "2026-10-18T00:00:00.000Z";

async function issueDefault(overrides: Record<string, unknown> = {}) {
  return await store.issueGrant({
    candidate: candidate(),
    registeredRoots,
    grantIdentifier: "grant-1",
    projectRevision: 1,
    issuedAtIso,
    isHumanConfirmed: true,
    ...overrides,
  });
}

describe("FOLDER-01-02：根登记事务与执行前复检", () => {
  it("① 未登记 ⇒ 执行前复检一律 denied（零新增权限）", async () => {
    const decision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(decision.outcome).toBe("denied");
    if (decision.outcome !== "denied") throw new Error("应为 denied");
    expect(decision.reasonCode).toBe("no-grant");
  });

  it("② 未获认证用户确认 ⇒ 拒绝落库（模型不能签字）", async () => {
    const outcome = await issueDefault({ isHumanConfirmed: false });
    expect(outcome.kind).toBe("rejected");
    expect(await store.read("project-a")).toMatchObject({ kind: "absent" });
  });

  it("③ 候选本身不可登记（父目录）⇒ 拒绝，且不写文件", async () => {
    const outcome = await issueDefault({ candidate: candidate({ requestedPath: "D:/" }) });
    expect(outcome.kind).toBe("rejected");
    expect(await store.read("project-a")).toMatchObject({ kind: "absent" });
  });

  it("④ 正常签发 ⇒ revision 递增、记录字段齐全、**写前备份**", async () => {
    const outcome = await issueDefault();
    expect(outcome.kind).toBe("issued");
    if (outcome.kind !== "issued") throw new Error("应为 issued");
    expect(outcome.collection.revision).toBe(1);
    expect(outcome.grant.normalizedRootPath).toBe("d:/assets/shared");
    expect(outcome.grant.permissionKind).toBe("read-only");
    expect(outcome.grant.projectRevision).toBe(1);
    expect(outcome.grant.isRevoked).toBe(false);

    // 第二次签发 ⇒ 有备份文件
    const second = await issueDefault({
      candidate: candidate({ requestedPath: "D:/Assets/Second" }),
      grantIdentifier: "grant-2",
    });
    expect(second.kind).toBe("issued");
    const backups = await fs.readdir(path.join(baseDirectory, "folder-grants-backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain("backup-r");
  });

  it("⑤ 幂等重放 ⇒ idempotent-replay，revision 不增", async () => {
    const first = await issueDefault();
    expect(first.kind).toBe("issued");
    const replay = await issueDefault();
    expect(replay.kind).toBe("idempotent-replay");
    if (replay.kind !== "idempotent-replay") throw new Error("应为幂等重放");
    expect(replay.collection.revision).toBe(1);
    expect(replay.reason).toContain("幂等");
  });

  it("⑥ 同 grantIdentifier 异参 ⇒ conflict（不覆盖既有授权）", async () => {
    await issueDefault();
    const conflict = await issueDefault({
      candidate: candidate({ requestedPath: "D:/Assets/Other" }),
    });
    expect(conflict.kind).toBe("conflict");

    const current = await store.read("project-a");
    if (current.kind !== "valid") throw new Error("应为 valid");
    expect(current.collection.grants).toHaveLength(1);
    expect(current.collection.grants[0]?.normalizedRootPath).toBe("d:/assets/shared");
  });

  it("⑦ 陈旧 revision ⇒ stale-revision（拒绝陈旧写入）", async () => {
    await issueDefault();
    const stale = await issueDefault({
      candidate: candidate({ requestedPath: "D:/Assets/Other" }),
      grantIdentifier: "grant-3",
      projectRevision: 0,
    });
    expect(stale.kind).toBe("stale-revision");
  });

  it("⑧ 已授权 ⇒ allowed；只读授权不能执行写操作", async () => {
    await issueDefault();
    const readDecision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(readDecision.outcome).toBe("allowed");
    if (readDecision.outcome !== "allowed") throw new Error("应为 allowed");
    expect(readDecision.grantIdentifier).toBe("grant-1");

    const writeDecision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-write",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(writeDecision.outcome).toBe("denied");
    if (writeDecision.outcome !== "denied") throw new Error("应为 denied");
    expect(writeDecision.reasonCode).toBe("permission-not-granted");
  });

  it("⑨ 不含子目录 ⇒ 子目录目标 denied，但根自身放行；逐段边界不误判", async () => {
    await issueDefault({
      candidate: candidate({ includesSubdirectories: false }),
    });
    const subdirectoryDecision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/nested/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(subdirectoryDecision.outcome).toBe("denied");
    if (subdirectoryDecision.outcome !== "denied") throw new Error("应为 denied");
    expect(subdirectoryDecision.reasonCode).toBe("subdirectories-not-granted");

    const rootDecision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(rootDecision.outcome).toBe("allowed");

    // `Shared-extra` 不属于 `Shared`（禁止字符串前缀）
    const siblingDecision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared-extra/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(siblingDecision.outcome).toBe("denied");
  });

  it("⑩ 撤销 ⇒ 之后的复检 denied(revoked)，且历史记录保留", async () => {
    await issueDefault();
    const revokeOutcome = await store.revokeGrant({
      projectIdentifier: "project-a",
      grantIdentifier: "grant-1",
      revokedAtIso: "2026-10-18T01:00:00.000Z",
      reason: "用户撤销",
    });
    expect(revokeOutcome.kind).toBe("revoked");

    const decision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: "2026-10-18T02:00:00.000Z",
    });
    expect(decision.outcome).toBe("denied");
    if (decision.outcome !== "denied") throw new Error("应为 denied");
    expect(decision.reasonCode).toBe("revoked");

    const current = await store.read("project-a");
    if (current.kind !== "valid") throw new Error("应为 valid");
    expect(current.collection.grants[0]?.isRevoked).toBe(true);
    expect(current.collection.grants[0]?.revokeReason).toBe("用户撤销");
  });

  it("⑪ 过期 ⇒ expired；项目 revision 前进 ⇒ stale-project-revision", async () => {
    const sessionGrant = await store.issueGrant({
      candidate: candidate({ durationKind: "until-revoked" }),
      registeredRoots,
      grantIdentifier: "grant-expiring",
      projectRevision: 1,
      issuedAtIso,
      expiresAtIso: "2026-10-18T00:30:00.000Z",
      isHumanConfirmed: true,
    });
    expect(sessionGrant.kind).toBe("issued");

    const expired = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: "2026-10-18T01:00:00.000Z",
    });
    expect(expired.outcome).toBe("denied");
    if (expired.outcome !== "denied") throw new Error("应为 denied");
    expect(expired.reasonCode).toBe("expired");

    const revisionChanged = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 2,
      nowIso: "2026-10-18T00:10:00.000Z",
    });
    expect(revisionChanged.outcome).toBe("denied");
    if (revisionChanged.outcome !== "denied") throw new Error("应为 denied");
    expect(revisionChanged.reasonCode).toBe("stale-project-revision");
  });

  it("⑫ 损坏的授权集合 ⇒ 复检 denied、签发拒绝覆盖（不按空集合放行）", async () => {
    const grantsDirectory = path.join(baseDirectory, "folder-grants");
    await fs.mkdir(grantsDirectory, { recursive: true });
    await fs.writeFile(path.join(grantsDirectory, "project-a.json"), "{broken", "utf8");

    const decision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(decision.outcome).toBe("denied");

    const issueOutcome = await issueDefault();
    expect(issueOutcome.kind).toBe("rejected");
    const raw = await fs.readFile(path.join(grantsDirectory, "project-a.json"), "utf8");
    expect(raw).toBe("{broken");
  });

  it("⑬ 重启（新实例）读回后仍可复检（持久化真的生效）", async () => {
    await issueDefault();
    const restarted = new FolderGrantStore({ baseDirectory });
    const decision = await restarted.evaluate({
      projectIdentifier: "project-a",
      targetPath: "D:/Assets/Shared/deep/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(decision.outcome).toBe("allowed");
  });

  it("⑭ 非绝对路径 ⇒ denied(not-absolute)（不猜当前目录）", async () => {
    await issueDefault();
    const decision = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: "Assets/Shared/file.txt",
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: issuedAtIso,
    });
    expect(decision.outcome).toBe("denied");
    if (decision.outcome !== "denied") throw new Error("应为 denied");
    expect(decision.reasonCode).toBe("not-absolute");
  });
});
