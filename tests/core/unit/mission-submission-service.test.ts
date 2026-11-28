/**
 * MISSION-WRITE-01 切片 3/4（2026-11-28）：任务提交编排服务的反例。
 *
 * 服务不持有状态：任务表、幂等账本、指令窗口、监视器全部经端口注入；
 * 这里用假端口验证**控制流与顺序**（排队不启动、受理后结算、错误码来自端口）。
 */
import { describe, expect, it, vi } from "vitest";

import {
  MissionSubmissionService,
  type MissionSubmissionServicePorts,
  type MissionTaskRecordData,
} from "../../../packages/core/src/orchestration/mission-submission-service.js";

function buildService(overrides: Partial<MissionSubmissionServicePorts> = {}) {
  const records = new Map<string, MissionTaskRecordData>();
  const ledger = new Map<string, Parameters<MissionSubmissionServicePorts["claimIdempotency"]>[1]>();
  const ports: MissionSubmissionServicePorts = {
    assertOpen: vi.fn(),
    requireSession: vi.fn(),
    findIdempotencyEntry: (key) => ledger.get(key),
    findTaskRecord: (taskIdentifier) => records.get(taskIdentifier),
    currentMode: () => "assist",
    validateTargetAgentInstance: vi.fn(async () => undefined),
    validateWorkspaceRootPath: vi.fn(async () => undefined),
    admitInstruction: vi.fn(async () => ({ kind: "unwindowed" as const })),
    submitPromptToController: vi.fn(async () => "mission-1"),
    registerTaskRecord: (taskIdentifier, record) => {
      records.set(taskIdentifier, record);
    },
    markTaskQueued: vi.fn(),
    claimIdempotency: async (key, entry) => {
      ledger.set(key, entry);
    },
    settleIdempotencyClaim: async (key, missionIdentifier) => {
      const entry = ledger.get(key);
      if (entry !== undefined) {
        ledger.set(key, { ...entry, missionIdentifier, settledAtIso: "2026-11-28T10:00:01.000Z" });
      }
    },
    emitTaskStatus: vi.fn(),
    startTaskMonitor: vi.fn(),
    toTaskResult: (taskIdentifier, record) => ({
      taskIdentifier,
      status: record.status,
      missionIdentifier: record.missionIdentifier,
      summaryPreview: record.summaryPreview,
    }),
    createPublicError: (errorCode, message) => {
      const error = new Error(message);
      (error as Error & { errorCode?: string }).errorCode = errorCode;
      return error;
    },
    nowIso: () => "2026-11-28T10:00:00.000Z",
    ...overrides,
  };
  return { service: new MissionSubmissionService(ports), ports, records, ledger };
}

const baseInput = {
  sessionId: "session-1",
  taskIdentifier: "task-1",
  prompt: "做一件事",
};

describe("MISSION-WRITE-01：提交编排服务", () => {
  it("① 窗口满 ⇒ 排队：不提交控制器、不启动监视器，记录 status=queued", async () => {
    const { service, ports, records } = buildService({
      admitInstruction: vi.fn(async () => ({
        kind: "queued" as const,
        link: { instructionIdentifier: "instr-1", instructionRevision: 1 },
      })),
    });
    const result = await service.submitTask(baseInput);
    expect(result).toMatchObject({ taskIdentifier: "task-1", status: "queued" });
    expect(ports.submitPromptToController).not.toHaveBeenCalled();
    expect(ports.startTaskMonitor).not.toHaveBeenCalled();
    expect(ports.markTaskQueued).toHaveBeenCalledWith("task-1");
    expect(records.get("task-1")).toMatchObject({ status: "queued", queuedPrompt: "做一件事" });
    expect(ports.emitTaskStatus).toHaveBeenCalledWith({
      taskIdentifier: "task-1",
      status: "queued",
      revision: 0,
    });
  });

  it("② 窗口内 ⇒ 提交控制器、记录接受、结算幂等 claim、启动监视器", async () => {
    const { service, ports, records } = buildService({
      admitInstruction: vi.fn(async () => ({
        kind: "windowed" as const,
        link: { instructionIdentifier: "instr-1", instructionRevision: 1 },
      })),
    });
    const result = await service.submitTask({ ...baseInput, idempotencyKey: "key-1" });
    expect(result).toMatchObject({ status: "accepted", missionIdentifier: "mission-1" });
    expect(ports.submitPromptToController).toHaveBeenCalledWith({
      prompt: "做一件事",
      sessionId: "session-1",
    });
    expect(records.get("task-1")).toMatchObject({
      status: "accepted",
      missionIdentifier: "mission-1",
      instructionLink: { instructionIdentifier: "instr-1", instructionRevision: 1 },
    });
    expect(ports.startTaskMonitor).toHaveBeenCalledWith("task-1");
    const settled = await Promise.resolve(
      (ports.findIdempotencyEntry as (key: string) => { missionIdentifier: string | null } | undefined)(
        "session-1|key-1",
      ),
    );
    expect(settled?.missionIdentifier).toBe("mission-1");
  });

  it("③ ponder 模式 ⇒ invalid-mode-transition（不提交）", async () => {
    const { service, ports } = buildService({ currentMode: () => "ponder" });
    await expect(service.submitTask(baseInput)).rejects.toMatchObject({
      errorCode: "invalid-mode-transition",
    });
    expect(ports.submitPromptToController).not.toHaveBeenCalled();
  });

  it("④ 同键同参未结算 ⇒ idempotency-claim-pending；异参 ⇒ idempotency-key-conflict", async () => {
    const { service, ledger } = buildService();
    ledger.set("session-1|key-1", {
      sessionIdentifier: "session-1",
      idempotencyKey: "key-1",
      inputHash: "different-hash",
      taskIdentifier: "task-old",
      missionIdentifier: null,
      claimedAtIso: "2026-11-28T09:00:00.000Z",
      settledAtIso: null,
    });
    await expect(
      service.submitTask({ ...baseInput, idempotencyKey: "key-1" }),
    ).rejects.toMatchObject({ errorCode: "idempotency-key-conflict" });

    const same = buildService();
    same.ledger.set("session-1|key-1", {
      sessionIdentifier: "session-1",
      idempotencyKey: "key-1",
      inputHash: "will-not-match-unless-hash-equal",
      taskIdentifier: "task-old",
      missionIdentifier: null,
      claimedAtIso: "2026-11-28T09:00:00.000Z",
      settledAtIso: null,
    });
    /** 先取得真实哈希：用一次成功提交的 claim 记录（同 prompt）。 */
    const probe = buildService();
    await probe.service.submitTask({ ...baseInput, idempotencyKey: "probe" });
    const realHash = probe.ledger.get("session-1|probe")?.inputHash;
    expect(realHash).toBeDefined();
    same.ledger.set("session-1|key-1", {
      sessionIdentifier: "session-1",
      idempotencyKey: "key-1",
      inputHash: realHash ?? "",
      taskIdentifier: "task-old",
      missionIdentifier: null,
      claimedAtIso: "2026-11-28T09:00:00.000Z",
      settledAtIso: null,
    });
    await expect(
      same.service.submitTask({ ...baseInput, idempotencyKey: "key-1" }),
    ).rejects.toMatchObject({ errorCode: "idempotency-claim-pending" });
  });

  it("⑤ 已存在同会话任务 ⇒ reuse：不提交、不结算、不启动监视器", async () => {
    const { service, ports } = buildService();
    ports.registerTaskRecord("task-1", {
      sessionId: "session-1",
      missionIdentifier: "mission-old",
      status: "running",
      summaryPreview: "旧",
      revision: 3,
      instructionLink: null,
      queuedPrompt: null,
    });
    const result = await service.submitTask(baseInput);
    expect(result).toMatchObject({ missionIdentifier: "mission-old", status: "running" });
    expect(ports.submitPromptToController).not.toHaveBeenCalled();
    expect(ports.startTaskMonitor).not.toHaveBeenCalled();
  });

  it("⑥ 跨会话同名任务 ⇒ session-mismatch", async () => {
    const { service, ports } = buildService();
    ports.registerTaskRecord("task-1", {
      sessionId: "session-other",
      missionIdentifier: null,
      status: "queued",
      summaryPreview: null,
      revision: 0,
      instructionLink: null,
      queuedPrompt: null,
    });
    await expect(service.submitTask(baseInput)).rejects.toMatchObject({
      errorCode: "session-mismatch",
    });
  });

  it("⑦ 目标 Agent / 执行根仅在提供时校验，且校验失败即中止", async () => {
    const { service, ports } = buildService();
    await service.submitTask(baseInput);
    expect(ports.validateTargetAgentInstance).not.toHaveBeenCalled();
    expect(ports.validateWorkspaceRootPath).not.toHaveBeenCalled();

    const failing = buildService({
      validateTargetAgentInstance: async () => {
        throw Object.assign(new Error("目标 Agent 不存在或已回收: agent-x"), {
          errorCode: "target-agent-invalid",
        });
      },
    });
    await expect(
      failing.service.submitTask({ ...baseInput, targetAgentInstanceIdentifier: "agent-x" }),
    ).rejects.toMatchObject({ errorCode: "target-agent-invalid" });
    expect(failing.ports.submitPromptToController).not.toHaveBeenCalled();
  });

  it("⑧ 控制器提交失败 ⇒ 端口抛出的 submit-failed 原样上抛", async () => {
    const { service } = buildService({
      submitPromptToController: async () => {
        throw Object.assign(new Error("任务提交失败: boom"), { errorCode: "submit-failed" });
      },
    });
    await expect(service.submitTask(baseInput)).rejects.toMatchObject({
      errorCode: "submit-failed",
    });
  });
});
