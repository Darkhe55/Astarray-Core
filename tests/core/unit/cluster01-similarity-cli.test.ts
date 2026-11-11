/**
 * CLUSTER-01 §5：`similarity` 子命令的出口契约。
 *
 * 反例重点：关闭时必须稳定返回 `feature-disabled`（不是"没有错误"）；
 * 未构建时 `list/inspect` 返回 `no-snapshot`；缺参数是用法错误（退出码 2）。
 */
import { describe, expect, it } from "vitest";

import {
  SIMILARITY_EXIT_CODES,
  createSimilarityPortFromService,
  runSimilarityCommand,
  type SimilarityCommandPort,
} from "../../../packages/tui/src/cli/similarity-command.js";
import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function buildPort(overrides: Partial<SimilarityCommandPort> = {}): SimilarityCommandPort {
  return {
    getStatus: async () => ({ status: "ready", payload: { groups: 2 } }),
    build: async () => ({ status: "built", payload: { isComplete: true } }),
    findRelated: async (input: { readonly projectIdentifier: string; readonly groupIdentifier: string }) => ({
      status: "ready",
      payload: { group: input.groupIdentifier },
    }),
    feedback: async (input: {
      readonly projectIdentifier: string;
      readonly groupIdentifier: string;
      readonly verdict: "agree" | "disagree" | "note";
      readonly noteText: string;
      readonly sourceIdentity: string;
    }) => ({ status: "ok", payload: { groupIdentifier: input.groupIdentifier } }),
    ...overrides,
  };
}

describe("CLUSTER-01 CLI similarity", () => {
  it("**接到真实服务**：关闭 ⇒ 退出码 3；启用并构建后 ⇒ status ready", async () => {
    const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-cli-"));
    try {
      const disabledService = new DiagnosticClusterService({
        store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
        stateDirectory,
        algorithmVersion: "diagnostic-cluster-v1",
      });
      const disabled = await runSimilarityCommand({
        argv: ["status"],
        port: createSimilarityPortFromService(disabledService),
        projectIdentifier: "project-alpha",
      });
      expect(disabled.exitCode).toBe(SIMILARITY_EXIT_CODES.featureDisabled);

      const enabledService = new DiagnosticClusterService({
        store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
        stateDirectory,
        algorithmVersion: "diagnostic-cluster-v1",
        isEnabled: true,
      });
      const port = createSimilarityPortFromService(enabledService);
      const beforeBuild = await runSimilarityCommand({
        argv: ["list"],
        port,
        projectIdentifier: "project-alpha",
      });
      expect(beforeBuild.exitCode).toBe(SIMILARITY_EXIT_CODES.noSnapshot);

      const built = await runSimilarityCommand({ argv: ["build"], port, projectIdentifier: "project-alpha" });
      expect(built.exitCode).toBe(SIMILARITY_EXIT_CODES.ok);
      const afterBuild = await runSimilarityCommand({
        argv: ["status"],
        port,
        projectIdentifier: "project-alpha",
      });
      expect(JSON.parse(afterBuild.stdout).status).toBe("ready");
    } finally {
      await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
    }
  });
  it("**关闭 ⇒ feature-disabled 与稳定退出码**", async () => {
    const result = await runSimilarityCommand({
      argv: ["status"],
      port: buildPort({ getStatus: async () => ({ status: "disabled" }) }),
      projectIdentifier: "project-alpha",
    });
    expect(result.exitCode).toBe(SIMILARITY_EXIT_CODES.featureDisabled);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "feature-disabled",
      projectIdentifier: "project-alpha",
    });
  });

  it("未构建 ⇒ list 返回 no-snapshot 与其退出码", async () => {
    const result = await runSimilarityCommand({
      argv: ["list"],
      port: buildPort({ getStatus: async () => ({ status: "no-snapshot" }) }),
      projectIdentifier: "project-alpha",
    });
    expect(result.exitCode).toBe(SIMILARITY_EXIT_CODES.noSnapshot);
    expect(JSON.parse(result.stdout).status).toBe("no-snapshot");
  });

  it("build ⇒ 透传服务结果", async () => {
    const result = await runSimilarityCommand({
      argv: ["build"],
      port: buildPort(),
      projectIdentifier: "project-alpha",
    });
    expect(result.exitCode).toBe(SIMILARITY_EXIT_CODES.ok);
    expect(JSON.parse(result.stdout).status).toBe("built");
  });

  it("inspect 缺 --group ⇒ 用法错误；给了 ⇒ 透传检索结果", async () => {
    const missing = await runSimilarityCommand({
      argv: ["inspect"],
      port: buildPort(),
      projectIdentifier: "project-alpha",
    });
    expect(missing.exitCode).toBe(SIMILARITY_EXIT_CODES.usageError);

    const provided = await runSimilarityCommand({
      argv: ["inspect", "--group", "group-1"],
      port: buildPort(),
      projectIdentifier: "project-alpha",
    });
    expect(provided.exitCode).toBe(SIMILARITY_EXIT_CODES.ok);
    /** CLI 透传端口结果：外层 status + 内层 payload。 */
    expect(JSON.parse(provided.stdout).payload.group).toBe("group-1");
  });

  it("feedback 需要 --group 与合法 --verdict；来源身份由 CLI 提供", async () => {
    const invalid = await runSimilarityCommand({
      argv: ["feedback", "--group", "g", "--verdict", "maybe"],
      port: buildPort(),
      projectIdentifier: "project-alpha",
    });
    expect(invalid.exitCode).toBe(SIMILARITY_EXIT_CODES.usageError);

    let capturedSource: string | null = null;
    const ok = await runSimilarityCommand({
      argv: ["feedback", "--group", "g", "--verdict", "disagree", "--note", "不一致"],
      port: buildPort({
        feedback: async (input: { readonly sourceIdentity: string }) => {
          capturedSource = input.sourceIdentity;
          return { status: "ok", payload: {} };
        },
      }),
      projectIdentifier: "project-alpha",
    });
    expect(ok.exitCode).toBe(SIMILARITY_EXIT_CODES.ok);
    expect(capturedSource).toBe("cli-authenticated-user");
  });

  it("未知子命令 ⇒ 用法错误（列出可用子命令）", async () => {
    const result = await runSimilarityCommand({
      argv: ["explode"],
      port: buildPort(),
      projectIdentifier: "project-alpha",
    });
    expect(result.exitCode).toBe(SIMILARITY_EXIT_CODES.usageError);
    expect(JSON.parse(result.stdout).message).toContain("similarity status|build");
  });
});
