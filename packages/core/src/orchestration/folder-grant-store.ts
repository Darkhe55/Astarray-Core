/**
 * FOLDER-01-02（CLIENT-01，2026-10-18 R4）：文件夹授权的**根登记事务与执行前复检**。
 *
 * 卡内依据（`docs/tasks/CLIENT01_FOLDER_GRANTS_SECRETARY_AND_ONBOARDING_TASK_CARDS.md` §1）：
 * - 「授权绑定用户、项目、路径/范围、权限、有效期和 **revision**，控制面**原子更新**；
 *   **执行前复检**，变更时失效相关旧许可/缓存」；
 * - 「根集合更新前**自动备份**配置，**重放同请求不重复登记**，**同 ID 异参拒绝**」；
 * - 「正在执行的工具按安全点对账，**不能假装已即时撤销**已发生副作用」
 *   ⇒ 撤销只影响**之后**的 `evaluate()`，不改写历史；
 * - 「模型仍受当前模式/角色权限上限；目录许可也**不代替**安装/外部软件/具体操作授权」
 *   ⇒ 本模块只回答"该目录 + 该权限是否被登记批准"，不产生任何工具/安装授权。
 *
 * ## 边界
 * - 只做**本地确定性**判定与持久化；不解析符号链接（由上层在 `resolvedRealPath` 里给）。
 * - 只读/读写是**目录许可**，不提升 Agent 模式上限（调用方仍须叠加模式/角色判定）。
 * - 持久化走白名单原子写（`infra/atomic-json`）：写前备份、坏文件**拒绝覆盖**。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { backupExistingFile, writeAtomicJson } from "../infra/atomic-json.js";
import {
  assessFolderGrantCandidate,
  isPathInsideOrEqual,
  normalizeFolderPathForComparison,
  type FolderGrantCandidateInput,
  type FolderGrantDurationKind,
  type FolderGrantPermissionKind,
  type ProjectRootRegistration,
} from "./folder-grant-request.js";

/** 一条授权记录（v1）。 */
export interface FolderGrantRecordV1 {
  readonly schemaVersion: 1;
  readonly grantIdentifier: string;
  readonly projectIdentifier: string;
  /** 规范化后的根（比较口径，见 `normalizeFolderPathForComparison`）。 */
  readonly normalizedRootPath: string;
  readonly permissionKind: FolderGrantPermissionKind;
  readonly includesSubdirectories: boolean;
  readonly durationKind: FolderGrantDurationKind;
  readonly issuedAtIso: string;
  /** `null` = 直到撤销。 */
  readonly expiresAtIso: string | null;
  /** 登记时的项目 revision（来源变更后旧许可失效）。 */
  readonly projectRevision: number;
  readonly isRevoked: boolean;
  readonly revokedAtIso: string | null;
  readonly revokeReason: string | null;
  /** 请求指纹（幂等判据）。 */
  readonly requestFingerprint: string;
  /** 提出方（审计用；`model` 也应只在用户确认后才落库）。 */
  readonly proposedBy: "model" | "user";
}

/** 一个项目的授权集合（单文件）。 */
export interface FolderGrantCollectionV1 {
  readonly schemaVersion: 1;
  readonly projectIdentifier: string;
  /** 集合自身 revision（每次变更 +1）。 */
  readonly revision: number;
  readonly grants: ReadonlyArray<FolderGrantRecordV1>;
}

/** 读取结论。 */
export type FolderGrantReadOutcome =
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "valid"; readonly collection: FolderGrantCollectionV1 };

/** 签发结论。 */
export type FolderGrantIssueOutcome =
  | {
      readonly kind: "issued";
      readonly collection: FolderGrantCollectionV1;
      readonly grant: FolderGrantRecordV1;
    }
  | {
      readonly kind: "idempotent-replay";
      readonly collection: FolderGrantCollectionV1;
      readonly grant: FolderGrantRecordV1;
      readonly reason: string;
    }
  | { readonly kind: "conflict"; readonly reason: string }
  | { readonly kind: "stale-revision"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

/** 执行前复检结论（`denied` 一律 fail-closed）。 */
export type FolderGrantDecision =
  | { readonly outcome: "allowed"; readonly grantIdentifier: string; readonly reason: string }
  | {
      readonly outcome: "denied";
      readonly reasonCode:
        | "no-grant"
        | "revoked"
        | "expired"
        | "stale-project-revision"
        | "outside-granted-root"
        | "subdirectories-not-granted"
        | "permission-not-granted"
        | "not-absolute";
      readonly reason: string;
    };

const GRANT_SCHEMA_VERSION = 1;

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return sanitized === "" ? "unnamed" : sanitized;
}

function isPermissionAllowed(
  granted: FolderGrantPermissionKind,
  required: FolderGrantPermissionKind,
): boolean {
  if (granted === "read-write") return true;
  return required === "read-only";
}

function computeRequestFingerprint(input: {
  readonly normalizedRootPath: string;
  readonly permissionKind: string;
  readonly includesSubdirectories: boolean;
  readonly durationKind: string;
  readonly expiresAtIso: string | null;
  readonly projectRevision: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.normalizedRootPath,
        input.permissionKind,
        input.includesSubdirectories,
        input.durationKind,
        input.expiresAtIso,
        input.projectRevision,
      ]),
    )
    .digest("hex");
}

/** 文件夹授权的**登记存储与执行前复检**。 */
export class FolderGrantStore {
  private readonly baseDirectory: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.baseDirectory = options.baseDirectory;
  }

  private collectionFilePath(projectIdentifier: string): string {
    return path.join(
      this.baseDirectory,
      "folder-grants",
      `${sanitizePathSegment(projectIdentifier)}.json`,
    );
  }

  /** 读取某项目的授权集合；坏文件**如实报 invalid**（调用方必须 fail-closed）。 */
  async read(projectIdentifier: string): Promise<FolderGrantReadOutcome> {
    let rawContent: string;
    try {
      rawContent = await fs.readFile(this.collectionFilePath(projectIdentifier), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent", reason: "该项目尚未登记任何文件夹授权。" };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { kind: "invalid", reason: "授权集合不是合法 JSON；拒绝按空集合解释。" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "invalid", reason: "授权集合不是对象。" };
    }
    const record = parsed as Record<string, unknown>;
    if (record["schemaVersion"] !== GRANT_SCHEMA_VERSION) {
      return { kind: "invalid", reason: "不认识的授权集合版本；拒绝按 v1 解释。" };
    }
    if (typeof record["projectIdentifier"] !== "string" || !Array.isArray(record["grants"])) {
      return { kind: "invalid", reason: "授权集合缺少 projectIdentifier/grants。" };
    }
    return { kind: "valid", collection: parsed as FolderGrantCollectionV1 };
  }

  /**
   * 签发授权：**先评估再落库**。
   *
   * - 评估结论不是 `acceptable` ⇒ `rejected`（模型提出的候选也必须先通过 FOLDER-01-01 判定）；
   * - `humanConfirmed !== true` ⇒ `rejected`（模型转述不是签字）；
   * - 同请求指纹重放 ⇒ `idempotent-replay`（**不**增加 revision、不重复登记）；
   * - 同 grantIdentifier 异参 ⇒ `conflict`；
   * - `projectRevision` 低于集合已知 revision ⇒ `stale-revision`（陈旧写入拒绝）。
   */
  async issueGrant(input: {
    readonly candidate: FolderGrantCandidateInput;
    readonly registeredRoots: ReadonlyArray<ProjectRootRegistration>;
    readonly grantIdentifier: string;
    readonly projectRevision: number;
    readonly issuedAtIso: string;
    readonly expiresAtIso?: string | null;
    readonly isHumanConfirmed: boolean;
  }): Promise<FolderGrantIssueOutcome> {
    const assessment = assessFolderGrantCandidate({
      candidate: input.candidate,
      registeredRoots: input.registeredRoots,
    });
    if (assessment.classification !== "acceptable" || assessment.normalizedPath === null) {
      return {
        kind: "rejected",
        reason: `候选不可登记（${assessment.classification}）：${assessment.reason}`,
      };
    }
    if (!input.isHumanConfirmed) {
      return { kind: "rejected", reason: "未经认证用户确认：模型候选不能自行落库。" };
    }

    const current = await this.read(input.candidate.projectIdentifier);
    if (current.kind === "invalid") {
      return { kind: "rejected", reason: `授权集合已损坏，拒绝覆盖：${current.reason}` };
    }
    const existingCollection: FolderGrantCollectionV1 =
      current.kind === "valid"
        ? current.collection
        : {
            schemaVersion: GRANT_SCHEMA_VERSION,
            projectIdentifier: input.candidate.projectIdentifier,
            revision: 0,
            grants: [],
          };

    if (input.projectRevision < existingCollection.revision) {
      return {
        kind: "stale-revision",
        reason: `项目 revision 陈旧（现有 ${String(existingCollection.revision)}，请求 ${String(input.projectRevision)}）。`,
      };
    }

    const normalizedRootPath = assessment.normalizedPath.comparisonPath;
    const expiresAtIso = input.expiresAtIso ?? null;
    const requestFingerprint = computeRequestFingerprint({
      normalizedRootPath,
      permissionKind: input.candidate.permissionKind,
      includesSubdirectories: input.candidate.includesSubdirectories,
      durationKind: input.candidate.durationKind,
      expiresAtIso,
      projectRevision: input.projectRevision,
    });

    const replayed = existingCollection.grants.find(
      (grant) => grant.requestFingerprint === requestFingerprint && !grant.isRevoked,
    );
    if (replayed !== undefined) {
      return {
        kind: "idempotent-replay",
        collection: existingCollection,
        grant: replayed,
        reason: "同一请求已登记（幂等重放），未重复写入。",
      };
    }

    const sameIdentifier = existingCollection.grants.find(
      (grant) => grant.grantIdentifier === input.grantIdentifier,
    );
    if (sameIdentifier !== undefined && sameIdentifier.requestFingerprint !== requestFingerprint) {
      return {
        kind: "conflict",
        reason: "同一 grantIdentifier 但参数不同：拒绝覆盖既有授权。",
      };
    }

    const nextGrant: FolderGrantRecordV1 = {
      schemaVersion: GRANT_SCHEMA_VERSION,
      grantIdentifier: input.grantIdentifier,
      projectIdentifier: input.candidate.projectIdentifier,
      normalizedRootPath,
      permissionKind: input.candidate.permissionKind as FolderGrantPermissionKind,
      includesSubdirectories: input.candidate.includesSubdirectories,
      durationKind: input.candidate.durationKind as FolderGrantDurationKind,
      issuedAtIso: input.issuedAtIso,
      expiresAtIso,
      projectRevision: input.projectRevision,
      isRevoked: false,
      revokedAtIso: null,
      revokeReason: null,
      requestFingerprint,
      proposedBy: input.candidate.proposedBy,
    };

    const nextCollection: FolderGrantCollectionV1 = {
      schemaVersion: GRANT_SCHEMA_VERSION,
      projectIdentifier: existingCollection.projectIdentifier,
      revision: existingCollection.revision + 1,
      grants: [...existingCollection.grants, nextGrant],
    };

    await this.persist(input.candidate.projectIdentifier, nextCollection);
    return { kind: "issued", collection: nextCollection, grant: nextGrant };
  }

  /**
   * 撤销一条授权：**只影响之后的复检**。
   *
   * 卡内「不能假装已即时撤销已发生副作用」⇒ 记录保留为历史（`isRevoked` + 原因 + 时间），
   * 不做物理删除；已在执行的工具由调用方按安全点对账。
   */
  async revokeGrant(input: {
    readonly projectIdentifier: string;
    readonly grantIdentifier: string;
    readonly revokedAtIso: string;
    readonly reason: string;
  }): Promise<
    | { readonly kind: "revoked"; readonly collection: FolderGrantCollectionV1 }
    | { readonly kind: "not-found"; readonly reason: string }
    | { readonly kind: "rejected"; readonly reason: string }
  > {
    const current = await this.read(input.projectIdentifier);
    if (current.kind !== "valid") {
      return { kind: "not-found", reason: current.reason };
    }
    const target = current.collection.grants.find(
      (grant) => grant.grantIdentifier === input.grantIdentifier,
    );
    if (target === undefined) {
      return { kind: "not-found", reason: "找不到该授权标识。" };
    }
    const nextCollection: FolderGrantCollectionV1 = {
      schemaVersion: GRANT_SCHEMA_VERSION,
      projectIdentifier: current.collection.projectIdentifier,
      revision: current.collection.revision + 1,
      grants: current.collection.grants.map((grant) =>
        grant.grantIdentifier === input.grantIdentifier
          ? {
              ...grant,
              isRevoked: true,
              revokedAtIso: input.revokedAtIso,
              revokeReason: input.reason,
            }
          : grant,
      ),
    };
    await this.persist(input.projectIdentifier, nextCollection);
    return { kind: "revoked", collection: nextCollection };
  }

  /**
   * **执行前复检**（工具真正执行前必须调用）。
   *
   * 次序（先安全）：
   * 1. 目标路径非法 ⇒ `not-absolute`；
   * 2. 集合不可读/不存在 ⇒ `no-grant`；
   * 3. 授权已撤销 ⇒ `revoked`；已过期 ⇒ `expired`；
   * 4. 项目 revision 前进 ⇒ `stale-project-revision`（旧许可失效）；
   * 5. 目标不在授权根内 ⇒ `outside-granted-root`；
   * 6. 未授权子目录且目标在子目录层 ⇒ `subdirectories-not-granted`；
   * 7. 权限不足（只读授权不能写）⇒ `permission-not-granted`；
   * 8. 全部通过 ⇒ `allowed`（**仍不代替**模式/角色/安装授权）。
   */
  async evaluate(input: {
    readonly projectIdentifier: string;
    readonly targetPath: string;
    readonly requiredPermission: FolderGrantPermissionKind;
    readonly projectRevision: number;
    readonly nowIso: string;
  }): Promise<FolderGrantDecision> {
    const normalizedTarget = normalizeFolderPathForComparison(input.targetPath);
    if (!normalizedTarget.isAbsolute) {
      return {
        outcome: "denied",
        reasonCode: "not-absolute",
        reason: "目标路径不是绝对路径；无法与授权根比较。",
      };
    }

    const current = await this.read(input.projectIdentifier);
    if (current.kind !== "valid") {
      return {
        outcome: "denied",
        reasonCode: "no-grant",
        reason: current.kind === "absent" ? "该项目没有任何文件夹授权。" : current.reason,
      };
    }

    const candidates = current.collection.grants.filter(
      (grant) => !grant.isRevoked && isPathInsideOrEqual(normalizedTarget.comparisonPath, grant.normalizedRootPath),
    );
    if (candidates.length === 0) {
      const revokedAtRoot = current.collection.grants.some(
        (grant) => grant.isRevoked && isPathInsideOrEqual(normalizedTarget.comparisonPath, grant.normalizedRootPath),
      );
      return revokedAtRoot
        ? {
            outcome: "denied",
            reasonCode: "revoked",
            reason: "该路径的授权已被撤销（撤销只影响之后的操作）。",
          }
        : {
            outcome: "denied",
            reasonCode: "outside-granted-root",
            reason: "目标不在任何已批准的授权根内。",
          };
    }

    const isExpired = (grant: FolderGrantRecordV1): boolean =>
      grant.expiresAtIso !== null && Date.parse(grant.expiresAtIso) <= Date.parse(input.nowIso);

    const usable = candidates.filter((grant) => !isExpired(grant));
    if (usable.length === 0) {
      return { outcome: "denied", reasonCode: "expired", reason: "授权已过期。" };
    }

    const revisionMatched = usable.filter(
      (grant) => grant.projectRevision === input.projectRevision,
    );
    if (revisionMatched.length === 0) {
      return {
        outcome: "denied",
        reasonCode: "stale-project-revision",
        reason: "项目 revision 已变化；旧许可失效，需重新确认。",
      };
    }

    const subdirectoryAllowed = revisionMatched.filter(
      (grant) =>
        grant.includesSubdirectories ||
        normalizedTarget.comparisonPath === grant.normalizedRootPath,
    );
    if (subdirectoryAllowed.length === 0) {
      return {
        outcome: "denied",
        reasonCode: "subdirectories-not-granted",
        reason: "授权不含子目录，而目标位于子目录。",
      };
    }

    const permissionAllowed = subdirectoryAllowed.filter((grant) =>
      isPermissionAllowed(grant.permissionKind, input.requiredPermission),
    );
    if (permissionAllowed.length === 0) {
      return {
        outcome: "denied",
        reasonCode: "permission-not-granted",
        reason: "授权权限不足（只读授权不能执行写操作）。",
      };
    }

    const chosen = permissionAllowed[0];
    if (chosen === undefined) {
      return { outcome: "denied", reasonCode: "no-grant", reason: "无可用授权。" };
    }
    return {
      outcome: "allowed",
      grantIdentifier: chosen.grantIdentifier,
      reason: `命中授权 ${chosen.grantIdentifier}（${chosen.permissionKind}）。注意：目录许可不代替模式/角色/安装授权。`,
    };
  }

  /** 原子写：先备份旧文件，再 `writeAtomicJson`（坏文件在上层已被拒绝，不会走到这里）。 */
  private async persist(
    projectIdentifier: string,
    collection: FolderGrantCollectionV1,
  ): Promise<void> {
    const filePath = this.collectionFilePath(projectIdentifier);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.access(filePath);
      const backupDirectoryPath = path.join(this.baseDirectory, "folder-grants-backups");
      await fs.mkdir(backupDirectoryPath, { recursive: true });
      await backupExistingFile(
        filePath,
        path.join(
          backupDirectoryPath,
          `${sanitizePathSegment(projectIdentifier)}.backup-r${String(collection.revision)}.json`,
        ),
      );
    } catch {
      // 首次写入没有旧文件 ⇒ 不需要备份
    }
    await writeAtomicJson(filePath, collection);
  }
}
