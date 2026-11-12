/**
 * CLUSTER-01 §5：应用级服务的开关语义。
 *
 * 反例重点：
 * - 关闭时**不得产生任何副作用**（不建目录、不写文件）；
 * - "关闭"与"已开启但还没构建过"必须**分别报告**，不能都当成"没有错误"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiagnosticClusterService } from "../../../packages/core/src/orchestration/diagnostic-cluster-service.js";
import { DiagnosticEventStore } from "../../../packages/core/src/orchestration/diagnostic-event-store.js";
import { toDiagnosticClusterInput } from "../../../packages/core/src/orchestration/diagnostic-clusterer.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cluster01-service-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildEvent(index: number) {
  return {
    observeEventVersion: 1,
    eventType: "diagnostic",
    recordedAtIso: `2026-11-11T00:00:0${String(index)}.000Z`,
    sourceAgentInstanceId: "worker-1",
    missionIdentifier: "mission-1",
    taskIdentifier: "T-001",
    requestIdentifier: `req-${String(index)}`,
    requestRevision: 1,
    origin: { kind: "provider" },
    errorCode: "E_TIMEOUT",
    stage: "execute",
    severity: "error",
    component: "worker",
    messageText: "连接超时 timeout 重试",
    recoveryState: "unknown",
    classification: "transient",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
  } as never;
}

const indexRoot = () => path.join(stateDirectory, "analysis", "diagnostic-clusters");

describe("CLUSTER-01 服务：开关与状态区分", () => {
  it("**默认关闭**：返回 disabled、不读取、不创建任何目录", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(buildEvent(1));
    const service = new DiagnosticClusterService({
      store,
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
    });
    expect(service.isDiagnosticClusteringEnabled()).toBe(false);
    expect(await service.buildSnapshot({
      projectIdentifier: "project-alpha",
      /** 用当前时间：避免"写入当天才通过"的时间炸弹（TTL 24h）。 */
      generatedAtIso: new Date().toISOString(),
      resolveProjectIdentifier: () => "project-alpha",
    })).toEqual({ status: "disabled" });
    expect(await service.readLatest("project-alpha")).toEqual({ status: "disabled" });
    /** 关键：关闭时不留任何痕迹。 */
    await expect(fs.stat(indexRoot())).rejects.toThrow();
  });

  it("开启但未构建过 ⇒ no-snapshot（与 disabled 区分，不伪装成空结果）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    const service = new DiagnosticClusterService({
      store,
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: true,
    });
    expect(await service.readLatest("project-alpha")).toEqual({ status: "no-snapshot" });
  });

  it("开启 ⇒ 构建落盘，可读回并检索相似案例", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    await store.append(buildEvent(1));
    await store.append(buildEvent(2));
    const service = new DiagnosticClusterService({
      store,
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: true,
    });

    const built = await service.buildSnapshot({
      projectIdentifier: "project-alpha",
      /** 用当前时间：避免"写入当天才通过"的时间炸弹（TTL 24h）。 */
      generatedAtIso: new Date().toISOString(),
      resolveProjectIdentifier: () => "project-alpha",
    });
    expect(built.status).toBe("built");
    if (built.status !== "built") throw new Error("unreachable");
    expect(built.snapshot.isComplete).toBe(true);
    expect(built.latestUpdated).toBe(true);

    const latest = await service.readLatest("project-alpha");
    expect(latest.status).toBe("ready");

    const query = toDiagnosticClusterInput(buildEvent(3), "project-alpha");
    const related = await service.findRelated({ projectIdentifier: "project-alpha", event: query });
    expect(related.status).toBe("ready");
    if (related.status !== "ready") throw new Error("unreachable");
    expect(related.result.cases.length).toBeGreaterThan(0);
    /** 相似度不是根因置信度（卡内要求显式声明）。 */
    expect(related.result.isRootCauseConfidence).toBe(false);
  });

  it("开启但从未构建 ⇒ findRelated 返回 no-snapshot（不是空案例列表）", async () => {
    const store = new DiagnosticEventStore({ baseDirectory: stateDirectory });
    const service = new DiagnosticClusterService({
      store,
      stateDirectory,
      algorithmVersion: "diagnostic-cluster-v1",
      isEnabled: true,
    });
    const related = await service.findRelated({
      projectIdentifier: "project-alpha",
      event: toDiagnosticClusterInput(buildEvent(1), "project-alpha"),
    });
    expect(related).toEqual({ status: "no-snapshot" });
  });
});
