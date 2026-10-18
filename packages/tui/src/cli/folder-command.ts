/**
 * `folder`：对话式文件夹授权的 **CLI 侧共用入口**（FOLDER-01-03，2026-10-18 R15）。
 *
 * 产品文案（命令名 `folder request|approve|revoke|check`）经用户 2026-10-18 **确认＝选项 A**。
 *
 * ## 纪律（卡内 §1）
 *
 * - **同一实现**：判定走 `assessFolderGrantCandidate` / `buildFolderGrantCard`，
 *   落库与复检走 `FolderGrantStore` —— 不在 CLI 里另写一套规则；
 * - **一张卡只处理一个文件夹**：`request` 接受多个 `--path` 时输出**逐项队列**，
 *   每项一张卡（`isBatch:false`、`isDefaultApproved:false`），**不提供 `--approve-all`**；
 * - **request 只是预览**：绝不落库、绝不打印"已授权"；
 * - **approve 才是认证用户确认**：由用户亲自执行该命令 ⇒ `isHumanConfirmed:true`；
 * - **check 只读且 fail-closed**：拒绝即非 0 退出（不把失败显示成成功）；
 * - 卡片必须展示**完整绝对路径**、只读/读写、是否含子目录、期限（不用"访问全部"含糊措辞）。
 */
import {
  FolderGrantStore,
  assessFolderGrantCandidate,
  buildFolderGrantCard,
  type FolderGrantCandidateInput,
  type FolderGrantDurationKind,
  type FolderGrantPermissionKind,
  type ProjectRootRegistration,
} from "../../../core/src/public-sdk.js";
import { EXIT_CODES, logToStderr, printJson } from "./json-output.js";

/** 权限/期限的 argv 取值校验（未知值 ⇒ 用法错误，不做"猜一个"。） */
export function resolveFolderPermissionKind(
  rawPermission: string | undefined,
): FolderGrantPermissionKind | null {
  if (rawPermission === "read-only" || rawPermission === "read-write") return rawPermission;
  return null;
}

export function resolveFolderDurationKind(
  rawDuration: string | undefined,
): FolderGrantDurationKind | null {
  if (rawDuration === "session" || rawDuration === "until-revoked") return rawDuration;
  return null;
}

/** 解析 `--known-project-root <projectId>=<path>`（显式声明已知项目根，不猜测）。 */
export function parseKnownProjectRootSpecifications(
  rawSpecifications: ReadonlyArray<string> | undefined,
  fallbackProjectIdentifier: string,
): { readonly roots: ReadonlyArray<ProjectRootRegistration>; readonly invalidSpecifications: ReadonlyArray<string> } {
  if (rawSpecifications === undefined) return { roots: [], invalidSpecifications: [] };
  const roots: ProjectRootRegistration[] = [];
  const invalidSpecifications: string[] = [];
  for (const specification of rawSpecifications) {
    const separatorIndex = specification.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === specification.length - 1) {
      invalidSpecifications.push(specification);
      continue;
    }
    const maybeprojectIdentifier = specification.slice(0, separatorIndex).trim();
    const rootPath = specification.slice(separatorIndex + 1).trim();
    if (maybeprojectIdentifier === "" || rootPath === "") {
      invalidSpecifications.push(specification);
      continue;
    }
    roots.push({
      projectIdentifier: maybeprojectIdentifier || fallbackProjectIdentifier,
      rootPath,
    });
  }
  return { roots, invalidSpecifications };
}

/** 合并"从状态目录读到的本项目已批准根"与"调用方显式声明的项目根"（去重）。 */
export function mergeProjectRoots(
  loadedRoots: ReadonlyArray<ProjectRootRegistration>,
  declaredRoots: ReadonlyArray<ProjectRootRegistration>,
): ReadonlyArray<ProjectRootRegistration> {
  const merged: ProjectRootRegistration[] = [];
  for (const root of [...loadedRoots, ...declaredRoots]) {
    const isDuplicate = merged.some(
      (existing) =>
        existing.projectIdentifier === root.projectIdentifier &&
        existing.rootPath.replaceAll("\\", "/").toLowerCase() ===
          root.rootPath.replaceAll("\\", "/").toLowerCase(),
    );
    if (!isDuplicate) merged.push(root);
  }
  return merged;
}

/** `folder request` 输入（支持多个路径 ⇒ 逐项队列）。 */
export interface FolderRequestCommandInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly requestedPaths: ReadonlyArray<string>;
  readonly permissionKind: FolderGrantPermissionKind;
  readonly includesSubdirectories: boolean;
  readonly durationKind: FolderGrantDurationKind;
  /** 已登记的项目根（CLI 从状态目录读取；读不到时为空 ⇒ 判定层按"无登记"处理）。 */
  readonly registeredRoots: ReadonlyArray<ProjectRootRegistration>;
  readonly isJsonOutput: boolean;
}

/** 从状态目录读取项目根登记（只读；失败返回空列表，不伪造）。 */
export async function loadRegisteredProjectRoots(input: {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
}): Promise<ReadonlyArray<ProjectRootRegistration>> {
  try {
    const store = new FolderGrantStore({ baseDirectory: input.stateDirectory });
    // 授权集合里记录的 `normalizedRootPath` 也是"已批准根"的证据；项目根登记另由
    // `ProjectLocationRegistrationStore` 负责。CLI 只把**已批准授权根**当作已登记根，
    // 避免凭"未验证的路径"放行（宁可多问一次）。
    const collection = await store.read(input.projectIdentifier);
    if (collection.kind !== "valid") return [];
    return collection.collection.grants
      .filter((grant) => !grant.isRevoked)
      .map((grant) => ({
        projectIdentifier: grant.projectIdentifier,
        rootPath: grant.normalizedRootPath,
      }));
  } catch {
    return [];
  }
}

/** 执行 `folder request`：只产出授权卡（不落库）。返回进程退出码。 */
export async function executeFolderRequestCommand(
  input: FolderRequestCommandInput,
): Promise<number> {
  const cards = input.requestedPaths.map((requestedPath) => {
    const candidate: FolderGrantCandidateInput = {
      projectIdentifier: input.projectIdentifier,
      requestedPath,
      permissionKind: input.permissionKind,
      includesSubdirectories: input.includesSubdirectories,
      durationKind: input.durationKind,
      proposedBy: "user",
    };
    const assessment = assessFolderGrantCandidate({
      candidate,
      registeredRoots: input.registeredRoots,
    });
    return {
      requestedPath,
      classification: assessment.classification,
      isApprovalActionAvailable: assessment.isApprovalActionAvailable,
      requiredUserAction: assessment.requiredUserAction,
      reason: assessment.reason,
      card: buildFolderGrantCard({ candidate, assessment }),
    };
  });

  if (input.isJsonOutput) {
    printJson({ cards });
  } else {
    for (const entry of cards) {
      process.stdout.write(
        [
          `—— 文件夹授权卡（${entry.classification}）——`,
          `请求：将 ${entry.card.displayAbsolutePath} 加入项目 ${entry.card.projectIdentifier}`,
          `权限：${entry.card.permissionSummary}`,
          `原因：${entry.card.reason}`,
          `需要你做的：${entry.card.requiredUserAction}`,
          `可批准：${entry.isApprovalActionAvailable ? "是（仍需你亲自执行 approve）" : "否"}`,
          "",
        ].join("\n"),
      );
    }
    if (cards.length > 1) {
      process.stdout.write(
        `共 ${String(cards.length)} 项：逐项裁决（本命令不提供"全部批准"）。\n`,
      );
    }
  }

  const hasUnacceptable = cards.some((entry) => !entry.isApprovalActionAvailable);
  if (hasUnacceptable) {
    logToStderr("存在不可登记的候选（见上方原因）：本次**未**产生任何授权。");
    return EXIT_CODES.FAILURE;
  }
  return EXIT_CODES.SUCCESS;
}

/** `folder approve` 输入：**认证用户亲自执行**才代表确认。 */
export interface FolderApproveCommandInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly requestedPath: string;
  readonly permissionKind: FolderGrantPermissionKind;
  readonly includesSubdirectories: boolean;
  readonly durationKind: FolderGrantDurationKind;
  readonly grantIdentifier: string;
  readonly projectRevision: number;
  readonly expiresAtIso: string | null;
  readonly registeredRoots: ReadonlyArray<ProjectRootRegistration>;
  readonly isJsonOutput: boolean;
}

/** 执行 `folder approve`：落库一条授权。返回进程退出码。 */
export async function executeFolderApproveCommand(
  input: FolderApproveCommandInput,
): Promise<number> {
  const store = new FolderGrantStore({ baseDirectory: input.stateDirectory });
  const outcome = await store.issueGrant({
    candidate: {
      projectIdentifier: input.projectIdentifier,
      requestedPath: input.requestedPath,
      permissionKind: input.permissionKind,
      includesSubdirectories: input.includesSubdirectories,
      durationKind: input.durationKind,
      proposedBy: "user",
    },
    registeredRoots: input.registeredRoots,
    grantIdentifier: input.grantIdentifier,
    projectRevision: input.projectRevision,
    issuedAtIso: new Date().toISOString(),
    expiresAtIso: input.expiresAtIso,
    // CLI 的 approve 由认证用户亲自执行 ⇒ 视为人工确认（模型无法调用 argv）。
    isHumanConfirmed: true,
  });

  const payload = {
    outcomeKind: outcome.kind,
    grantIdentifier: "grant" in outcome ? outcome.grant.grantIdentifier : null,
    collectionRevision:
      "collection" in outcome ? outcome.collection.revision : null,
    reason: "reason" in outcome ? outcome.reason : "已登记授权。",
  };

  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      `授权登记：${payload.outcomeKind}${payload.grantIdentifier === null ? "" : `（${payload.grantIdentifier}）`}\n` +
        `集合 revision：${payload.collectionRevision === null ? "（无）" : String(payload.collectionRevision)}\n` +
        `说明：${payload.reason}\n`,
    );
  }

  return outcome.kind === "issued" || outcome.kind === "idempotent-replay"
    ? EXIT_CODES.SUCCESS
    : EXIT_CODES.FAILURE;
}

/** `folder revoke` 输入。 */
export interface FolderRevokeCommandInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly grantIdentifier: string;
  readonly reason: string;
  readonly isJsonOutput: boolean;
}

/** 执行 `folder revoke`：撤销只影响之后的复检（历史记录保留）。 */
export async function executeFolderRevokeCommand(
  input: FolderRevokeCommandInput,
): Promise<number> {
  const store = new FolderGrantStore({ baseDirectory: input.stateDirectory });
  const outcome = await store.revokeGrant({
    projectIdentifier: input.projectIdentifier,
    grantIdentifier: input.grantIdentifier,
    revokedAtIso: new Date().toISOString(),
    reason: input.reason,
  });

  const payload = {
    outcomeKind: outcome.kind,
    collectionRevision: outcome.kind === "revoked" ? outcome.collection.revision : null,
    reason: "reason" in outcome ? outcome.reason : "已撤销。",
  };
  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(`撤销：${payload.outcomeKind}\n说明：${payload.reason}\n`);
  }
  return outcome.kind === "revoked" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
}

/** `folder check` 输入：执行前复检（只读）。 */
export interface FolderCheckCommandInput {
  readonly stateDirectory: string;
  readonly projectIdentifier: string;
  readonly targetPath: string;
  readonly requiredPermission: FolderGrantPermissionKind;
  readonly projectRevision: number;
  readonly isJsonOutput: boolean;
}

/** 执行 `folder check`：**fail-closed**，拒绝即非 0 退出。 */
export async function executeFolderCheckCommand(
  input: FolderCheckCommandInput,
): Promise<number> {
  const store = new FolderGrantStore({ baseDirectory: input.stateDirectory });
  const decision = await store.evaluate({
    projectIdentifier: input.projectIdentifier,
    targetPath: input.targetPath,
    requiredPermission: input.requiredPermission,
    projectRevision: input.projectRevision,
    nowIso: new Date().toISOString(),
  });

  const payload =
    decision.outcome === "allowed"
      ? {
          outcome: "allowed" as const,
          grantIdentifier: decision.grantIdentifier,
          reason: decision.reason,
        }
      : {
          outcome: "denied" as const,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
        };

  if (input.isJsonOutput) {
    printJson(payload);
  } else {
    process.stdout.write(
      `复检：${payload.outcome === "allowed" ? "允许" : "拒绝"}\n` +
        `说明：${payload.reason}\n` +
        (payload.outcome === "denied" ? `原因码：${payload.reasonCode}\n` : ""),
    );
  }
  return decision.outcome === "allowed" ? EXIT_CODES.SUCCESS : EXIT_CODES.FAILURE;
}
