/**
 * E3-3（2026-11-25）：broker **宿主与安装期注册**的契约层（纯判定，离线可验证）。
 *
 * 背景：强档需要一次安装期提权来注册 broker。这里有三个必须钉死的点：
 *
 * 1. **安装必须显式同意 + 提权**：不允许"静默安装"或"普通权限假装安装成功"；
 * 2. **注册记录可校验**：管道名/绑定用户/版本必须与运行时一致，损坏或缺字段 ⇒ 视为未安装（fail-closed）；
 * 3. **未安装 / 未运行 / 版本不符 ⇒ 调用方拒绝执行**，绝不回退宿主直跑。
 *
 * 宿主形态选择（记录在 installMode）：
 * - `service`（推荐）：以 SYSTEM 常驻；连接时**模拟调用方**拿到其令牌，
 *   再用该令牌 + AppContainer SID 建子进程（SYSTEM 持有 SeTcbPrivilege/SeAssignPrimaryToken）；
 *   不依赖用户交互会话。
 * - `scheduled-task`：登录时启动、随会话退出；实现简单，但**只在用户登录后可用**，
 *   且服务身份不是 SYSTEM（模拟/建进程的特权可能不足）。
 */
import { buildBrokerPipeName } from "./sandbox-broker-transport.js";

export const BROKER_INSTALL_SCHEMA_VERSION = 1;

export type BrokerInstallMode = "service" | "scheduled-task";

export interface BrokerInstallRecord {
  readonly schemaVersion: typeof BROKER_INSTALL_SCHEMA_VERSION;
  readonly installMode: BrokerInstallMode;
  readonly boundUserSid: string;
  readonly pipeName: string;
  readonly brokerVersion: string;
  readonly installedAtIso: string;
}

export type BrokerInstallDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "rejected";
      readonly reasonCode:
        | "missing-explicit-consent"
        | "not-elevated"
        | "unknown-install-mode"
        | "invalid-version";
      readonly detail: string;
    };

/** 安装前置：必须显式同意 + 已提权 + 合法模式/版本。 */
export function evaluateBrokerInstallRequest(input: {
  readonly hasExplicitUserConsent: boolean;
  readonly isElevated: boolean;
  readonly installMode: string;
  readonly brokerVersion: string;
}): BrokerInstallDecision {
  if (!input.hasExplicitUserConsent) {
    return {
      kind: "rejected",
      reasonCode: "missing-explicit-consent",
      detail: "安装 broker 需要用户显式确认（不做静默安装）。",
    };
  }
  if (!input.isElevated) {
    return {
      kind: "rejected",
      reasonCode: "not-elevated",
      detail: "注册服务/计划任务需要提权：当前进程不是管理员，拒绝并保持未安装。",
    };
  }
  if (input.installMode !== "service" && input.installMode !== "scheduled-task") {
    return {
      kind: "rejected",
      reasonCode: "unknown-install-mode",
      detail: `未知安装形态：${input.installMode}`,
    };
  }
  if (input.brokerVersion.trim() === "") {
    return { kind: "rejected", reasonCode: "invalid-version", detail: "broker 版本不能为空。" };
  }
  return { kind: "allowed" };
}

/** 生成注册记录（管道名由用户 SID 派生，不信任调用方自报）。 */
export function buildBrokerInstallRecord(input: {
  readonly installMode: BrokerInstallMode;
  readonly boundUserSid: string;
  readonly brokerVersion: string;
  readonly installedAtIso: string;
}): BrokerInstallRecord {
  return {
    schemaVersion: BROKER_INSTALL_SCHEMA_VERSION,
    installMode: input.installMode,
    boundUserSid: input.boundUserSid,
    pipeName: buildBrokerPipeName(input.boundUserSid),
    brokerVersion: input.brokerVersion,
    installedAtIso: input.installedAtIso,
  };
}

export type BrokerInstallRecordParseResult =
  | { readonly kind: "record"; readonly record: BrokerInstallRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupted"; readonly detail: string };

/**
 * 解析注册记录。**任何不确定都视为未安装/损坏**（fail-closed），不猜测。
 */
export function parseBrokerInstallRecord(
  rawText: string | null,
): BrokerInstallRecordParseResult {
  if (rawText === null || rawText.trim() === "") {
    return { kind: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { kind: "corrupted", detail: "注册记录不是合法 JSON。" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "corrupted", detail: "注册记录必须是对象。" };
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate["schemaVersion"] !== BROKER_INSTALL_SCHEMA_VERSION) {
    return { kind: "corrupted", detail: "注册记录 schemaVersion 不符。" };
  }
  const installMode = candidate["installMode"];
  if (installMode !== "service" && installMode !== "scheduled-task") {
    return { kind: "corrupted", detail: "注册记录 installMode 非法。" };
  }
  const boundUserSid = candidate["boundUserSid"];
  const pipeName = candidate["pipeName"];
  const brokerVersion = candidate["brokerVersion"];
  const installedAtIso = candidate["installedAtIso"];
  if (
    typeof boundUserSid !== "string" ||
    boundUserSid.trim() === "" ||
    typeof pipeName !== "string" ||
    typeof brokerVersion !== "string" ||
    brokerVersion.trim() === "" ||
    typeof installedAtIso !== "string" ||
    installedAtIso.trim() === ""
  ) {
    return { kind: "corrupted", detail: "注册记录字段缺失或类型不对。" };
  }
  /** 管道名必须与 SID 派生结果一致：防止"记录被改指向另一个用户的 broker"。 */
  if (pipeName !== buildBrokerPipeName(boundUserSid)) {
    return { kind: "corrupted", detail: "注册记录管道名与绑定用户不一致。" };
  }
  return {
    kind: "record",
    record: {
      schemaVersion: BROKER_INSTALL_SCHEMA_VERSION,
      installMode,
      boundUserSid,
      pipeName,
      brokerVersion,
      installedAtIso,
    },
  };
}

export type BrokerRuntimeReadiness =
  | { readonly kind: "ready"; readonly record: BrokerInstallRecord }
  | {
      readonly kind: "not-ready";
      readonly reasonCode:
        | "not-installed"
        | "record-corrupted"
        | "version-incompatible"
        | "broker-not-running";
      readonly detail: string;
    };

/** 运行时就绪判定：未安装/损坏/版本不符/未运行 ⇒ 一律"不可用"（调用方必须 fail-closed）。 */
export function evaluateBrokerRuntimeReadiness(input: {
  readonly recordParseResult: BrokerInstallRecordParseResult;
  readonly expectedBrokerVersion: string;
  readonly isPipePresent: boolean;
}): BrokerRuntimeReadiness {
  if (input.recordParseResult.kind === "missing") {
    return {
      kind: "not-ready",
      reasonCode: "not-installed",
      detail: "未安装 broker（未完成安装期初始化）：强档不可用，拒绝执行（不回退宿主）。",
    };
  }
  if (input.recordParseResult.kind === "corrupted") {
    return {
      kind: "not-ready",
      reasonCode: "record-corrupted",
      detail: `注册记录损坏：${input.recordParseResult.detail}`,
    };
  }
  const record = input.recordParseResult.record;
  if (record.brokerVersion !== input.expectedBrokerVersion) {
    return {
      kind: "not-ready",
      reasonCode: "version-incompatible",
      detail: `broker 版本不匹配（记录 ${record.brokerVersion}，期望 ${input.expectedBrokerVersion}）。`,
    };
  }
  if (!input.isPipePresent) {
    return {
      kind: "not-ready",
      reasonCode: "broker-not-running",
      detail:
        record.installMode === "scheduled-task"
          ? "broker 未运行（计划任务形态要求用户已登录并启动）。"
          : "broker 未运行（服务未启动或已停止）。",
    };
  }
  return { kind: "ready", record };
}

export type BrokerUninstallDecision =
  | { readonly kind: "removed" }
  | { readonly kind: "already-absent" }
  | { readonly kind: "rejected"; readonly detail: string };

/** 卸载幂等：未安装 ⇒ already-absent（不报错，也不假装删除过）。 */
export function evaluateBrokerUninstall(input: {
  readonly recordParseResult: BrokerInstallRecordParseResult;
}): BrokerUninstallDecision {
  if (input.recordParseResult.kind === "missing") {
    return { kind: "already-absent" };
  }
  if (input.recordParseResult.kind === "corrupted") {
    return {
      kind: "rejected",
      detail: `注册记录损坏，拒绝自动删除（需人工核对）：${input.recordParseResult.detail}`,
    };
  }
  return { kind: "removed" };
}
