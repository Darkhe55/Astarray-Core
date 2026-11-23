/**
 * B9（2026-11-24）：远端证据导出服务的准备/投递分支（注入绑定仓库、证据提供器、投递端口）。
 *
 * 纪律：越范围/绑定失效不得投递；先准备再投递；outbox 路径必须幂等（第二次 already-sent），
 * 拒绝时不换目标。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RemoteEvidenceExportService,
  RemoteIdentityBindingStore,
  type RemoteEvidenceDeliveryPort,
  type RemoteIdentityBinding,
} from "../../../packages/core/src/orchestration/remote-evidence-export.js";
import {
  RemoteDeliveryOutbox,
  type RemoteDeliveryTransportPort,
} from "../../../packages/core/src/orchestration/remote-delivery-outbox.js";
import type { EvidenceSnapshot } from "../../../packages/core/src/orchestration/remote-evidence-snapshot.js";

let baseDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-remote-export-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function binding(overrides: Partial<RemoteIdentityBinding> = {}): RemoteIdentityBinding {
  return {
    bindingIdentifier: "binding-1",
    platformIdentifier: "platform-x",
    accountIdentifier: "account-1",
    deviceIdentifier: "device-1",
    authenticatedUserId: "user-1",
    authorizedProjectIdentifiers: ["project-a"],
    authorizedRecordKinds: ["run-summary"],
    authorizationRevision: 1,
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    createdAtIso: "2026-01-01T00:00:00.000Z",
    revokedAtIso: null,
    ...overrides,
  };
}

function snapshot(): EvidenceSnapshot {
  return {
    schemaVersion: 1,
    requestIdentifier: "req-1",
    snapshotRevision: 1,
    projectIdentifier: "project-a",
    conversationIdentifier: null,
    missionIdentifiers: ["m-1"],
    capturedAtIso: nowIso,
    lastObservedAtIso: nowIso,
    isRealtime: false,
    sourceAgentInstanceIdentifiers: ["agent-1"],
    sourceKinds: ["user-message"],
    entries: [
      {
        entryIdentifier: "entry-1",
        sourceKind: "user-message",
        sourceAgentInstanceIdentifier: "agent-1",
        recordedAtIso: nowIso,
        recordReference: "ref-1",
        excerptText: "正文",
        isRedacted: false,
        isTruncated: false,
        isSummaryDerived: false,
        summaryCoveredEntryCount: null,
      },
    ],
    omissions: { omittedEntryCount: 0, truncatedEntryCount: 0, redactedEntryCount: 0, reasonCodes: [] },
    contentHash: "sha256:" + "a".repeat(64),
  };
}

async function build(options: {
  /** 独立状态目录后缀：同一测试里需要"有绑定/无绑定"两个仓库时使用。 */
  stateSuffix?: string;
  binding?: RemoteIdentityBinding | null;
  deliveryStatus?: "sent" | "already-sent" | "failed";
  withOutbox?: boolean;
  transportStatus?: "accepted" | "rejected";
  receiptAcknowledged?: boolean;
}) {
  const storeDirectory =
    options.stateSuffix === undefined ? baseDirectory : path.join(baseDirectory, options.stateSuffix);
  const bindingStore = new RemoteIdentityBindingStore({ baseDirectory: storeDirectory });
  if (options.binding !== null) {
    await bindingStore.upsert(options.binding ?? binding());
  }
  const deliveryPort: RemoteEvidenceDeliveryPort = {
    send: async () => ({ status: options.deliveryStatus ?? "sent" }),
  };
  const outbox =
    options.withOutbox === true ? new RemoteDeliveryOutbox({ baseDirectory: storeDirectory }) : null;
  const transport: RemoteDeliveryTransportPort = {
    send: async () => ({ status: options.transportStatus ?? "accepted" }),
    readReceipt: async () =>
      options.receiptAcknowledged === true
        ? { kind: "acknowledged", platformReceiptIdentifier: "receipt-1", observedAtIso: nowIso }
        : null,
  };
  const service = new RemoteEvidenceExportService({
    bindingStore,
    evidenceProvider: async () => snapshot(),
    deliveryPort,
    outbox,
    transport: options.withOutbox === true ? transport : null,
    nowIso: () => nowIso,
  });
  return service;
}

const prepareInput = {
  bindingIdentifier: "binding-1",
  request: {
    requestIdentifier: "req-1",
    projectIdentifier: "project-a",
    conversationIdentifier: null,
    missionIdentifiers: ["m-1"],
  },
  recordKinds: ["run-summary"] as const,
  targetAccountIdentifier: "user-1",
  targetDeviceIdentifier: "device-1",
};

describe("B9：远端证据导出服务", () => {
  it("① 绑定不存在 ⇒ prepare 拒绝（mission-not-found）", async () => {
    const service = await build({ binding: null });
    await expect(service.prepareEvidenceExport(prepareInput)).rejects.toMatchObject({
      errorCode: "mission-not-found",
    });
  });

  it("② 绑定已撤销 ⇒ prepare 拒绝；越项目 ⇒ 需独立批准（拒绝）", async () => {
    const revoked = await build({ binding: binding({ revokedAtIso: "2026-11-01T00:00:00.000Z" }) });
    await expect(revoked.prepareEvidenceExport(prepareInput)).rejects.toMatchObject({
      errorCode: "task-sequence-permission-denied",
    });
    const otherProject = await build({});
    await expect(
      otherProject.prepareEvidenceExport({
        ...prepareInput,
        request: { ...prepareInput.request, projectIdentifier: "project-b" },
      }),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
  });

  it("③ 范围内 ⇒ 准备成功，导出标识绑定快照 revision，正文含快照头", async () => {
    const service = await build({});
    const prepared = await service.prepareEvidenceExport(prepareInput);
    expect(prepared.exportIdentifier).toBe("export:req-1:1");
    expect(prepared.renderedText).toContain("运行记录快照 req-1");
    expect(prepared.snapshot.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("④ 直接投递（无 outbox）：sent/already-sent/failed 三态", async () => {
    const prepared = await (await build({})).prepareEvidenceExport(prepareInput);
    const callDeliver = async (deliveryStatus: "sent" | "already-sent" | "failed") =>
      (await build({ deliveryStatus })).deliverEvidenceExport({
        preparedExport: prepared,
        targetAccountIdentifier: "user-1",
        targetDeviceIdentifier: "device-1",
      });
    expect((await callDeliver("sent")).status).toBe("sent");
    expect((await callDeliver("already-sent")).status).toBe("already-sent");
    const failed = await callDeliver("failed");
    expect(failed.status).toBe("refused");
    expect(failed.status === "refused" ? failed.reason : "").toContain("投递端口失败");
  });

  it("⑤ outbox 路径：发送被接受但无回执 ⇒ unknown；再次尝试 ⇒ 要求显式重发（不自动重试）", async () => {
    const service = await build({ withOutbox: true });
    const prepared = await service.prepareEvidenceExport(prepareInput);
    const deliver = () =>
      service.deliverEvidenceExport({
        preparedExport: prepared,
        targetAccountIdentifier: "user-1",
        targetDeviceIdentifier: "device-1",
      });
    /** 平台"接受"不等于"已送达"：没有回执就是 unknown（不伪装 sent）。 */
    expect((await deliver()).status).toBe("unknown");
    expect((await deliver()).status).toBe("requires-explicit-resend");
  });

  it("⑥ outbox 路径：平台已回执 ⇒ already-sent；平台拒绝 ⇒ refused", async () => {
    const acknowledged = await build({ withOutbox: true, receiptAcknowledged: true });
    const prepared = await acknowledged.prepareEvidenceExport(prepareInput);
    expect(
      (
        await acknowledged.deliverEvidenceExport({
          preparedExport: prepared,
          targetAccountIdentifier: "user-1",
          targetDeviceIdentifier: "device-1",
        })
      ).status,
    ).toBe("already-sent");

    const rejected = await build({
      withOutbox: true,
      transportStatus: "rejected",
      stateSuffix: "rejected",
    });
    const preparedRejected = await rejected.prepareEvidenceExport(prepareInput);
    const outcome = await rejected.deliverEvidenceExport({
      preparedExport: preparedRejected,
      targetAccountIdentifier: "user-1",
      targetDeviceIdentifier: "device-1",
    });
    expect(outcome.status).toBe("refused");
  });

  it("⑦ 投递前绑定消失 ⇒ refused（不发送）", async () => {
    const prepared = await (await build({ stateSuffix: "prepare" })).prepareEvidenceExport(prepareInput);
    const emptyStoreService = await build({ stateSuffix: "deliver", binding: null });
    const outcome = await emptyStoreService.deliverEvidenceExport({
      preparedExport: prepared,
      targetAccountIdentifier: "user-1",
      targetDeviceIdentifier: "device-1",
    });
    expect(outcome).toEqual({ status: "refused", reason: "绑定已不存在" });
  });
});
