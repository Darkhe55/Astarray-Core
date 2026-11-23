/**
 * B9（2026-11-24）：远端证据导出的入站核验、来源映射与渲染。
 *
 * 纪律：签名/重放/时间/账户/绑定/设备任一不满足都必须给出**具体原因码**；
 * 不得把昵称当身份、不得在签名失败时降级为可信。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RemoteIdentityBindingStore,
  mapSourceKindToRecordKind,
  renderEvidenceSnapshotAsPlainText,
  verifyRemoteInboundMessage,
  type RemoteIdentityBinding,
} from "../../../packages/core/src/orchestration/remote-evidence-export.js";
import type { EvidenceSnapshot } from "../../../packages/core/src/orchestration/remote-evidence-snapshot.js";

let baseDirectory: string;
const nowIso = "2026-11-24T00:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-remote-verify-"));
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

function message(overrides: Record<string, unknown> = {}) {
  return {
    platformIdentifier: "platform-x",
    platformSignatureValid: true,
    platformTimestampIso: nowIso,
    receivedAtIso: nowIso,
    messageIdentifier: "msg-1",
    seenMessageIdentifiers: [] as string[],
    accountIdentifier: "account-1",
    deviceIdentifier: "device-1",
    ...overrides,
  };
}

let storeSequence = 0;
async function storeWith(bindings: RemoteIdentityBinding[]): Promise<RemoteIdentityBindingStore> {
  storeSequence += 1;
  /** 每次用独立子目录：否则同一测试里多次 upsert 会互相叠加绑定。 */
  const store = new RemoteIdentityBindingStore({
    baseDirectory: path.join(baseDirectory, `store-${String(storeSequence)}`),
  });
  for (const entry of bindings) {
    await store.upsert(entry);
  }
  return store;
}

describe("B9：入站消息核验", () => {
  it("① 签名无效 ⇒ signature-invalid（不降级为可信）", async () => {
    const store = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: store,
        message: message({ platformSignatureValid: false }),
        nowIso,
      }),
    ).toMatchObject({ isVerified: false, reasonCode: "signature-invalid" });
  });

  it("② 已处理过的消息 ⇒ replayed-message", async () => {
    const store = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: store,
        message: message({ seenMessageIdentifiers: ["msg-1"] }),
        nowIso,
      }),
    ).toMatchObject({ isVerified: false, reasonCode: "replayed-message" });
  });

  it("③ 时间戳非法/超出偏移 ⇒ timestamp-invalid", async () => {
    const store = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: store,
        message: message({ platformTimestampIso: "not-a-time" }),
        nowIso,
      }),
    ).toMatchObject({ reasonCode: "timestamp-invalid" });
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: store,
        message: message({ platformTimestampIso: "2026-11-23T23:00:00.000Z" }),
        nowIso,
      }),
    ).toMatchObject({ reasonCode: "timestamp-invalid" });
  });

  it("④ 账户未绑定 ⇒ account-not-bound", async () => {
    const store = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: store,
        message: message({ accountIdentifier: "account-2" }),
        nowIso,
      }),
    ).toMatchObject({ reasonCode: "account-not-bound" });
  });

  it("⑤ 绑定已撤销/过期 ⇒ binding-expired-or-revoked", async () => {
    const revoked = await storeWith([binding({ revokedAtIso: "2026-11-01T00:00:00.000Z" })]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: revoked,
        message: message(),
        nowIso,
      }),
    ).toMatchObject({ reasonCode: "binding-expired-or-revoked" });
    const expired = await storeWith([binding({ expiresAtIso: "2026-01-01T00:00:00.000Z" })]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: expired,
        message: message(),
        nowIso,
      }),
    ).toMatchObject({ reasonCode: "binding-expired-or-revoked" });
  });

  it("⑥ 设备匹配 ⇒ account-and-device；账户级绑定 ⇒ account-only；设备不符 ⇒ device-mismatch", async () => {
    const store = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({ bindingStore: store, message: message(), nowIso }),
    ).toMatchObject({ isVerified: true, authenticationLevel: "account-and-device" });

    const accountLevel = await storeWith([binding({ bindingIdentifier: "binding-acc", deviceIdentifier: null })]);
    expect(
      await verifyRemoteInboundMessage({ bindingStore: accountLevel, message: message(), nowIso }),
    ).toMatchObject({ isVerified: true, authenticationLevel: "account-only" });

    const otherDevice = await storeWith([binding()]);
    expect(
      await verifyRemoteInboundMessage({
        bindingStore: otherDevice,
        message: message({ deviceIdentifier: "device-2" }),
        nowIso,
      }),
    ).toMatchObject({ isVerified: false, reasonCode: "device-mismatch" });
  });
});

describe("B9：来源映射与纯文本渲染", () => {
  it("⑦ 七种来源类别映射（model-claim 不映射）", () => {
    expect(mapSourceKindToRecordKind("user-message")).toBe("run-summary");
    expect(mapSourceKindToRecordKind("tool-call")).toBe("tool-activity");
    expect(mapSourceKindToRecordKind("tool-result")).toBe("tool-activity");
    expect(mapSourceKindToRecordKind("artifact-registration")).toBe("artifact-registration");
    expect(mapSourceKindToRecordKind("review-conclusion")).toBe("review-conclusion");
    expect(mapSourceKindToRecordKind("unknown")).toBe("task-status");
    expect(mapSourceKindToRecordKind("model-claim")).toBeNull();
  });

  it("⑧ 渲染：标记截断/脱敏/摘要派生，并附遗漏说明", () => {
    const snapshot: EvidenceSnapshot = {
      schemaVersion: 1,
      requestIdentifier: "req-1",
      snapshotRevision: 2,
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
          isRedacted: true,
          isTruncated: true,
          isSummaryDerived: true,
          summaryCoveredEntryCount: 2,
        },
      ],
      omissions: {
        omittedEntryCount: 1,
        truncatedEntryCount: 1,
        redactedEntryCount: 1,
        reasonCodes: ["too-large", "redacted-secret"],
      },
      contentHash: "hash-1",
    };
    const text = renderEvidenceSnapshotAsPlainText(snapshot);
    expect(text).toContain("已截断、已脱敏、摘要派生");
    expect(text).toContain("遗漏说明：too-large、redacted-secret");
    expect(text).toContain("非实时");
  });
});
