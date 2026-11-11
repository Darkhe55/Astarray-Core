import type { DiagnosticClusterService } from "./diagnostic-cluster-service.js";
import type { DiagnosticClusterInput } from "./diagnostic-clusterer.js";

/**
 * CLUSTER-01 §5：**统一工具与权限**的 action 级判定。
 *
 * 卡内硬约束：
 * - 复用现有框架，**最严格约束生效**；任务工具子集、项目范围与模式门禁都保留；
 * - **主 Agent 与思索模式只能只读 action**，不能 `build` / `feedback`；
 * - 关闭时工具返回 `feature-disabled`，**不扫描、不新建索引、不调用模型**，已有索引不删除；
 * - 若现有框架无法表达混合读写，**先补 action 级副作用判定**，禁止把整个工具声明为只读来绕过门禁。
 */

export const DIAGNOSTIC_CLUSTER_TOOL_NAME = "diagnosticClusters";

export type DiagnosticClusterAction = "list" | "inspect" | "find-related" | "build" | "feedback";

/** action 级副作用判定（混合读写不能整体声明为只读）。 */
export const DIAGNOSTIC_CLUSTER_ACTION_SIDE_EFFECTS: Readonly<
  Record<DiagnosticClusterAction, "read-only" | "mutating">
> = {
  list: "read-only",
  inspect: "read-only",
  "find-related": "read-only",
  build: "mutating",
  feedback: "mutating",
};

export function classifyDiagnosticClusterAction(
  action: string,
): "read-only" | "mutating" | "unknown" {
  return Object.hasOwn(DIAGNOSTIC_CLUSTER_ACTION_SIDE_EFFECTS, action)
    ? DIAGNOSTIC_CLUSTER_ACTION_SIDE_EFFECTS[action as DiagnosticClusterAction]
    : "unknown";
}

export interface DiagnosticClusterToolContext {
  readonly service: DiagnosticClusterService;
  readonly projectIdentifier: string;
  /** 调用者是否为只读主体（主 Agent / 思索模式）。 */
  readonly isReadOnlyCaller: boolean;
  readonly nowIso: () => string;
  readonly resolveProjectIdentifier: (event: Parameters<DiagnosticClusterService["buildSnapshot"]>[0]["resolveProjectIdentifier"] extends (
    event: infer T,
  ) => string | null
    ? T
    : never) => string | null;
}

export type DiagnosticClusterToolResult =
  | { readonly status: "feature-disabled" }
  | { readonly status: "permission-denied"; readonly reason: string }
  | { readonly status: "ok"; readonly payload: unknown };

/**
 * 执行一个 action。顺序很重要：**先判开关，再判权限，最后才做事**，
 * 这样"关闭"时连权限查询都不发生（不产生副作用）。
 */
export async function executeDiagnosticClusterAction(input: {
  readonly action: string;
  readonly context: DiagnosticClusterToolContext;
  readonly argumentsValue?: unknown;
}): Promise<DiagnosticClusterToolResult> {
  if (!input.context.service.isDiagnosticClusteringEnabled()) {
    return { status: "feature-disabled" };
  }

  const sideEffect = classifyDiagnosticClusterAction(input.action);
  if (sideEffect === "unknown") {
    return { status: "permission-denied", reason: "未知 action" };
  }
  if (input.context.isReadOnlyCaller && sideEffect === "mutating") {
    return { status: "permission-denied", reason: "只读主体不得调用写 action" };
  }

  const argumentsRecord = (input.argumentsValue ?? {}) as {
    readonly event?: DiagnosticClusterInput;
    readonly limit?: number;
    readonly minimumSimilarity?: number;
    readonly groupIdentifier?: string;
  };

  switch (input.action) {
    case "list": {
      const latest = await input.context.service.readLatest(input.context.projectIdentifier);
      return { status: "ok", payload: latest };
    }
    case "inspect": {
      const latest = await input.context.service.readLatest(input.context.projectIdentifier);
      if (latest.status !== "ready") return { status: "ok", payload: latest };
      const group = latest.snapshot.groups.find(
        (candidate) => candidate.groupIdentifier === argumentsRecord.groupIdentifier,
      );
      return { status: "ok", payload: group ?? { status: "group-not-found" } };
    }
    case "find-related": {
      if (argumentsRecord.event === undefined) {
        return { status: "permission-denied", reason: "缺少授权事件引用" };
      }
      const related = await input.context.service.findRelated({
        projectIdentifier: input.context.projectIdentifier,
        event: argumentsRecord.event,
        ...(argumentsRecord.limit === undefined ? {} : { limit: argumentsRecord.limit }),
        ...(argumentsRecord.minimumSimilarity === undefined
          ? {}
          : { minimumSimilarity: argumentsRecord.minimumSimilarity }),
      });
      return { status: "ok", payload: related };
    }
    case "build": {
      const built = await input.context.service.buildSnapshot({
        projectIdentifier: input.context.projectIdentifier,
        generatedAtIso: input.context.nowIso(),
        resolveProjectIdentifier: input.context.resolveProjectIdentifier,
      });
      return { status: "ok", payload: built };
    }
    case "feedback": {
      /**
       * 反馈只保存"用户/有权 Agent 的意见"：不改原始事件、不改算法、不自动重分组。
       * 存储层尚未实现（卡内 CLUSTER-01-03 的后续切片），这里显式返回未实现而不是假装成功。
       */
      return { status: "permission-denied", reason: "feedback-store-not-implemented" };
    }
    default: {
      return { status: "permission-denied", reason: "未知 action" };
    }
  }
}
