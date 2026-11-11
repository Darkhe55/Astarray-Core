/**
 * CLUSTER-01 §5：`astarray similarity ...` 子命令（纯函数，便于测试与复用）。
 *
 * 卡内要求：与 GUI/SDK 调用**同一应用服务**；JSON 输出带**稳定错误码**、数据范围、
 * freshness、partial 与来源引用。
 *
 * 本模块只做"参数 → 调用 → 输出"的映射，不自己开数据库、不复制算法。
 */

import type { DiagnosticClusterService } from "../../../core/src/orchestration/diagnostic-cluster-service.js";
import { appendDiagnosticClusterFeedback } from "../../../core/src/orchestration/diagnostic-cluster-feedback.js";

export interface SimilarityCommandPort {
  readonly getStatus: (
    projectIdentifier: string,
  ) => Promise<{ readonly status: "disabled" | "no-snapshot" | "ready"; readonly payload?: unknown }>;
  readonly build: (projectIdentifier: string) => Promise<{ readonly status: string; readonly payload?: unknown }>;
  readonly findRelated: (input: {
    readonly projectIdentifier: string;
    readonly groupIdentifier: string;
  }) => Promise<{ readonly status: string; readonly payload?: unknown }>;
  readonly feedback: (input: {
    readonly projectIdentifier: string;
    readonly groupIdentifier: string;
    readonly verdict: "agree" | "disagree" | "note";
    readonly noteText: string;
    readonly sourceIdentity: string;
  }) => Promise<{ readonly status: string; readonly payload?: unknown }>;
}

export interface SimilarityCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** 稳定错误码（不得随文案变化）。 */
export const SIMILARITY_EXIT_CODES = {
  ok: 0,
  featureDisabled: 3,
  noSnapshot: 4,
  usageError: 2,
  permissionDenied: 5,
} as const;

function emit(payload: unknown): string {
  return JSON.stringify(payload);
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

export async function runSimilarityCommand(input: {
  readonly argv: readonly string[];
  readonly port: SimilarityCommandPort;
  readonly projectIdentifier: string;
}): Promise<SimilarityCommandResult> {
  const subcommand = input.argv[0] ?? "";
  const knownSubcommands = ["status", "build", "list", "inspect", "find-related", "feedback"];
  /** 先判参数，再判开关：打错子命令必须得到"用法错误"，不能被 feature-disabled 掩盖。 */
  if (!knownSubcommands.includes(subcommand)) {
    return {
      exitCode: SIMILARITY_EXIT_CODES.usageError,
      stdout: emit({
        status: "usage-error",
        message: "用法：astarray similarity status|build|list|inspect|find-related|feedback",
      }),
    };
  }
  /** 关闭时统一 `feature-disabled`，与工具/SDK 语义一致（不是"没有错误"）。 */
  const statusProbe = await input.port.getStatus(input.projectIdentifier);
  if (statusProbe.status === "disabled") {
    return {
      exitCode: SIMILARITY_EXIT_CODES.featureDisabled,
      stdout: emit({ status: "feature-disabled", projectIdentifier: input.projectIdentifier }),
    };
  }

  switch (subcommand) {
    case "status": {
      return {
        exitCode: SIMILARITY_EXIT_CODES.ok,
        stdout: emit({ status: statusProbe.status, projectIdentifier: input.projectIdentifier }),
      };
    }
    case "build": {
      const built = await input.port.build(input.projectIdentifier);
      return { exitCode: SIMILARITY_EXIT_CODES.ok, stdout: emit(built) };
    }
    case "list":
    case "inspect":
    case "find-related": {
      if (statusProbe.status === "no-snapshot") {
        return {
          exitCode: SIMILARITY_EXIT_CODES.noSnapshot,
          stdout: emit({ status: "no-snapshot", projectIdentifier: input.projectIdentifier }),
        };
      }
      const groupIdentifier = readFlag(input.argv, "--group");
      if (groupIdentifier === null && subcommand !== "list") {
        return {
          exitCode: SIMILARITY_EXIT_CODES.usageError,
          stdout: emit({ status: "usage-error", message: "缺少 --group <组标识>" }),
        };
      }
      if (subcommand === "list") {
        return { exitCode: SIMILARITY_EXIT_CODES.ok, stdout: emit(statusProbe.payload ?? {}) };
      }
      const related = await input.port.findRelated({
        projectIdentifier: input.projectIdentifier,
        groupIdentifier: groupIdentifier ?? "",
      });
      return { exitCode: SIMILARITY_EXIT_CODES.ok, stdout: emit(related) };
    }
    case "feedback": {
      const groupIdentifier = readFlag(input.argv, "--group");
      const verdict = readFlag(input.argv, "--verdict");
      const noteText = readFlag(input.argv, "--note") ?? "";
      if (
        groupIdentifier === null ||
        verdict === null ||
        !["agree", "disagree", "note"].includes(verdict)
      ) {
        return {
          exitCode: SIMILARITY_EXIT_CODES.usageError,
          stdout: emit({
            status: "usage-error",
            message: "需要 --group <组标识> 与 --verdict agree|disagree|note",
          }),
        };
      }
      const appended = await input.port.feedback({
        projectIdentifier: input.projectIdentifier,
        groupIdentifier,
        verdict: verdict as "agree" | "disagree" | "note",
        noteText,
        /** 来源身份由 CLI 认证上下文提供，模型/参数不可覆盖。 */
        sourceIdentity: "cli-authenticated-user",
      });
      return { exitCode: SIMILARITY_EXIT_CODES.ok, stdout: emit(appended) };
    }
    default: {
      return {
        exitCode: SIMILARITY_EXIT_CODES.usageError,
        stdout: emit({
          status: "usage-error",
          message: "用法：astarray similarity status|build|list|inspect|find-related|feedback",
        }),
      };
    }
  }
}

/**
 * 把 CLI 端口绑定到**真实服务**（与 SDK/GUI 同一个 `DiagnosticClusterService`）。
 *
 * 默认关闭：`isEnabled` 必须由 CLI 显式传入（对应"仅用户或可信设置路径可启用"）。
 */
export function createSimilarityPortFromService(service: DiagnosticClusterService): SimilarityCommandPort {
  return {
    getStatus: async (projectIdentifier) => {
      const latest = await service.readLatest(projectIdentifier);
      return latest.status === "ready"
        ? { status: "ready", payload: latest.snapshot }
        : { status: latest.status };
    },
    build: async (projectIdentifier) =>
      await service.buildSnapshot({
        projectIdentifier,
        generatedAtIso: new Date().toISOString(),
        resolveProjectIdentifier: () => projectIdentifier,
      }),
    findRelated: async (input) => {
      const latest = await service.readLatest(input.projectIdentifier);
      if (latest.status !== "ready") return { status: latest.status };
      const group = latest.snapshot.groups.find(
        (candidate) => candidate.groupIdentifier === input.groupIdentifier,
      );
      return group === undefined ? { status: "group-not-found" } : { status: "ok", payload: group };
    },
    feedback: async (input) => ({
      status: "ok",
      payload: await appendDiagnosticClusterFeedback({
        stateDirectory: service.getStateDirectory(),
        projectIdentifier: input.projectIdentifier,
        groupIdentifier: input.groupIdentifier,
        verdict: input.verdict,
        sourceIdentity: input.sourceIdentity,
        sourceKind: "user",
        recordedAtIso: new Date().toISOString(),
        noteText: input.noteText,
      }),
    }),
  };
}
