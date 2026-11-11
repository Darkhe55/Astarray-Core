/**
 * CLUSTER-01 §5：工具 action 级权限与开关的判定顺序。
 *
 * 反例重点：
 * - 关闭时返回 `feature-disabled`，且**不做任何工作**；
 * - 只读主体调用写 action（build / feedback）必须拒绝；
 * - 未知 action 不能被当成只读放行。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";
import {
  classifyDiagnosticClusterAction,
  executeDiagnosticClusterAction,
} from "../../../packages/core/src/orchestration/diagnostic-cluster-tools.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-tools-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildService(isEnabled: boolean) {
  return new DiagnosticClusterService({
    store: new DiagnosticEventStore({ baseDirectory: stateDirectory }),
    stateDirectory,
    algorithmVersion: "diagnostic-cluster-v1",
    isEnabled,
  });
}

const context = (service: DiagnosticClusterService, isReadOnlyCaller: boolean) => ({
  service,
  projectIdentifier: "project-alpha",
  isReadOnlyCaller,
  nowIso: () => "2026-11-11T00:00:00.000Z",
  resolveProjectIdentifier: () => "project-alpha",
});

describe("CLUSTER-01 工具 action 判定", () => {
  it("action 级副作用分类：查询类只读，build/feedback 写；未知为 unknown", () => {
    expect(classifyDiagnosticClusterAction("list")).toBe("read-only");
    expect(classifyDiagnosticClusterAction("inspect")).toBe("read-only");
    expect(classifyDiagnosticClusterAction("find-related")).toBe("read-only");
    expect(classifyDiagnosticClusterAction("build")).toBe("mutating");
    expect(classifyDiagnosticClusterAction("feedback")).toBe("mutating");
    expect(classifyDiagnosticClusterAction("deleteEverything")).toBe("unknown");
  });

  it("**关闭 ⇒ feature-disabled**，且不创建任何目录（连权限判定都不发生）", async () => {
    const service = buildService(false);
    const result = await executeDiagnosticClusterAction({
      action: "build",
      context: context(service, false),
    });
    expect(result).toEqual({ status: "feature-disabled" });
    await expect(fs.stat(path.join(stateDirectory, "analysis"))).rejects.toThrow();
  });

  it("只读主体调用 build/feedback ⇒ 拒绝（主 Agent 与思索模式）", async () => {
    const service = buildService(true);
    expect(
      await executeDiagnosticClusterAction({ action: "build", context: context(service, true) }),
    ).toEqual({ status: "permission-denied", reason: "只读主体不得调用写 action" });
    expect(
      await executeDiagnosticClusterAction({ action: "feedback", context: context(service, true) }),
    ).toEqual({ status: "permission-denied", reason: "只读主体不得调用写 action" });
  });

  it("未知 action 不得被当成只读放行", async () => {
    const service = buildService(true);
    const result = await executeDiagnosticClusterAction({
      action: "makeMeASandwich",
      context: context(service, false),
    });
    expect(result).toEqual({ status: "permission-denied", reason: "未知 action" });
  });

  it("可写主体 build ⇒ 成功；只读主体 list 也可用", async () => {
    const service = buildService(true);
    const built = await executeDiagnosticClusterAction({
      action: "build",
      context: context(service, false),
    });
    expect(built.status).toBe("ok");
    const listed = await executeDiagnosticClusterAction({
      action: "list",
      context: context(service, true),
    });
    expect(listed.status).toBe("ok");
  });

  it("feedback 尚未实现时必须显式拒绝（不得假装成功）", async () => {
    const service = buildService(true);
    const result = await executeDiagnosticClusterAction({
      action: "feedback",
      context: context(service, false),
    });
    expect(result).toEqual({ status: "permission-denied", reason: "feedback-store-not-implemented" });
  });
});
