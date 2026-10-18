/**
 * RELOCATE-01 检查点 01：**位置登记的最小 schema 与旧格式策略**（2026-10-18 第 10 轮）。
 *
 * 依据卡内 §2「位置登记独立保存设备、当前根目录和位置 revision」与
 * §3.4「原子更新登记并保存旧根、新根、revision、确认来源与时间」。
 *
 * 三条不可退让：
 * 1. **旧格式不得自动升级**（`legacy` 必须走用户显式关联流程，不能"猜着补字段"）；
 * 2. **不认识的 schemaVersion ⇒ invalid**（不得按 v1 解释）；
 * 3. 缺字段/类型错/空串/非法 revision ⇒ **invalid**（不得"当作有效"）。
 */

/** 登记来源：只允许用户确认或系统迁移，**模型不得作为来源**。 */
export type ProjectLocationConfirmedBy = "user" | "system-migration";

/** v1 位置登记（最小字段集）。 */
export interface ProjectLocationRegistrationV1 {
  readonly schemaVersion: 1;
  readonly projectIdentifier: string;
  readonly deviceIdentifier: string;
  readonly rootPath: string;
  readonly previousRootPath: string | null;
  readonly locationRevision: number;
  readonly confirmedBy: ProjectLocationConfirmedBy;
  readonly confirmedAtIso: string;
}

/** 解析结论。 */
export type ProjectLocationRegistrationParseOutcome =
  | { readonly kind: "valid"; readonly registration: ProjectLocationRegistrationV1 }
  | { readonly kind: "legacy"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

function readNonBlankString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 解析登记记录。**纯函数**：不做 I/O、不修补、不猜测。
 *
 * @param raw 已解析的 JSON 值（调用方负责 JSON.parse；解析失败由调用方按 invalid 处理）
 */
export function parseProjectLocationRegistration(
  raw: unknown,
): ProjectLocationRegistrationParseOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", reason: "登记记录不是对象，无法验证。" };
  }

  const record = raw as Record<string, unknown>;
  const rawSchemaVersion = record["schemaVersion"];

  // ① 完全没有版本号 ⇒ 旧格式（**不得**自动升级）
  if (rawSchemaVersion === undefined) {
    return {
      kind: "legacy",
      reason: "登记缺少 schemaVersion（旧格式）；需用户显式关联后迁移，不自动升级。",
    };
  }

  // ② 不认识的版本 ⇒ invalid（不得按 v1 解释）
  if (rawSchemaVersion !== 1) {
    return {
      kind: "invalid",
      reason: `不认识的登记版本 schemaVersion=${String(rawSchemaVersion)}；拒绝按 v1 解释。`,
    };
  }

  const projectIdentifier = readNonBlankString(record, "projectIdentifier");
  if (projectIdentifier === null) {
    return { kind: "legacy", reason: "登记缺少 projectIdentifier（旧格式）；需用户显式关联。" };
  }

  const deviceIdentifier = readNonBlankString(record, "deviceIdentifier");
  if (deviceIdentifier === null) {
    return {
      kind: "legacy",
      reason: "登记缺少 deviceIdentifier（旧格式，早于设备登记）；需用户显式关联，不自动补。",
    };
  }

  const rootPath = readNonBlankString(record, "rootPath");
  if (rootPath === null) {
    return { kind: "invalid", reason: "登记缺少 rootPath；位置未知，不能视为有效。" };
  }

  const locationRevision = record["locationRevision"];
  if (
    typeof locationRevision !== "number" ||
    !Number.isInteger(locationRevision) ||
    locationRevision < 1
  ) {
    return {
      kind: "invalid",
      reason: "locationRevision 必须是 ≥1 的整数；否则无法做 revision 冲突校验。",
    };
  }

  const confirmedBy = record["confirmedBy"];
  if (confirmedBy !== "user" && confirmedBy !== "system-migration") {
    return {
      kind: "invalid",
      reason: "confirmedBy 只能是 user 或 system-migration；模型不得作为关联确认来源。",
    };
  }

  const confirmedAtIso = readNonBlankString(record, "confirmedAtIso");
  if (confirmedAtIso === null) {
    return { kind: "invalid", reason: "登记缺少 confirmedAtIso；无法审计确认时间。" };
  }

  const rawPreviousRootPath = record["previousRootPath"];
  if (rawPreviousRootPath !== undefined && rawPreviousRootPath !== null) {
    if (typeof rawPreviousRootPath !== "string" || rawPreviousRootPath.trim() === "") {
      return { kind: "invalid", reason: "previousRootPath 若存在必须是非空字符串。" };
    }
  }

  return {
    kind: "valid",
    registration: {
      schemaVersion: 1,
      projectIdentifier,
      deviceIdentifier,
      rootPath,
      previousRootPath:
        typeof rawPreviousRootPath === "string" ? rawPreviousRootPath.trim() : null,
      locationRevision,
      confirmedBy,
      confirmedAtIso,
    },
  };
}
