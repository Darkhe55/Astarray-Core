/**
 * CLUSTER-01 §5：工具**执行**入口（builtins dispatch）。
 *
 * 两条必须存在的反例：
 * - 未装配服务 ⇒ 显式报错，**不得**伪装成"没有错误"或空结果；
 * - 开关关闭 ⇒ 返回 `feature-disabled`，且不落盘。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";
import {
  DIAGNOSTIC_CLUSTER_TOOL_NAME,
  buildDiagnosticClusterToolDescriptor,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-tools.js";
import { executeBuiltinTool } from "../../../packages/core/src/tools/builtins.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-exec-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * 只构造执行所需最小上下文：聚类分支只读这几个字段，
 * 其余字段用 `as never` 省略，避免与别的工具签名耦合。
 */
function buildContext(overrides: Record<string, unknown>) {
  return { protectedStoragePolicy: {} as never, ...overrides } as never;
}

describe("CLUSTER-01 工具执行入口", () => {
  it("未装配服务 ⇒ 显式报错（不得伪装成没有错误）", async () => {
    await expect(
      executeBuiltinTool(
        DIAGNOSTIC_CLUSTER_TOOL_NAME,
        JSON.stringify({ action: "list" }),
        buildContext({}),
      ),
    ).rejects.toThrow(/未装配/u);
  });

  it("开关关闭 ⇒ feature-disabled，且不创建索引目录", async () => {
    const service = new DiagnosticClusterService({
      store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: false,
    });
    const result = await executeBuiltinTool(
      DIAGNOSTIC_CLUSTER_TOOL_NAME,
      JSON.stringify({ action: "build" }),
      buildContext({ diagnosticClusterService: service, diagnosticClusterProjectIdentifier: "project-alpha" }),
    );
    expect(JSON.parse(result.outputText)).toEqual({ status: "feature-disabled" });
    await expect(fs.stat(path.join(stateDirectory, "analysis"))).rejects.toThrow();
  });

  it("开关开启 + 写 action ⇒ 走服务并可落到 built 结果", async () => {
    const service = new DiagnosticClusterService({
      store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: true,
    });
    const result = await executeBuiltinTool(
      DIAGNOSTIC_CLUSTER_TOOL_NAME,
      JSON.stringify({ action: "build" }),
      buildContext({ diagnosticClusterService: service, diagnosticClusterProjectIdentifier: "project-alpha" }),
    );
    /** action 结果外层是 `ok`，内层 payload 才是服务返回的 `built`。 */
    const parsed = JSON.parse(result.outputText) as { status: string; payload: { status: string } };
    expect(parsed.status).toBe("ok");
    expect(parsed.payload.status).toBe("built");
  });

  it("描述符与执行入口名字一致（防止注册名与 dispatch 名漂移）", () => {
    expect(buildDiagnosticClusterToolDescriptor().name).toBe(DIAGNOSTIC_CLUSTER_TOOL_NAME);
  });
});
