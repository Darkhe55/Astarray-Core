/**
 * 运行中任务插入契约（此前 `tests/` 零引用）。
 *
 * 关键在于**判定顺序**与**不信任输入**：
 * 幂等 → revision → 锚点 → 组是否还能接；未知字段一律拒绝（不得塞入 status/sourceKind 等权威字段）。
 */
import { describe, expect, it } from "vitest";

import {
  computeInsertionRequestFingerprint,
  decideTaskGroupInsertion,
  parseRuntimeTaskInsertionRequest,
} from "../../../packages/core/src/orchestration/task-group-insertion-contract.js";
import type {
  RuntimeTaskInsertionRequest,
  TaskGroupInsertionGroupState,
} from "../../../packages/core/src/orchestration/task-group-insertion-contract.js";

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    missionIdentifier: "mission-1",
    requestIdentifier: "request-1",
    expectedGroupRevision: 3,
    anchorTaskIdentifier: "T-001",
    title: "补一个任务",
    description: "描述",
    acceptanceCriteria: "验收标准",
    dependsOn: ["T-001"],
    ...overrides,
  };
}

function buildRequest(overrides: Partial<RuntimeTaskInsertionRequest> = {}): RuntimeTaskInsertionRequest {
  return {
    missionIdentifier: "mission-1",
    requestIdentifier: "request-1",
    expectedGroupRevision: 3,
    anchorTaskIdentifier: "T-001",
    title: "补一个任务",
    description: "描述",
    acceptanceCriteria: "验收标准",
    dependsOn: ["T-001"],
    ...overrides,
  };
}

function buildGroup(overrides: Partial<TaskGroupInsertionGroupState> = {}): TaskGroupInsertionGroupState {
  return {
    groupIdentifier: "group-1",
    revision: 3,
    isClosed: false,
    taskStates: { "T-001": "completed" },
    hasIssuedToolCallsAfterAnchor: false,
    ...overrides,
  };
}

describe("插入请求解析", () => {
  it("① 非对象 / 数组 ⇒ 拒绝", () => {
    expect(() => parseRuntimeTaskInsertionRequest(null)).toThrow(/必须是 JSON 对象/u);
    expect(() => parseRuntimeTaskInsertionRequest([])).toThrow(/必须是 JSON 对象/u);
  });

  it("② 未知字段 ⇒ 拒绝（不得静默忽略权威字段）", () => {
    expect(() =>
      parseRuntimeTaskInsertionRequest(validPayload({ status: "completed" })),
    ).toThrow(/不支持的字段/u);
    expect(() =>
      parseRuntimeTaskInsertionRequest(validPayload({ sourceKind: "model" })),
    ).toThrow(/不支持的字段/u);
  });

  it("③ expectedGroupRevision 非法 ⇒ 拒绝", () => {
    for (const invalid of [-1, 1.5, "3", undefined]) {
      expect(() =>
        parseRuntimeTaskInsertionRequest(validPayload({ expectedGroupRevision: invalid })),
      ).toThrow(/expectedGroupRevision/u);
    }
  });

  it("④ 必填字符串为空 ⇒ 拒绝；anchor 空串 ⇒ null；dependsOn 去空", () => {
    expect(() => parseRuntimeTaskInsertionRequest(validPayload({ title: "  " }))).toThrow(
      /必须是非空字符串/u,
    );
    expect(() => parseRuntimeTaskInsertionRequest(validPayload({ dependsOn: "T-001" }))).toThrow(
      /必须是字符串数组/u,
    );
    const parsed = parseRuntimeTaskInsertionRequest(
      validPayload({ anchorTaskIdentifier: "   ", dependsOn: [" T-001 ", ""] }),
    );
    expect(parsed.anchorTaskIdentifier).toBeNull();
    expect(parsed.dependsOn).toEqual(["T-001"]);
  });
});

describe("请求指纹", () => {
  it("⑤ dependsOn 顺序不影响指纹；title 变化影响指纹", () => {
    const base = buildRequest({ dependsOn: ["T-001", "T-002"] });
    const reordered = buildRequest({ dependsOn: ["T-002", "T-001"] });
    expect(computeInsertionRequestFingerprint(base)).toBe(computeInsertionRequestFingerprint(reordered));
    expect(computeInsertionRequestFingerprint(buildRequest({ title: "另一个任务" }))).not.toBe(
      computeInsertionRequestFingerprint(base),
    );
  });
});

describe("插入判定顺序", () => {
  it("⑥ 幂等优先：revision 已过期但同键同内容 ⇒ duplicate（不误报 stale）", () => {
    const request = buildRequest();
    const decision = decideTaskGroupInsertion({
      request,
      group: buildGroup({ revision: 9 }),
      existingRequestFingerprint: computeInsertionRequestFingerprint(request),
    });
    expect(decision.outcome).toBe("duplicate");
  });

  it("⑦ 同键异内容 ⇒ idempotency-conflict（拒绝覆盖）", () => {
    const decision = decideTaskGroupInsertion({
      request: buildRequest(),
      group: buildGroup(),
      existingRequestFingerprint: computeInsertionRequestFingerprint(
        buildRequest({ title: "旧内容" }),
      ),
    });
    expect(decision.outcome).toBe("idempotency-conflict");
  });

  it("⑧ revision 不符 ⇒ stale-revision-rejected，且原因要求重读而非盲重试", () => {
    const decision = decideTaskGroupInsertion({
      request: buildRequest({ expectedGroupRevision: 2 }),
      group: buildGroup({ revision: 3 }),
      existingRequestFingerprint: null,
    });
    expect(decision.outcome).toBe("stale-revision-rejected");
    expect(decision.reason).toContain("重新读取组状态");
  });

  it("⑨ 锚点不存在 ⇒ invalid-anchor-rejected", () => {
    const decision = decideTaskGroupInsertion({
      request: buildRequest({ anchorTaskIdentifier: "T-999" }),
      group: buildGroup(),
      existingRequestFingerprint: null,
    });
    expect(decision.outcome).toBe("invalid-anchor-rejected");
  });

  it("⑩ 组已关闭 / 锚点后已发工具调用 ⇒ deferred-to-next-group", () => {
    const closed = decideTaskGroupInsertion({
      request: buildRequest(),
      group: buildGroup({ isClosed: true }),
      existingRequestFingerprint: null,
    });
    expect(closed.outcome).toBe("deferred-to-next-group");

    const toolCallsIssued = decideTaskGroupInsertion({
      request: buildRequest(),
      group: buildGroup({ hasIssuedToolCallsAfterAnchor: true }),
      existingRequestFingerprint: null,
    });
    expect(toolCallsIssued.outcome).toBe("deferred-to-next-group");
  });

  it("⑪ 一切正常 ⇒ insert-now", () => {
    const decision = decideTaskGroupInsertion({
      request: buildRequest(),
      group: buildGroup(),
      existingRequestFingerprint: null,
    });
    expect(decision.outcome).toBe("insert-now");
  });
});
