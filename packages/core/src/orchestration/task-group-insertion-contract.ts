/**
 * ALIGN-02-06（2026-10-28）：**运行中插入**任务的本地判定契约。
 *
 * 卡内要求：运行中插入要记录**目标组、锚点、预期 revision、幂等键**；
 * 本地校验后在**安全上下文边界**注入尚未执行部分；不得重复运行组内已完成任务，
 * 不直接改写已发出的工具调用；**无法在本组合法插入的后继保留在同一序列等待下一组**，
 * 并给出原因。
 *
 * 本模块是纯判定（不读盘、不派发），把"请求 + 当前组状态"映射成四类结果：
 * - `insert-now`：组未关闭、revision 相符、锚点合法、锚点之后没有已发出的工具调用
 *   ⇒ 可以交给安全点注入；
 * - `deferred-to-next-group`：组已关闭 / 锚点之后已有工具调用 / 编排器暂无注入能力
 *   ⇒ **保留在权威序列里等待下一组**（不丢、不硬塞）；
 * - `duplicate`：同幂等键同内容 ⇒ 复用既有请求；
 * - `stale-revision-rejected` / `invalid-anchor-rejected` / `idempotency-conflict`
 *   ⇒ 拒绝，调用方必须重新读取状态或换键。
 *
 * 语义边界：`insert-now` **只是判定**，真正注入仍必须发生在安全点（不得改写已发出的
 * 工具调用）。因此本模块不提供"立即执行"入口。
 */
import { DomainError } from "../core/errors.js";

/** 插入请求允许的字段（严格白名单；多一个就拒绝）。 */
const ALLOWED_REQUEST_FIELDS = [
  "missionIdentifier",
  "requestIdentifier",
  "expectedGroupRevision",
  "anchorTaskIdentifier",
  "title",
  "description",
  "acceptanceCriteria",
  "dependsOn",
] as const;

export interface RuntimeTaskInsertionRequest {
  readonly missionIdentifier: string;
  /** 幂等键（同一按键重试不得产生第二条任务）。 */
  readonly requestIdentifier: string;
  /** 观察到的组 revision（乐观并发）。 */
  readonly expectedGroupRevision: number;
  /** 插入锚点：新任务排在它之后；`null` 表示"追加到组末尾"。 */
  readonly anchorTaskIdentifier: string | null;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
  readonly dependsOn: readonly string[];
}

export interface TaskGroupInsertionGroupState {
  readonly groupIdentifier: string;
  readonly revision: number;
  readonly isClosed: boolean;
  /** 组内任务状态（用于判定锚点是否已完成、是否已有运行中任务）。 */
  readonly taskStates: Readonly<Record<string, string>>;
  /**
   * 锚点之后是否**已经发出工具调用**（含正在运行的任务）。
   * true ⇒ 不得改写，只能等待下一组。
   */
  readonly hasIssuedToolCallsAfterAnchor: boolean;
}

export type TaskGroupInsertionOutcome =
  | "insert-now"
  | "deferred-to-next-group"
  | "duplicate"
  | "stale-revision-rejected"
  | "invalid-anchor-rejected"
  | "idempotency-conflict";

export interface TaskGroupInsertionDecision {
  readonly outcome: TaskGroupInsertionOutcome;
  /** 给用户/调用方看的原因（拒绝与推迟都必须有）。 */
  readonly reason: string;
  readonly anchorTaskIdentifier: string | null;
}

export interface DecideTaskGroupInsertionInput {
  readonly request: RuntimeTaskInsertionRequest;
  readonly group: TaskGroupInsertionGroupState;
  /** 同幂等键已登记的请求内容指纹（缺省 null ⇒ 首次）。 */
  readonly existingRequestFingerprint: string | null;
}

/** 请求内容指纹（幂等键相同则内容必须相同）。 */
export function computeInsertionRequestFingerprint(
  request: RuntimeTaskInsertionRequest,
): string {
  return JSON.stringify({
    missionIdentifier: request.missionIdentifier,
    anchorTaskIdentifier: request.anchorTaskIdentifier,
    title: request.title,
    description: request.description,
    acceptanceCriteria: request.acceptanceCriteria,
    dependsOn: [...request.dependsOn].sort(),
  });
}

/**
 * 严格解析模型/调用方给的插入请求。
 *
 * 不信任来源与 revision：全部字段必填校验，未知字段拒绝（避免塞入 `status`、
 * `priorityTier`、`sourceKind` 等权威字段）。
 */
export function parseRuntimeTaskInsertionRequest(
  payload: unknown,
): RuntimeTaskInsertionRequest {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new DomainError("invalid-task-chain", "运行中插入请求必须是 JSON 对象。");
  }
  const record = payload as Record<string, unknown>;
  const unknownFields = Object.keys(record).filter(
    (fieldName) => !(ALLOWED_REQUEST_FIELDS as readonly string[]).includes(fieldName),
  );
  if (unknownFields.length > 0) {
    throw new DomainError(
      "invalid-task-chain",
      `运行中插入请求包含不支持的字段（不得静默忽略）: ${unknownFields.join(", ")}`,
    );
  }
  const expectedGroupRevision = record["expectedGroupRevision"];
  if (
    typeof expectedGroupRevision !== "number" ||
    !Number.isInteger(expectedGroupRevision) ||
    expectedGroupRevision < 0
  ) {
    throw new DomainError(
      "invalid-task-chain",
      "运行中插入必须给出 ≥0 的整数 expectedGroupRevision（观察到的组 revision）。",
    );
  }
  const anchorTaskIdentifierValue = record["anchorTaskIdentifier"];
  if (
    anchorTaskIdentifierValue !== null &&
    anchorTaskIdentifierValue !== undefined &&
    typeof anchorTaskIdentifierValue !== "string"
  ) {
    throw new DomainError("invalid-task-chain", "anchorTaskIdentifier 必须是字符串或 null。");
  }
  return {
    missionIdentifier: readRequiredString(record, "missionIdentifier"),
    requestIdentifier: readRequiredString(record, "requestIdentifier"),
    expectedGroupRevision,
    anchorTaskIdentifier:
      typeof anchorTaskIdentifierValue === "string" && anchorTaskIdentifierValue.trim() !== ""
        ? anchorTaskIdentifierValue.trim()
        : null,
    title: readRequiredString(record, "title"),
    description: readRequiredString(record, "description"),
    acceptanceCriteria: readRequiredString(record, "acceptanceCriteria"),
    dependsOn: readStringArray(record, "dependsOn"),
  };
}

/**
 * 判定这次插入能否进入**当前组**。
 *
 * 顺序刻意固定：先幂等、再 revision、再锚点、最后才是"组是否还能接"。
 * 这样同一请求重放时不会被误报成"revision 过期"。
 */
export function decideTaskGroupInsertion(
  input: DecideTaskGroupInsertionInput,
): TaskGroupInsertionDecision {
  const requestFingerprint = computeInsertionRequestFingerprint(input.request);
  if (input.existingRequestFingerprint !== null) {
    if (input.existingRequestFingerprint === requestFingerprint) {
      return {
        outcome: "duplicate",
        reason: "同幂等键同内容：复用既有插入请求，不重复登记",
        anchorTaskIdentifier: input.request.anchorTaskIdentifier,
      };
    }
    return {
      outcome: "idempotency-conflict",
      reason: "同幂等键异内容：拒绝覆盖既有插入请求",
      anchorTaskIdentifier: input.request.anchorTaskIdentifier,
    };
  }
  if (input.group.revision !== input.request.expectedGroupRevision) {
    return {
      outcome: "stale-revision-rejected",
      reason:
        `组 revision 已变化（现有 ${input.group.revision}，请求 ${input.request.expectedGroupRevision}）：` +
        "请重新读取组状态后再提交（不得盲目重试覆盖）",
      anchorTaskIdentifier: input.request.anchorTaskIdentifier,
    };
  }
  if (
    input.request.anchorTaskIdentifier !== null &&
    input.group.taskStates[input.request.anchorTaskIdentifier] === undefined
  ) {
    return {
      outcome: "invalid-anchor-rejected",
      reason: `锚点任务不在当前组内: ${input.request.anchorTaskIdentifier}`,
      anchorTaskIdentifier: input.request.anchorTaskIdentifier,
    };
  }
  if (input.group.isClosed) {
    return {
      outcome: "deferred-to-next-group",
      reason: "当前组已关闭：插入请求保留在同一序列，等待下一组执行",
      anchorTaskIdentifier: input.request.anchorTaskIdentifier,
    };
  }
  if (input.group.hasIssuedToolCallsAfterAnchor) {
    return {
      outcome: "deferred-to-next-group",
      reason:
        "锚点之后已有已发出的工具调用（或运行中任务）：不得改写，插入保留到下一组",
      anchorTaskIdentifier: input.request.anchorTaskIdentifier,
    };
  }
  return {
    outcome: "insert-now",
    reason: "组未关闭、revision 相符、锚点之后没有已发出的工具调用：可在安全点注入",
    anchorTaskIdentifier: input.request.anchorTaskIdentifier,
  };
}

function readRequiredString(
  record: Record<string, unknown>,
  fieldName: string,
): string {
  const value = record[fieldName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(
      "invalid-task-chain",
      `运行中插入字段 ${fieldName} 必须是非空字符串。`,
    );
  }
  return value.trim();
}

function readStringArray(record: Record<string, unknown>, fieldName: string): string[] {
  const value = record[fieldName];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new DomainError("invalid-task-chain", `运行中插入字段 ${fieldName} 必须是字符串数组。`);
  }
  return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
}
