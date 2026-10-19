#!/usr/bin/env node
/**
 * 契约层 SDK 的**包内观测脚本**：在**已安装 tarball** 的工作区里运行。
 *
 * 只做观测，不做判定（判定在 `scripts/lib/contract-sdk-checks.mjs`，可单测）。
 * 输出规范化 JSON 到 stdout 的最后一行，供 `verify-contract-sdk-package.mjs` 解析。
 *
 * 期望这些契约**全部**通过 `astarray` 的公开入口可用，且保持 fail-closed 语义。
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CrossProjectAuthorizationStore,
  FolderGrantStore,
  buildCurationViewSnapshot,
  evaluateExploreVerification,
  evaluateFoldCostBenefit,
  evaluateFoldPackageAuthorization,
  acquireCurationRunLock,
  assessFolderGrantCandidate,
  buildDocumentViewReceipt,
  buildFolderGrantCard,
  buildRunHistoryEvidenceAnchor,
  canWriteBackFromFilteredView,
  createOnboardingHintState,
  evaluateExploreTrialStart,
  evaluateFoldRegressionResponse,
  evaluateOnboardingHint,
  evaluateSettingApplyStatus,
  evaluateSettingChangeProposal,
  evaluateWorkWindowState,
  planCurationPendingRun,
  planFoldPackageRollback,
  resolveDocumentPresentationMode,
  restoreExploreBudgetAfterRestart,
  sanitizeRunHistoryDisplayText,
  summarizeCopyReceipts,
} from "astarray";

const observation = {};

// ── ① 跨项目副本：按个体过滤必须生效 ─────────────────────────────────
{
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-contract-sdk-"));
  try {
    const store = new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
    const grants = [
      { authorizationIdentifier: "auth-a", source: "project-a", agent: "agent-1" },
      { authorizationIdentifier: "auth-b", source: "project-b", agent: "agent-2" },
    ];
    for (const grant of grants) {
      await store.grantAuthorization({
        authorizationIdentifier: grant.authorizationIdentifier,
        sourceProjectIdentifier: grant.source,
        sourceProjectRevision: 1,
        targetProjectIdentifier: "project-c",
        targetProjectRevision: 1,
        operationKind: "import-copy",
        resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
        argumentsHash: `hash-${grant.authorizationIdentifier}`,
        expiresAtIso: "2030-01-01T00:00:00.000Z",
        grantedByUserId: "user-1",
        taskIdentifier: `T-${grant.authorizationIdentifier}`,
        receivingAgentInstanceId: grant.agent,
      });
      await store.recordCopyReceipt({
        receiptIdentifier: `receipt-${grant.authorizationIdentifier}`,
        authorizationIdentifier: grant.authorizationIdentifier,
        sourceProjectIdentifier: grant.source,
        sourceRevision: 1,
        targetProjectIdentifier: "project-c",
        sourceResourcePath: "docs/spec.md",
        targetResourcePath: `docs/${grant.source}.md`,
        contentHash: "0123456789abcdef",
        isCopyOfExternalSource: true,
        createdAtIso: "2026-10-19T00:00:00.000Z",
      });
    }
    const filtered = await summarizeCopyReceipts({
      store,
      filter: { receivingAgentInstanceId: "agent-1" },
    });
    const unfiltered = await summarizeCopyReceipts({ store });
    observation.crossProject = {
      agentFilteredReceiptCount: filtered.count,
      unfilteredReceiptCount: unfiltered.count,
    };
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

// ── ② 文件夹授权：父目录扩大范围被拒；卡片不默认批准、不批量 ──────────
{
  const assessment = assessFolderGrantCandidate({
    candidate: {
      projectIdentifier: "project-a",
      requestedPath: "/work",
      permissionKind: "read-only",
      includesSubdirectories: true,
      durationKind: "session",
      proposedBy: "model",
    },
    registeredRoots: [{ projectIdentifier: "project-a", rootPath: "/work/project-a" }],
  });
  const card = buildFolderGrantCard({
    candidate: {
      projectIdentifier: "project-a",
      requestedPath: "/work/assets",
      permissionKind: "read-only",
      includesSubdirectories: false,
      durationKind: "session",
      proposedBy: "model",
    },
    assessment: assessFolderGrantCandidate({
      candidate: {
        projectIdentifier: "project-a",
        requestedPath: "/work/assets",
        permissionKind: "read-only",
        includesSubdirectories: false,
        durationKind: "session",
        proposedBy: "model",
      },
      registeredRoots: [{ projectIdentifier: "project-a", rootPath: "/work/project-a" }],
    }),
  });
  observation.folder = {
    ancestorClassification: assessment.classification,
    isDefaultApproved: card.isDefaultApproved,
    isBatch: card.isBatch,
  };
}

// ── ③ 工作时段：白名单外 = 休息 ────────────────────────────────────
{
  const assessment = evaluateWorkWindowState({
    instantIso: "2026-10-19T00:30:00+08:00",
    rules: [
      {
        ruleIdentifier: "office-hours",
        mode: "work-whitelist",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        startMinuteOfDay: 9 * 60,
        endMinuteOfDay: 18 * 60,
        timeZone: "Asia/Shanghai",
        priority: "periodic",
        validFromUtcIso: null,
        validUntilUtcIso: null,
        scopeKind: "global",
      },
    ],
  });
  observation.workWindow = { outsideWhitelistState: assessment.state };
}

// ── ④ 文档视图：未知模式不猜；过滤视图不可写回 ──────────────────────
{
  const receipt = buildDocumentViewReceipt({
    format: "markdown",
    presentationMode: "content",
    sourceRevision: "rev-1",
    sourceAnchors: ["#intro"],
  });
  observation.docView = {
    unknownModeIsNull: resolveDocumentPresentationMode("bogus") === null,
    writeBackAllowed: canWriteBackFromFilteredView(),
    receiptBuilt: receipt.kind === "built",
  };
}

// ── ⑤ 设置对话：秘密设置在对话中被拒；等待安全点不等于已生效 ────────
{
  const decision = evaluateSettingChangeProposal({
    settingKey: "api-key",
    proposedValueJson: '"sk-zzzz"',
    scopeKind: "session",
    sourceKind: "authenticated-user",
    isExplicitUserInstruction: true,
    changeIdentifier: "change-1",
    expectedRevision: 1,
    currentRevision: 1,
    riskKinds: ["low"],
  });
  observation.configChat = {
    secretReasonCode: decision.kind === "reject" ? decision.reasonCode : "accepted-unexpectedly",
    awaitingIsApplied: evaluateSettingApplyStatus({
      status: "awaiting-safe-point",
      tightensPermissions: false,
    }).isAppliedRightNow,
  };
}

// ── ⑥ 使用引导：不再提示持久化生效 ─────────────────────────────────
{
  const neverShowAgainState = {
    ...createOnboardingHintState(),
    hasSeenFirstHint: true,
    isNeverShowAgain: true,
  };
  const decision = evaluateOnboardingHint({
    nowIso: "2027-01-01T00:00:00.000Z",
    state: neverShowAgainState,
    context: {
      isUserTyping: false,
      isAuthorizationPending: false,
      isErrorRecovery: false,
      isEmergencyActive: false,
      isHighLoad: false,
    },
    triggerSignals: {
      hasCompletedMilestone: true,
      hasAskedAboutEfficiency: true,
      hasDuplicateWorkDetected: true,
    },
  });
  observation.onboarding = {
    neverShowAgainOutcome: decision.kind === "suppress" ? decision.kind : decision.kind,
  };
}

// ── ⑦ 折叠包：未知副作用阻塞回退；回归不自动重跑 ────────────────────
{
  const rollback = planFoldPackageRollback({
    fromVersion: 2,
    toVersion: 1,
    isTargetVersionAvailable: true,
    hasUnknownSideEffects: true,
    inFlightInstanceCount: 0,
  });
  observation.fold = {
    rollbackReasonCode: rollback.kind === "blocked" ? rollback.reasonCode : "approved-unexpectedly",
    autoRerunOldWorkflow: evaluateFoldRegressionResponse({ hasRegression: true })
      .shouldAutoRerunOldWorkflow,
  };
}

// ── ⑧ 探索试验：真实数据禁止；重启预算置零 ─────────────────────────
{
  const decision = evaluateExploreTrialStart({
    parameterCombinationIdentifier: "combo-1",
    seedIdentifier: "seed-1",
    versionIdentifier: "v1",
    isolationKind: "isolated-directory",
    touchesRealUserData: true,
    touchesProductionRemote: false,
    remainingBudget: { maximumTrials: 3, tokens: 1000 },
    activeTrialCount: 0,
    sessionConcurrencyLimit: 1,
    isUserCancelled: false,
    isRestPeriod: false,
    existingTrials: [],
  });
  observation.explore = {
    realDataReasonCode: decision.kind === "no-start" ? decision.reasonCode : "started-unexpectedly",
    restoredMaximumTrials: restoreExploreBudgetAfterRestart({ persistedBudget: null }).budget
      .maximumTrials,
  };
}

// ── ⑨ 周期整理：同方案单实例；错过周期合并为 1 次 ───────────────────
{
  const first = acquireCurationRunLock({
    planIdentifier: "plan-1",
    runIdentifier: "run-1",
    acquiredAtIso: "2026-10-19T00:00:00.000Z",
    existingLock: null,
  });
  const second = acquireCurationRunLock({
    planIdentifier: "plan-1",
    runIdentifier: "run-2",
    acquiredAtIso: "2026-10-19T00:01:00.000Z",
    existingLock: first.kind === "acquired" ? first.lock : null,
  });
  observation.curate = {
    secondLockKind: second.kind,
    coalescedRunCount: planCurationPendingRun({
      lastHandledAtIso: "2026-10-15T00:00:00.000Z",
      nowIso: "2026-10-19T00:00:00.000Z",
      intervalMinutes: 1440,
    }).coalescedRunCount,
  };
}

// ── ⑩ 历史显示：控制序列移除；证据锚点格式 ─────────────────────────
{
  const rawText = "前\u001b[31m红\u001b[0m后";
  const sanitizedText = sanitizeRunHistoryDisplayText(rawText);
  observation.history = {
    sanitizedChanged: sanitizedText !== rawText,
    containsEscape: sanitizedText.includes("\u001b"),
    evidenceAnchor: buildRunHistoryEvidenceAnchor("mission-1", 7),
  };
}

// ── ⑪ EXPLORE-01-03：一次成功不算稳定；候选不自动合并 ────────────────
{
  const singleSuccess = evaluateExploreVerification({
    trials: [
      {
        trialKey: "only-one",
        seed: "seed-1",
        inputFingerprint: "in-1",
        isSuccess: true,
        evidenceHash: "hash-1",
        coversBoundary: true,
        coversRegression: true,
      },
    ],
    spentWallClockSeconds: 10,
    spentRequestCount: 1,
    spentEstimatedCostAmount: 0,
    maximumWallClockSeconds: 100,
    maximumRequestCount: 10,
    maximumEstimatedCostAmount: null,
    isSelfEvaluationOnly: false,
  });
  const sufficient = evaluateExploreVerification({
    trials: [
      {
        trialKey: "a",
        seed: "s1",
        inputFingerprint: "in-1",
        isSuccess: true,
        evidenceHash: "h1",
        coversBoundary: true,
        coversRegression: false,
      },
      {
        trialKey: "b",
        seed: "s2",
        inputFingerprint: "in-1",
        isSuccess: true,
        evidenceHash: "h2",
        coversBoundary: false,
        coversRegression: true,
      },
      {
        trialKey: "c",
        seed: "s2",
        inputFingerprint: "in-2",
        isSuccess: true,
        evidenceHash: "h3",
        coversBoundary: false,
        coversRegression: false,
      },
      {
        trialKey: "d",
        seed: "s3",
        inputFingerprint: "in-3",
        isSuccess: false,
        evidenceHash: "h4",
        coversBoundary: false,
        coversRegression: false,
      },
    ],
    spentWallClockSeconds: 10,
    spentRequestCount: 1,
    spentEstimatedCostAmount: 0,
    maximumWallClockSeconds: 100,
    maximumRequestCount: 10,
    maximumEstimatedCostAmount: null,
    isSelfEvaluationOnly: false,
  });
  observation.exploreVerification = {
    singleSuccessKind: singleSuccess.kind,
    sufficientKind: sufficient.kind,
    sufficientIsAutoMerged: sufficient.kind === "verified-candidate" ? sufficient.isAutoMerged : null,
    sufficientNegativeCount: sufficient.negativeResultCount,
  };
}

// ── ⑫ CURATE-01-03：无来源不展示、视图不删原文 ──────────────────────
{
  const snapshot = buildCurationViewSnapshot({
    plans: [{ planRevision: 3, isRevoked: false, isPendingApproval: false, isSuperseded: false }],
    items: [
      {
        itemIdentifier: "with-source",
        ownerAgentInstanceIdentifier: "agent-1",
        planRevision: 3,
        isModelInference: true,
        unresolvedKind: "conflict",
        sourceMessageIdentifiers: ["message-1"],
        sourceToolReceiptIdentifiers: [],
      },
      {
        itemIdentifier: "no-source",
        ownerAgentInstanceIdentifier: "agent-1",
        planRevision: 3,
        isModelInference: false,
        unresolvedKind: null,
        sourceMessageIdentifiers: [],
        sourceToolReceiptIdentifiers: [],
      },
      {
        itemIdentifier: "other-agent",
        ownerAgentInstanceIdentifier: "agent-2",
        planRevision: 3,
        isModelInference: false,
        unresolvedKind: null,
        sourceMessageIdentifiers: ["message-2"],
        sourceToolReceiptIdentifiers: [],
      },
    ],
    viewerAuthorizedAgentInstanceIdentifiers: new Set(["agent-1"]),
  });
  observation.curateView = {
    visibleCount: snapshot.visibleItems.length,
    unsourcedCount: snapshot.unsourcedItemCount,
    filteredCount: snapshot.filteredByAuthorizationCount,
    retainedUnresolvedCount: snapshot.retainedUnresolvedCount,
    isOriginalHistoryDeleted: snapshot.isOriginalHistoryDeleted,
    inferenceFlagged: snapshot.visibleItems[0]?.isModelInference ?? null,
  };
}

// ── ⑬ FOLD-01-03：不可逆逐步确认；越权拒绝 ──────────────────────────
{
  const irreversible = evaluateFoldPackageAuthorization({
    steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["shell-exec"] }],
    declaredCapabilityScope: new Set(["shell-exec"]),
    grantedCapabilitiesInRun: new Set(["shell-exec"]),
  });
  const outsideScope = evaluateFoldPackageAuthorization({
    steps: [{ stepIdentifier: "step-1", requiredCapabilities: ["fs-write"] }],
    declaredCapabilityScope: new Set(["fs-read"]),
    grantedCapabilitiesInRun: new Set(["fs-write"]),
  });
  observation.foldAuthorization = {
    irreversibleKind: irreversible.decisions[0]?.kind ?? null,
    irreversibleFlag: irreversible.decisions[0]?.isIrreversible ?? null,
    outsideScopeKind: outsideScope.decisions[0]?.kind ?? null,
    outsideScopeReasonCode: outsideScope.decisions[0]?.reasonCode ?? null,
    isBlocked: outsideScope.isPackageRunBlocked,
    isIrreversibleGrantPersistent: irreversible.isIrreversibleGrantPersistent,
  };
}

// ── ⑭ FOLD 成本收益：样本不足不下结论 ───────────────────────────────
{
  const run = (identifier, wallClockSeconds) => ({
    runIdentifier: identifier,
    wallClockSeconds,
    stepCount: 5,
    modelRequestCount: 2,
    inputTokens: 100,
    outputTokens: 50,
    isFailure: false,
  });
  const thin = evaluateFoldCostBenefit({
    baselineRuns: [run("b1", 100)],
    foldedRuns: [run("f1", 50)],
  });
  observation.foldCostBenefit = {
    thinSamplesKind: thin.kind,
    thinIsAutoPromoted: thin.isAutoPromoted,
  };
}

// ── ⑮ FOLDER-01-03：批准必须人工确认；未授权即 fail-closed ──────────
{
  const folderStateDirectory = mkdtempSync(path.join(os.tmpdir(), "astarray-folder-sdk-"));
  try {
    const store = new FolderGrantStore({ baseDirectory: folderStateDirectory });
    // 文件夹授权是为"项目根**之外**"的路径签发的：所以把项目根与共享目录放成兄弟
    const projectRootDirectory = path.join(folderStateDirectory, "project-root");
    const grantedDirectory = path.join(folderStateDirectory, "shared-granted");
    mkdirSync(projectRootDirectory, { recursive: true });
    mkdirSync(grantedDirectory, { recursive: true });
    const candidate = {
      projectIdentifier: "project-a",
      requestedPath: grantedDirectory,
      permissionKind: "read-only",
      includesSubdirectories: false,
      durationKind: "session",
      proposedBy: "user",
      realPathVerification: null,
    };
    const registeredRoots = [
      {
        projectIdentifier: "project-a",
        rootPath: projectRootDirectory,
      },
    ];
    // ① 非人工确认的批准必须被拒（模型不能自行落库）
    const withoutHuman = await store.issueGrant({
      candidate,
      registeredRoots,
      grantIdentifier: "grant-agent-proposed",
      projectRevision: 1,
      issuedAtIso: "2026-10-19T00:00:00.000Z",
      isHumanConfirmed: false,
    });
    // ② 人工确认后可登记
    const withHuman = await store.issueGrant({
      candidate,
      registeredRoots,
      grantIdentifier: "grant-human",
      projectRevision: 1,
      issuedAtIso: "2026-10-19T00:00:00.000Z",
      isHumanConfirmed: true,
    });
    // ③ 未覆盖的路径必须被拒（fail-closed）
    const denied = await store.evaluate({
      projectIdentifier: "project-a",
      targetPath: path.join(folderStateDirectory, "shared-not-granted", "file.txt"),
      requiredPermission: "read-only",
      projectRevision: 1,
      nowIso: "2026-10-19T00:10:00.000Z",
    });
    observation.folderApproval = {
      withoutHumanKind: withoutHuman.kind,
      withHumanKind: withHuman.kind,
      deniedOutcome: denied.outcome,
      deniedReasonCode: typeof denied.reasonCode === "string" ? denied.reasonCode : null,
    };
  } finally {
    rmSync(folderStateDirectory, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify(observation)}\n`);


