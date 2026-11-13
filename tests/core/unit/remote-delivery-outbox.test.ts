/**
 * 远端投递 outbox（此前 `tests/` 零引用）。
 *
 * **不接真实远端**：传输是端口，测试用假实现驱动，验证的是纯逻辑契约——
 * 默认拒绝、入队幂等但不允许"换内容复用同一 operation"、"端口已受理 ≠ 已送达"、
 * 结果未知时**不自动重试**、目标不可被自动切换。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RemoteDeliveryOutbox,
  assertRemoteDeliveryTargetUnchanged,
  attemptRemoteDelivery,
  validateRemoteDeliveryOperation,
} from "../../../packages/core/src/orchestration/remote-delivery-outbox.js";
import type {
  RemoteDeliveryReceipt,
  RemoteDeliveryTransportPort,
} from "../../../packages/core/src/orchestration/remote-delivery-outbox.js";

let baseDirectory: string;
const CONTENT_HASH = `sha256:${"a".repeat(64)}`;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-outbox-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildOperationInput(overrides: Record<string, unknown> = {}) {
  return {
    operationIdentifier: "operation-1",
    interactionRevision: 1,
    exportIdentifier: "export-1",
    bindingIdentifier: "binding-1",
    targetAccountIdentifier: "account-1",
    targetDeviceIdentifier: null,
    contentHash: CONTENT_HASH,
    authorizationRevision: 1,
    recordKindCount: 3,
    createdAtIso: "2026-11-13T00:00:00.000Z",
    ...overrides,
  } as never;
}

function buildTransport(options: {
  receipts?: Array<RemoteDeliveryReceipt | null>;
  sendStatus?: "accepted" | "rejected";
  sendDetail?: string;
} = {}) {
  const receipts = [...(options.receipts ?? [null])];
  const send = vi.fn(async () => ({
    status: options.sendStatus ?? ("accepted" as const),
    ...(options.sendDetail === undefined ? {} : { detail: options.sendDetail }),
  }));
  const readReceipt = vi.fn(async () => receipts.shift() ?? null);
  const transport: RemoteDeliveryTransportPort = { send, readReceipt } as never;
  return { transport, send, readReceipt };
}

describe("operation 完整性校验（纯函数）", () => {
  it("① 合法输入 ⇒ complete 且无原因", () => {
    const result = validateRemoteDeliveryOperation(buildOperationInput());
    expect(result).toEqual({ isComplete: true, reasons: [] });
  });

  it("② 缺标识/目标账户 ⇒ 各自给出原因", () => {
    const result = validateRemoteDeliveryOperation(
      buildOperationInput({
        operationIdentifier: " ",
        exportIdentifier: "",
        bindingIdentifier: "",
        targetAccountIdentifier: "",
      }),
    );
    expect(result.isComplete).toBe(false);
    const joined = result.reasons.join("|");
    expect(joined).toContain("缺少 operationIdentifier");
    expect(joined).toContain("缺少 exportIdentifier");
    expect(joined).toContain("缺少 bindingIdentifier");
    expect(joined).toContain("缺少目标账户");
  });

  it("③ revision 非正整数 ⇒ 拒绝（交互与授权各自校验）", () => {
    for (const overrides of [
      { interactionRevision: 0 },
      { interactionRevision: 1.5 },
      { authorizationRevision: 0 },
    ]) {
      const result = validateRemoteDeliveryOperation(buildOperationInput(overrides));
      expect(result.isComplete).toBe(false);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it("④ contentHash 格式非法 ⇒ 拒绝（必须是 sha256:<64 hex>）", () => {
    const result = validateRemoteDeliveryOperation(
      buildOperationInput({ contentHash: "abc123" }),
    );
    expect(result.isComplete).toBe(false);
    expect(result.reasons.join("|")).toContain("内容 hash 格式非法");
  });

  it("⑤ 设备标识空串 ⇒ 拒绝（账户级授权应传 null）；账户过长 ⇒ 拒绝", () => {
    expect(
      validateRemoteDeliveryOperation(buildOperationInput({ targetDeviceIdentifier: "  " })).reasons.join(
        "|",
      ),
    ).toContain("设备标识为空字符串");
    expect(
      validateRemoteDeliveryOperation(
        buildOperationInput({ targetAccountIdentifier: "x".repeat(257) }),
      ).reasons.join("|"),
    ).toContain("目标账户标识过长");
  });
});

describe("入队", () => {
  it("⑥ 不完整 ⇒ 抛错且不落盘", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await expect(
      outbox.enqueue(buildOperationInput({ contentHash: "not-a-hash" })),
    ).rejects.toThrow(/不完整/u);
    expect(await outbox.find("operation-1")).toBeNull();
  });

  it("⑦ 首次入队 ⇒ pending、revision 递增", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    const result = await outbox.enqueue(buildOperationInput());
    expect(result.wasEnqueued).toBe(true);
    expect(result.operation.state).toBe("pending");
    expect(result.operation.platformReceiptIdentifier).toBeNull();
    expect((await outbox.readDocument()).revision).toBe(1);
  });

  it("⑧ 同 id 同内容重投 ⇒ 幂等（不新增、不涨 revision）", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    const second = await outbox.enqueue(buildOperationInput());
    expect(second.wasEnqueued).toBe(false);
    const document = await outbox.readDocument();
    expect(document.operations).toHaveLength(1);
    expect(document.revision).toBe(1);
  });

  it("⑨ 同 id 不同内容/目标/修订 ⇒ 拒绝（不静默改发）", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());

    for (const overrides of [
      { contentHash: `sha256:${"b".repeat(64)}` },
      { interactionRevision: 2 },
      { targetAccountIdentifier: "account-2" },
    ]) {
      await expect(outbox.enqueue(buildOperationInput(overrides))).rejects.toThrow(
        /不能复用于不同内容/u,
      );
    }
  });
});

describe("状态更新与目标守卫", () => {
  it("⑩ 不存在的 operation ⇒ mission-not-found", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await expect(
      outbox.updateState({
        operationIdentifier: "missing",
        state: "sent",
        observedAtIso: "2026-11-13T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("⑪ 更新状态保留既有回执标识（未显式提供时）", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    await outbox.updateState({
      operationIdentifier: "operation-1",
      state: "sent",
      platformReceiptIdentifier: "receipt-1",
      observedAtIso: "2026-11-13T01:00:00.000Z",
    });
    const updated = await outbox.updateState({
      operationIdentifier: "operation-1",
      state: "sent",
      observedAtIso: "2026-11-13T02:00:00.000Z",
    });
    expect(updated.platformReceiptIdentifier).toBe("receipt-1");
    expect(updated.stateChangedAtIso).toBe("2026-11-13T02:00:00.000Z");
  });

  it("⑫ 目标被自动切换 ⇒ 拒绝（需新 operation 与新授权）", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    await expect(
      assertRemoteDeliveryTargetUnchanged({
        outbox,
        operationIdentifier: "operation-1",
        targetAccountIdentifier: "account-2",
        targetDeviceIdentifier: null,
      }),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    /** 一致时放行。 */
    await expect(
      assertRemoteDeliveryTargetUnchanged({
        outbox,
        operationIdentifier: "operation-1",
        targetAccountIdentifier: "account-1",
        targetDeviceIdentifier: null,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("投递尝试（假传输）", () => {
  it("⑬ 未入队 ⇒ refused（拒绝发送未校验的投递）；已 sent ⇒ 不重复发送", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    const { transport, send } = buildTransport();

    expect(
      await attemptRemoteDelivery({
        outbox,
        transport,
        operationIdentifier: "missing",
        text: "内容",
        nowIso: "2026-11-13T00:00:00.000Z",
      }),
    ).toMatchObject({ kind: "refused" });

    await outbox.enqueue(buildOperationInput());
    await outbox.updateState({
      operationIdentifier: "operation-1",
      state: "sent",
      platformReceiptIdentifier: "receipt-1",
      observedAtIso: "2026-11-13T00:00:00.000Z",
    });
    const already = await attemptRemoteDelivery({
      outbox,
      transport,
      operationIdentifier: "operation-1",
      text: "内容",
      nowIso: "2026-11-13T01:00:00.000Z",
    });
    expect(already).toMatchObject({ kind: "already-sent" });
    expect(send).not.toHaveBeenCalled();
  });

  it("⑭ 先读回执即已确认 ⇒ already-sent，且不发送", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    const { transport, send } = buildTransport({
      receipts: [
        {
          kind: "acknowledged",
          platformReceiptIdentifier: "receipt-existing",
          observedAtIso: "2026-11-13T00:00:00.000Z",
        },
      ],
    });

    const outcome = await attemptRemoteDelivery({
      outbox,
      transport,
      operationIdentifier: "operation-1",
      text: "内容",
      nowIso: "2026-11-13T01:00:00.000Z",
    });
    expect(outcome).toMatchObject({ kind: "already-sent", platformReceiptIdentifier: "receipt-existing" });
    expect(send).not.toHaveBeenCalled();
    expect((await outbox.find("operation-1"))?.state).toBe("sent");
  });

  it("⑮ 端口拒绝 ⇒ refused 并记录原因，状态为 refused", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    const { transport } = buildTransport({ sendStatus: "rejected", sendDetail: "平台拒收" });

    const outcome = await attemptRemoteDelivery({
      outbox,
      transport,
      operationIdentifier: "operation-1",
      text: "内容",
      nowIso: "2026-11-13T01:00:00.000Z",
    });
    expect(outcome).toMatchObject({ kind: "refused", reason: "平台拒收" });
    const operation = await outbox.find("operation-1");
    expect(operation?.state).toBe("refused");
    expect(operation?.lastRefusalReason).toBe("平台拒收");
  });

  it("⑯ 端口受理但无回执 ⇒ unknown（不当已送达）；再次尝试须显式重发", async () => {
    const outbox = new RemoteDeliveryOutbox({ baseDirectory });
    await outbox.enqueue(buildOperationInput());
    const first = buildTransport({ receipts: [null, null] });

    const outcome = await attemptRemoteDelivery({
      outbox,
      transport: first.transport,
      operationIdentifier: "operation-1",
      text: "内容",
      nowIso: "2026-11-13T01:00:00.000Z",
    });
    expect(outcome).toMatchObject({ kind: "unknown" });
    expect((await outbox.find("operation-1"))?.state).toBe("unknown");

    /** 第二次：状态 unknown 且未显式要求重发 ⇒ 拒绝自动重试，且不调用 send。 */
    const second = buildTransport({ receipts: [null] });
    const retry = await attemptRemoteDelivery({
      outbox,
      transport: second.transport,
      operationIdentifier: "operation-1",
      text: "内容",
      nowIso: "2026-11-13T02:00:00.000Z",
    });
    expect(retry).toMatchObject({ kind: "requires-explicit-resend" });
    expect(second.send).not.toHaveBeenCalled();
  });
});
