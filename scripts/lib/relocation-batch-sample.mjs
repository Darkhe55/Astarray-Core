/**
 * RELOCATE 批量对账的**脱敏样例**与判定逻辑（纯函数，可单测）。
 *
 * 背景：卡内要求"**真实历史库上的批量解析**"证据。用户 2026-10-19 批准**用脱敏样例**验证。
 *
 * 纪律：
 * - 样例路径全部是**虚构**的（`/sample/projects/...`），不含任何本机用户名、真实盘符或凭据；
 * - 判定必须 **fail-closed**：缺字段/数量过少 ⇒ 判失败（防空转），沿用
 *   `toolkit01-package-checks.mjs` / `contract-sdk-checks.mjs` 的既有教训；
 * - 每个项目都覆盖一类**必须被拦**的情形，避免"只验 happy path"。
 */

/** 判定条数下限（少于此数视为脚本退化）。 */
export const MINIMUM_RELOCATION_BATCH_CHECK_COUNT = 10;

/**
 * 构造**脱敏**历史样例：3 个项目（alpha/beta/gamma）× 每个多条引用与未决操作。
 *
 * 覆盖：正常改写、已在新根（不改写）、旧根外、`..` 逃逸、另一种设备、种类未声明、
 * 嵌套旧根歧义、已完成操作（不重放）、旧一次性许可、临时提升、未知非幂等副作用、含写项目。
 */
export function buildSanitizedRelocationSample() {
  return {
    sampleIdentifier: "sanitized-relocation-sample-v1",
    // 说明用：本样例不含任何真实用户数据
    isSanitized: true,
    projects: [
      {
        projectIdentifier: "alpha",
        projectStatus: "in-progress",
        deviceIdentifier: "sample-device-1",
        locationMappings: [
          {
            projectIdentifier: "alpha",
            deviceIdentifier: "sample-device-1",
            fromLocationRevision: 4,
            oldRootPath: "/sample/projects/alpha-old",
            newRootPath: "/sample/projects/alpha-new",
          },
        ],
        declaredStructuredResourceKinds: ["document"],
        hasWriteOrExternalSideEffects: false,
        references: [
          {
            referenceIdentifier: "alpha-rewrite",
            resourceKind: "document",
            requestedPath: "/sample/projects/alpha-old/docs/spec.md",
            owningProjectIdentifier: "alpha",
            owningDeviceIdentifier: "sample-device-1",
            capturedLocationRevision: 3,
          },
          {
            referenceIdentifier: "alpha-already-new",
            resourceKind: "document",
            requestedPath: "/sample/projects/alpha-new/docs/plan.md",
            owningProjectIdentifier: "alpha",
            owningDeviceIdentifier: "sample-device-1",
            capturedLocationRevision: 5,
          },
        ],
        pendingOperations: [
          {

            operation: {

              operationIdentifier: "alpha-op-idempotent",

              isCompleted: false,

              isIdempotent: true,

              hasUnknownSideEffect: false,

            },

            hasCurrentPermissionAtNewLocation: true,

            reliesOnPreviousOneTimeGrant: false,

            reliesOnTemporaryEscalation: false,

          },
          {

            operation: {

              operationIdentifier: "alpha-op-done",

              isCompleted: true,

              isIdempotent: false,

              hasUnknownSideEffect: true,

            },

            hasCurrentPermissionAtNewLocation: true,

            reliesOnPreviousOneTimeGrant: true,

            reliesOnTemporaryEscalation: false,

          },
        ],
      },
      {
        projectIdentifier: "beta",
        projectStatus: "unresolved",
        deviceIdentifier: "sample-device-1",
        locationMappings: [
          {
            projectIdentifier: "beta",
            deviceIdentifier: "sample-device-1",
            fromLocationRevision: 2,
            oldRootPath: "/sample/projects/beta-old",
            newRootPath: "/sample/projects/beta-new",
          },
        ],
        declaredStructuredResourceKinds: ["document"],
        hasWriteOrExternalSideEffects: true,
        references: [
          {
            referenceIdentifier: "beta-undeclared-kind",
            resourceKind: "message",
            requestedPath: "/sample/projects/beta-old/chat.json",
            owningProjectIdentifier: "beta",
            owningDeviceIdentifier: "sample-device-1",
            capturedLocationRevision: 1,
          },
          {
            referenceIdentifier: "beta-other-device",
            resourceKind: "document",
            requestedPath: "/sample/projects/beta-old/docs/spec.md",
            owningProjectIdentifier: "beta",
            owningDeviceIdentifier: "sample-device-2",
            capturedLocationRevision: 1,
          },
        ],
        pendingOperations: [
          {

            operation: {

              operationIdentifier: "beta-op-unknown",

              isCompleted: false,

              isIdempotent: false,

              hasUnknownSideEffect: true,

            },

            hasCurrentPermissionAtNewLocation: true,

            reliesOnPreviousOneTimeGrant: false,

            reliesOnTemporaryEscalation: false,

          },
        ],
      },
      {
        projectIdentifier: "gamma",
        projectStatus: "in-progress",
        deviceIdentifier: "sample-device-1",
        locationMappings: [
          {
            projectIdentifier: "gamma",
            deviceIdentifier: "sample-device-1",
            fromLocationRevision: 7,
            oldRootPath: "/sample/projects/gamma-old",
            newRootPath: "/sample/projects/gamma-new",
          },
          {
            projectIdentifier: "gamma",
            deviceIdentifier: "sample-device-1",
            fromLocationRevision: 7,
            oldRootPath: "/sample/projects/gamma-old/nested",
            newRootPath: "/sample/projects/gamma-elsewhere",
          },
        ],
        declaredStructuredResourceKinds: ["document"],
        hasWriteOrExternalSideEffects: false,
        references: [
          {
            referenceIdentifier: "gamma-ambiguous",
            resourceKind: "document",
            requestedPath: "/sample/projects/gamma-old/nested/docs/spec.md",
            owningProjectIdentifier: "gamma",
            owningDeviceIdentifier: "sample-device-1",
            capturedLocationRevision: 6,
          },
        ],
        pendingOperations: [
          {

            operation: {

              operationIdentifier: "gamma-op-escalated",

              isCompleted: false,

              isIdempotent: true,

              hasUnknownSideEffect: false,

            },

            hasCurrentPermissionAtNewLocation: true,

            reliesOnPreviousOneTimeGrant: false,

            reliesOnTemporaryEscalation: true,

          },
        ],
      },
      {
        projectIdentifier: "delta",
        projectStatus: "in-progress",
        deviceIdentifier: "sample-device-1",
        locationMappings: [
          {
            projectIdentifier: "delta",
            deviceIdentifier: "sample-device-1",
            fromLocationRevision: 3,
            oldRootPath: "/sample/projects/delta-old",
            newRootPath: "/sample/projects/delta-new",
          },
        ],
        declaredStructuredResourceKinds: ["checkpoint"],
        hasWriteOrExternalSideEffects: false,
        references: [
          {
            referenceIdentifier: "delta-escape",
            resourceKind: "checkpoint",
            requestedPath: "/sample/projects/delta-old/../beta-secret/notes.md",
            owningProjectIdentifier: "delta",
            owningDeviceIdentifier: "sample-device-1",
            capturedLocationRevision: 2,
          },
        ],
        pendingOperations: [],
      },
    ],
  };
}

/**
 * 判定一次批量对账**实测结果**是否符合预期（fail-closed）。
 *
 * 期望值写死在这里，避免"脚本自己算期望"导致空转。
 */
export function buildRelocationBatchChecks(observation) {
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed: passed === true, detail });
  };
  const readProject = (projectIdentifier) => {
    if (observation === null || typeof observation !== "object") return undefined;
    const projects = observation.projects;
    if (!Array.isArray(projects)) return undefined;
    return projects.find((project) => project?.projectIdentifier === projectIdentifier);
  };

  const alpha = readProject("alpha");
  const beta = readProject("beta");
  const gamma = readProject("gamma");
  const delta = readProject("delta");

  record(
    "批量覆盖 4 个项目（alpha/beta/gamma/delta）",
    [alpha, beta, gamma, delta].every((project) => project !== undefined),
    `found=${[alpha, beta, gamma, delta].filter((project) => project !== undefined).length}`,
  );
  record(
    "alpha 可以只读自动恢复（写副作用=false 且无阻塞）",
    alpha?.isAutoResumeAllowed === true && alpha?.kind === "reconciled",
    `kind=${String(alpha?.kind)}, auto=${String(alpha?.isAutoResumeAllowed)}`,
  );
  record(
    "alpha 的旧根引用被改写、已在新根的引用不改写",
    alpha?.resolvedReferenceCount === 2 &&
      alpha?.rewrittenReferenceCount === 1 &&
      alpha?.rewrittenReferencePaths?.some((requestedPath) =>
        String(requestedPath).endsWith("/alpha-old/docs/spec.md"),
      ) === true,
    `resolved=${String(alpha?.resolvedReferenceCount)}, rewritten=${String(alpha?.rewrittenReferenceCount)}`,
  );
  record(
    "delta 的 `..` 逃逸引用被拒绝（blocked + outside-old-root）",
    delta?.kind === "blocked" && delta?.unresolvedReferenceCodes?.includes("outside-old-root") === true,
    `kind=${String(delta?.kind)}, codes=${JSON.stringify(delta?.unresolvedReferenceCodes ?? [])}`,
  );
  record(
    "alpha 的已完成操作不重放（skip-already-completed）",
    alpha?.pendingDecisionKinds?.includes("skip-already-completed") === true,
    `kinds=${JSON.stringify(alpha?.pendingDecisionKinds ?? [])}`,
  );
  record(
    "beta 被 blocked（种类未声明 + 跨设备 + 未知非幂等副作用）",
    beta?.kind === "blocked" && beta?.isExecutionAllowed === false,
    `kind=${String(beta?.kind)}`,
  );
  record(
    "beta 的拒绝原因包含 unsupported-resource-kind 与 foreign-device",
    beta?.unresolvedReferenceCodes?.includes("unsupported-resource-kind") === true &&
      beta?.unresolvedReferenceCodes?.includes("foreign-device") === true,
    `codes=${JSON.stringify(beta?.unresolvedReferenceCodes ?? [])}`,
  );
  record(
    "beta 的未知非幂等副作用阻塞（unknown-side-effect）",
    beta?.pendingRejectionCodes?.includes("unknown-side-effect") === true,
    `codes=${JSON.stringify(beta?.pendingRejectionCodes ?? [])}`,
  );
  record(
    "gamma 的嵌套旧根被判歧义（ambiguous-mapping）",
    gamma?.kind === "blocked" &&
      gamma?.unresolvedReferenceCodes?.includes("ambiguous-mapping") === true,
    `kind=${String(gamma?.kind)}, codes=${JSON.stringify(gamma?.unresolvedReferenceCodes ?? [])}`,
  );
  record(
    "gamma 的临时提升不恢复（stale-grant-not-restored）",
    gamma?.pendingRejectionCodes?.includes("stale-grant-not-restored") === true,
    `codes=${JSON.stringify(gamma?.pendingRejectionCodes ?? [])}`,
  );
  record(
    "样例标记为脱敏（不含真实用户数据）",
    observation?.isSanitized === true,
    `isSanitized=${String(observation?.isSanitized)}`,
  );

  const passedCount = checks.filter((check) => check.passed).length;
  const isBelowMinimum = checks.length < MINIMUM_RELOCATION_BATCH_CHECK_COUNT;
  return {
    checks,
    passedCount,
    totalCount: checks.length,
    isAccepted: !isBelowMinimum && checks.every((check) => check.passed),
    summary: isBelowMinimum
      ? `判据条数 ${String(checks.length)} 低于下限 ${String(MINIMUM_RELOCATION_BATCH_CHECK_COUNT)}`
      : `${String(passedCount)}/${String(checks.length)} 判据通过`,
  };
}

/** 把 reconciler 的返回值压成可判定/可存档的观测（只保留计数与稳定代码）。 */
export function summarizeReconciliation(projectIdentifier, reconciliation) {
  const resolvedReferences = reconciliation.resolvedReferences ?? [];
  const unresolvedReferences = reconciliation.unresolvedReferences ?? [];
  const pendingDecisions = reconciliation.pendingOperationDecisions ?? [];
  return {
    projectIdentifier,
    kind: reconciliation.kind,
    isAutoResumeAllowed: reconciliation.isAutoResumeAllowed,
    isExecutionAllowed: reconciliation.isExecutionAllowed,
    resolvedReferenceCount: resolvedReferences.length,
    rewrittenReferenceCount: resolvedReferences.filter((reference) => reference.wasRewritten === true)
      .length,
    rewrittenReferencePaths: resolvedReferences
      .filter((reference) => reference.wasRewritten === true)
      .map((reference) => reference.requestedPath),
    unresolvedReferenceCodes: unresolvedReferences.map((reference) => reference.rejectionCode),
    pendingDecisionKinds: pendingDecisions.map((decision) => decision.decisionKind),
    pendingRejectionCodes: pendingDecisions
      .map((decision) => decision.rejectionCode)
      .filter((code) => code !== null && code !== undefined),
    requiredUserAction: reconciliation.requiredUserAction,
  };
}
