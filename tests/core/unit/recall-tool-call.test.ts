/**
 * WIRING-04-05：回访工具调用适配层的反例。
 *
 * 覆盖：身份/执行标识只能由 harness 注入、请求字段由 harness 组装、非法参数明确拒绝、
 * 控制器结果原样返回、拒绝路径不静默。
 */
import { describe, expect, it, vi } from "vitest";

import { executeRecallToolCall } from "../../../packages/core/src/orchestration/recall-tool-call.js";

const OK_RESULT = {
  status: "ok",
  contextNodeIdentifier: "node-1",
  sourceRevision: 4,
  scope: "summary",
  text: "已关闭节点的正文",
  injectedTokenCount: 12,
} as never;

const HARNESS = { callerAgentInstanceId: "worker-1", taskExecutionId: "task-exec:worker-1" };

const validArguments = JSON.stringify({
  contextNodeIdentifier: "node-1",
  nodeRevision: 4,
  reasonCode: "user-new-requirement",
  requiredInformation: "需要历史验收结论",
  maximumTokenCount: 256,
});

describe("WIRING-04-05：回访工具调用", () => {
  it("① 身份与执行标识由 harness 注入，请求由 harness 组装", async () => {
    const recall = vi.fn(async (_input: unknown) => OK_RESULT);
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: validArguments,
      recall,
    });
    expect(outcome.isOk).toBe(true);
    const recallInput = recall.mock.calls[0]?.[0] as unknown as {
      callerAgentInstanceId: string;
      request: Record<string, unknown>;
    };
    expect(recallInput.callerAgentInstanceId).toBe("worker-1");
    /** 控制器契约字段由 harness 填写。 */
    expect(recallInput.request).toMatchObject({
      schemaVersion: 1,
      taskExecutionId: "task-exec:worker-1",
      contextNodeIdentifier: "node-1",
      nodeRevision: 4,
      reasonCode: "user-new-requirement",
      requiredInformation: "需要历史验收结论",
      maximumTokenCount: 256,
    });
    expect(typeof recallInput.request["requestId"]).toBe("string");
    expect(outcome.contentText).toContain("已关闭节点的正文");
  }, 30_000);

  it("② 模型不得自带调用者身份 ⇒ 拒绝", async () => {
    const recall = vi.fn(async () => OK_RESULT);
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: JSON.stringify({
        callerAgentInstanceId: "worker-2",
        contextNodeIdentifier: "node-1",
        nodeRevision: 4,
        reasonCode: "user-new-requirement",
        requiredInformation: "x",
      }),
      recall,
    });
    expect(outcome.isOk).toBe(false);
    expect(outcome.contentText).toContain("调用者身份不得由模型提供");
    expect(recall).not.toHaveBeenCalled();
  }, 30_000);

  it("③ 模型不得伪造 schemaVersion/requestId/taskExecutionId ⇒ 拒绝", async () => {
    const recall = vi.fn(async () => OK_RESULT);
    for (const forgedField of ["schemaVersion", "requestId", "taskExecutionId"]) {
      const outcome = await executeRecallToolCall({
        ...HARNESS,
        argumentsJson: JSON.stringify({
          contextNodeIdentifier: "node-1",
          nodeRevision: 4,
          reasonCode: "user-new-requirement",
          requiredInformation: "x",
          [forgedField]: 1,
        }),
        recall,
      });
      expect(outcome.isOk).toBe(false);
      expect(outcome.contentText).toContain("由 harness 填写");
    }
    expect(recall).not.toHaveBeenCalled();
  }, 30_000);

  it("④ 非法 JSON ⇒ 明确拒绝（不是静默空结果）", async () => {
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: "{",
      recall: async () => OK_RESULT,
    });
    expect(outcome.isOk).toBe(false);
    expect(outcome.contentText).toContain("context-recall-invalid");
  }, 30_000);

  it("⑤ 空身份 ⇒ 拒绝且不调用控制器", async () => {
    const recall = vi.fn(async () => OK_RESULT);
    const outcome = await executeRecallToolCall({
      callerAgentInstanceId: "   ",
      taskExecutionId: "task-exec:x",
      argumentsJson: validArguments,
      recall,
    });
    expect(outcome.isOk).toBe(false);
    expect(recall).not.toHaveBeenCalled();
  }, 30_000);

  it("⑥ 缺必需字段（无 requiredInformation）⇒ 拒绝，不调用控制器", async () => {
    const recall = vi.fn(async () => OK_RESULT);
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: JSON.stringify({
        contextNodeIdentifier: "node-1",
        nodeRevision: 4,
        reasonCode: "user-new-requirement",
      }),
      recall,
    });
    expect(outcome.isOk).toBe(false);
    expect(outcome.contentText).toContain("requiredInformation");
    expect(recall).not.toHaveBeenCalled();
  }, 30_000);

  it("⑦ 控制器拒绝 ⇒ 原样返回 refused（不包装成成功）", async () => {
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: validArguments,
      recall: async () =>
        ({
          status: "refused",
          errorCode: "context-recall-invalid",
          reason: "超出任务回访预算",
        }) as never,
    });
    expect(outcome.isOk).toBe(false);
    expect(outcome.contentText).toContain("超出任务回访预算");
  }, 30_000);
});

describe("WIRING-04-05：候选索引（仅标识与 revision）", () => {
  it("⑧ 节点找不到 ⇒ 附候选（最多 5 条，且不含正文）", async () => {
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: validArguments,
      recall: async () => ({ status: "not-found" } as never),
      listCandidateReferences: async () => [
        { contextNodeIdentifier: "node-1", sourceRevision: 4 },
        { contextNodeIdentifier: "node-2", sourceRevision: 5 },
        { contextNodeIdentifier: "node-3", sourceRevision: 6 },
        { contextNodeIdentifier: "node-4", sourceRevision: 7 },
        { contextNodeIdentifier: "node-5", sourceRevision: 8 },
        { contextNodeIdentifier: "node-6", sourceRevision: 9 },
      ],
    });
    expect(outcome.isOk).toBe(false);
    const parsed = JSON.parse(outcome.contentText) as {
      candidates: Array<{ contextNodeIdentifier: string; sourceRevision: number; text?: string }>;
    };
    expect(parsed.candidates).toHaveLength(5);
    expect(parsed.candidates[0]).toEqual({ contextNodeIdentifier: "node-1", sourceRevision: 4 });
    expect(parsed.candidates.some((candidate) => candidate.text !== undefined)).toBe(false);
  }, 30_000);

  it("⑨ 成功回访 ⇒ 不附候选（候选只在找不到时给）", async () => {
    const outcome = await executeRecallToolCall({
      ...HARNESS,
      argumentsJson: validArguments,
      recall: async () => OK_RESULT,
      listCandidateReferences: async () => [{ contextNodeIdentifier: "node-1", sourceRevision: 4 }],
    });
    expect(outcome.isOk).toBe(true);
    expect(outcome.contentText).not.toContain("candidates");
  }, 30_000);
});
