/**
 * COORD-05 控制面编排（2026-11-22）：请求记录 → 路由 → 处置链 → 用户呈交/决定写回。
 *
 * 覆盖：worker 打开并本层结案（上层零消息）、逐级转交、主层直达用户、
 * 幂等打开、并发版本保护、未知发送者拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EscalationRequestStore,
  EscalationWorkflow,
} from "../../../packages/core/src/orchestration/escalation-workflow.js";
import type { EscalationRecord } from "../../../packages/core/src/orchestration/escalation-contract.js";

let baseDirectory: string;
let store: EscalationRequestStore;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-coord05-flow-"));
  store = new EscalationRequestStore({ baseDirectory });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const creators: Record<string, string | null> = { w1: "s1", s1: "m1", m1: null };

function emptyCallbacks(): { submitted: EscalationRecord[]; resolved: EscalationRecord[] } {
  return { submitted: [], resolved: [] };
}

function makeWorkflow(callbacks: {
  submitted: EscalationRecord[];
  resolved: EscalationRecord[];
}): EscalationWorkflow {
  return new EscalationWorkflow({
    store,
    resolveCreatorOf: async (agentInstanceId) => creators[agentInstanceId] ?? null,
    isAgentKnown: async (agentInstanceId) => agentInstanceId in creators,
    onSubmitToUser: async (record) => {
      callbacks.submitted.push(record);
      return { receiptIdentifier: "receipt-" + record.requestIdentifier };
    },
    onResolved: async (record) => {
      callbacks.resolved.push(record);
    },
  });
}

function openInput(overrides: Record<string, unknown> = {}) {
  return {
    requestIdentifier: "escalation-1",
    senderAgentInstanceId: "w1",
    projectIdentifier: "p1",
    missionIdentifier: "m-1",
    taskIdentifier: "T-1",
    affectedStepIdentifiers: ["step-export"],
    questionSummary: "导出方式需要确认",
    documentReferences: [{ documentIdentifier: "docs/spec.md", revision: 2 }],
    nowIso: "2026-11-22T00:00:00.000Z",
    ...overrides,
  } as never;
}

describe("COORD-05 控制面编排", () => {
  it("① 打开：worker ⇒ 直属上级；重复打开幂等", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    const first = await workflow.open(openInput());
    expect(first).toMatchObject({ kind: "opened", target: { kind: "agent", agentInstanceId: "s1" } });
    const second = await workflow.open(openInput());
    expect(second.kind).toBe("existing");
    expect(await store.list()).toHaveLength(1);
  });

  it("② 本层结案 ⇒ resolved 回调一次，上层不再收到消息", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    await workflow.open(openInput());
    const outcome = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: 1,
      handlerAgentInstanceId: "s1",
      disposition: "resolved",
      reason: "本层有材料，直接拍板",
      referencedDocumentIdentifiers: ["docs/spec.md"],
      handledAtIso: "2026-11-22T00:01:00.000Z",
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") return;
    expect(outcome.record.state).toBe("resolved-by-agent");
    expect(callbacks.resolved).toHaveLength(1);
    expect(callbacks.submitted).toHaveLength(0);

    /** 终态后不再接受追加 ⇒ 上层零消息。 */
    const again = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: outcome.record.version,
      handlerAgentInstanceId: "s1",
      disposition: "forwarded",
      reason: "再转",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:02:00.000Z",
      forwardToAgentInstanceId: "m1",
    });
    expect(again).toMatchObject({ kind: "refused", code: "already-terminal" });
  });

  it("③ 逐级转交：s1 → m1，m1 呈交用户一次", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    await workflow.open(openInput());
    const forwarded = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: 1,
      handlerAgentInstanceId: "s1",
      disposition: "forwarded",
      reason: "超出本层权限",
      referencedDocumentIdentifiers: ["docs/spec.md"],
      handledAtIso: "2026-11-22T00:01:00.000Z",
      forwardToAgentInstanceId: "m1",
    });
    expect(forwarded.kind).toBe("updated");
    if (forwarded.kind !== "updated") return;
    expect(forwarded.record.currentHandlerAgentInstanceId).toBe("m1");
    /** 只是转交：不得触发"本层结案"的写回。 */
    expect(callbacks.resolved).toHaveLength(0);

    const submitted = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: forwarded.record.version,
      handlerAgentInstanceId: "m1",
      disposition: "needs-user",
      reason: "主层也无法决断",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:02:00.000Z",
    });
    expect(submitted.kind).toBe("submitted-to-user");
    expect(callbacks.submitted).toHaveLength(1);
    expect(callbacks.submitted[0]?.state).toBe("needs-user");
  });

  it("④ 主层打开 ⇒ 目标即用户通道，不征询同级", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    const opened = await workflow.open(openInput({ senderAgentInstanceId: "m1" }));
    expect(opened).toMatchObject({ kind: "opened", target: { kind: "user" } });
    if (opened.kind !== "opened") return;
    expect(opened.record.currentHandlerAgentInstanceId).toBeNull();

    const submitted = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: opened.record.version,
      handlerAgentInstanceId: "m1",
      disposition: "needs-user",
      reason: "需要用户拍板",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:03:00.000Z",
    });
    expect(submitted.kind).toBe("submitted-to-user");
    expect(callbacks.submitted).toHaveLength(1);
  });

  it("⑤ 并发版本保护：过期版本 ⇒ 拒绝且不写", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    await workflow.open(openInput());
    const outcome = await workflow.handle({
      requestIdentifier: "escalation-1",
      expectedVersion: 0,
      handlerAgentInstanceId: "s1",
      disposition: "resolved",
      reason: "x",
      referencedDocumentIdentifiers: [],
      handledAtIso: "2026-11-22T00:04:00.000Z",
    });
    expect(outcome).toMatchObject({ kind: "refused", code: "stale-version" });
    const persisted = await workflow.get("escalation-1");
    expect(persisted?.version).toBe(1);
    expect(persisted?.dispositions).toHaveLength(0);
  });

  it("⑥ 未登记发送者 ⇒ 打开被拒绝（不建记录）", async () => {
    const callbacks = emptyCallbacks();
    const workflow = makeWorkflow(callbacks);
    const outcome = await workflow.open(openInput({ senderAgentInstanceId: "ghost" }));
    expect(outcome).toMatchObject({ kind: "refused", code: "unknown-sender" });
    expect(await store.list()).toHaveLength(0);
  });
});
