/**
 * 契约层 SDK 的**包级验收判定**（纯函数，可单测）。
 *
 * 背景：本仓 20 个新契约模块都在 `public-sdk` 导出，但**导出存在 ≠ 打包可用**。
 * 本判定把"已安装 tarball 里这些契约是否真的可用且 fail-closed"变成可核对判据。
 *
 * 纪律（沿用 `toolkit01-package-checks.mjs` 的教训）：
 * - `undefined`（未观测到）与 `false`（观测到不满足）**都判失败**，不得因"没测到"放行；
 * - 判据数量低于下限 ⇒ 整体失败（防空转：判据为空时不得算通过）。
 */

/** 判据条数下限（少于此数视为验收脚本退化/未真正执行）。 */
export const MINIMUM_CONTRACT_SDK_CHECK_COUNT = 16;

function readSection(observation, sectionName) {
  if (observation === null || typeof observation !== "object") return undefined;
  const section = observation[sectionName];
  return section === null || typeof section !== "object" ? undefined : section;
}

function readValue(observation, sectionName, key) {
  const section = readSection(observation, sectionName);
  if (section === undefined) return undefined;
  return section[key];
}

/**
 * 构造判据。
 *
 * @param observation 由 `scripts/contract-sdk-scenario.mjs` 在**已安装包**中实测得出。
 */
export function buildContractSdkChecks(observation) {
  const checks = [];
  const record = (name, passed, detail) => {
    checks.push({ name, passed: passed === true, detail });
  };

  // ① 跨项目副本过滤（R26 修复：个体过滤必须生效）
  record(
    "cross-project 副本摘要按个体过滤",
    readValue(observation, "crossProject", "agentFilteredReceiptCount") === 1 &&
      readValue(observation, "crossProject", "unfilteredReceiptCount") === 2,
    `agentFiltered=${String(readValue(observation, "crossProject", "agentFilteredReceiptCount"))}, unfiltered=${String(readValue(observation, "crossProject", "unfilteredReceiptCount"))}`,
  );

  // ② 文件夹授权：父目录扩大范围必须被拒，且卡片不得默认勾选
  record(
    "folder 授权：父目录请求分类为 ancestor-of-project-root",
    readValue(observation, "folder", "ancestorClassification") === "ancestor-of-project-root",
    `classification=${String(readValue(observation, "folder", "ancestorClassification"))}`,
  );
  record(
    "folder 授权卡不是默认批准、不是批量",
    readValue(observation, "folder", "isDefaultApproved") === false &&
      readValue(observation, "folder", "isBatch") === false,
    `isDefaultApproved=${String(readValue(observation, "folder", "isDefaultApproved"))}, isBatch=${String(readValue(observation, "folder", "isBatch"))}`,
  );

  // ③ 工作时段：白名单外 = 休息
  record(
    "work-window 白名单外判定为休息",
    readValue(observation, "workWindow", "outsideWhitelistState") === "resting",
    `state=${String(readValue(observation, "workWindow", "outsideWhitelistState"))}`,
  );

  // ④ 文档视图：未知模式不猜、过滤视图不可写回
  record(
    "docview 未知模式返回 null（不猜）",
    readValue(observation, "docView", "unknownModeIsNull") === true,
    `unknownModeIsNull=${String(readValue(observation, "docView", "unknownModeIsNull"))}`,
  );
  record(
    "docview 过滤视图不可写回",
    readValue(observation, "docView", "writeBackAllowed") === false,
    `writeBackAllowed=${String(readValue(observation, "docView", "writeBackAllowed"))}`,
  );

  // ⑤ 设置对话：秘密类设置不得进对话
  record(
    "configchat 秘密设置被拒（protected-entry）",
    readValue(observation, "configChat", "secretReasonCode") ===
      "secret-setting-requires-protected-entry",
    `reasonCode=${String(readValue(observation, "configChat", "secretReasonCode"))}`,
  );
  record(
    "configchat 等待安全点不等于已生效",
    readValue(observation, "configChat", "awaitingIsApplied") === false,
    `awaitingIsApplied=${String(readValue(observation, "configChat", "awaitingIsApplied"))}`,
  );

  // ⑥ 使用引导：不再提示必须持久化生效
  record(
    "onboard「不再提示」持久化为抑制",
    readValue(observation, "onboarding", "neverShowAgainOutcome") === "suppress",
    `outcome=${String(readValue(observation, "onboarding", "neverShowAgainOutcome"))}`,
  );

  // ⑦ 折叠包：回退受未知副作用阻塞、回归不自动重跑
  record(
    "fold 未知副作用阻塞回退",
    readValue(observation, "fold", "rollbackReasonCode") === "unknown-side-effects",
    `reasonCode=${String(readValue(observation, "fold", "rollbackReasonCode"))}`,
  );
  record(
    "fold 回归不自动重跑旧工作流",
    readValue(observation, "fold", "autoRerunOldWorkflow") === false,
    `autoRerun=${String(readValue(observation, "fold", "autoRerunOldWorkflow"))}`,
  );

  // ⑧ 探索试验：真实数据禁止、重启预算置零
  record(
    "explore 真实用户数据禁止",
    readValue(observation, "explore", "realDataReasonCode") === "real-user-data-forbidden",
    `reasonCode=${String(readValue(observation, "explore", "realDataReasonCode"))}`,
  );
  record(
    "explore 重启无快照 ⇒ 预算置零",
    readValue(observation, "explore", "restoredMaximumTrials") === 0,
    `maximumTrials=${String(readValue(observation, "explore", "restoredMaximumTrials"))}`,
  );

  // ⑨ 周期整理：同方案单实例、错过周期合并为 1 次
  record(
    "curate 同方案第二次获取被拒（already-running）",
    readValue(observation, "curate", "secondLockKind") === "already-running",
    `kind=${String(readValue(observation, "curate", "secondLockKind"))}`,
  );
  record(
    "curate 错过周期合并为 1 次",
    readValue(observation, "curate", "coalescedRunCount") === 1,
    `coalescedRunCount=${String(readValue(observation, "curate", "coalescedRunCount"))}`,
  );

  // ⑩ 历史显示：控制序列被移除、证据锚点格式正确
  record(
    "history 控制序列被移除",
    readValue(observation, "history", "sanitizedChanged") === true &&
      readValue(observation, "history", "containsEscape") === false,
    `containsEscape=${String(readValue(observation, "history", "containsEscape"))}`,
  );
  record(
    "history 证据锚点格式 run-history:<mission>#<seq>",
    readValue(observation, "history", "evidenceAnchor") === "run-history:mission-1#7",
    `anchor=${String(readValue(observation, "history", "evidenceAnchor"))}`,
  );

  const passedCount = checks.filter((check) => check.passed).length;
  const isBelowMinimum = checks.length < MINIMUM_CONTRACT_SDK_CHECK_COUNT;
  const hasFailure = checks.some((check) => !check.passed);
  return {
    checks,
    passedCount,
    totalCount: checks.length,
    isAccepted: !isBelowMinimum && !hasFailure,
    summary: isBelowMinimum
      ? `判据条数 ${String(checks.length)} 低于下限 ${String(MINIMUM_CONTRACT_SDK_CHECK_COUNT)}：视为未真正验证`
      : `${String(passedCount)}/${String(checks.length)} 判据通过`,
  };
}
