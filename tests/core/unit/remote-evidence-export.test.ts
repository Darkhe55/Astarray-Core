/**
 * 远端证据导出（此前 `tests/` 零引用）。
 *
 * **不接真实远端**：投递是端口，测试用假实现；验证的是安全判定——
 * 撤销/过期即拒、越范围不是"放行"也不是"拒绝"而是**需要独立批准（不能自批）**、
 * 投递前重新校验、失败如实上报。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RemoteEvidenceExportService,
  RemoteIdentityBindingStore,
  evaluateRemoteExportScope,
} from "../../../packages/core/src/orchestration/remote-evidence-export.js";
import type { RemoteIdentityBinding } from "../../../packages/core/src/orchestration/remote-evidence-export.js";

let baseDirectory: string;
const NOW_ISO = "2026-11-13T12:00:00.000Z";

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "remote-export-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 5 });
});

function buildBinding(overrides: Partial<RemoteIdentityBinding> = {}): RemoteIdentityBinding {
  return {
    bindingIdentifier: "binding-1",
    platformIdentifier: "platform-1",
    accountIdentifier: "account-1",
    deviceIdentifier: null,
    authenticatedUserId: "user-1",
    authorizedProjectIdentifiers: ["project-alpha"],
    authorizedRecordKinds: ["run-summary", "task-status"],
    authorizationRevision: 1,
    expiresAtIso: "2027-01-01T00:00:00.000Z",
    createdAtIso: "2026-11-01T00:00:00.000Z",
    revokedAtIso: null,
    ...overrides,
  };
}

function buildScopeRequest(overrides: Record<string, unknown> = {}) {
  return {
    projectIdentifier: "project-alpha",
    recordKinds: ["run-summary"],
    targetAccountIdentifier: "account-1",
    targetDeviceIdentifier: null,
    ...overrides,
  } as never;
}

describe("绑定存储", () => {
  it("① 新增绑定可查回，revision 递增", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    await store.upsert(buildBinding());
    expect(await store.findByIdentifier("binding-1")).toEqual(buildBinding());
    expect((await store.read()).revision).toBe(1);
  });

  it("② 同 id upsert ⇒ 替换而非追加（授权范围变更走同一 id）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    await store.upsert(buildBinding());
    await store.upsert(buildBinding({ authorizationRevision: 2, authorizedRecordKinds: ["run-summary"] }));

    const document = await store.read();
    expect(document.bindings).toHaveLength(1);
    expect(document.bindings[0]?.authorizationRevision).toBe(2);
    expect(document.revision).toBe(2);
  });

  it("③ 未知 id ⇒ null；损坏文档 ⇒ 读作空（不伪造绑定）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    expect(await store.findByIdentifier("missing")).toBeNull();

    const bindingDirectory = path.join(baseDirectory, "remote-identity");
    await fs.mkdir(bindingDirectory, { recursive: true });
    await fs.writeFile(path.join(bindingDirectory, "bindings.json"), '{"bindings":42}', "utf8");
    expect((await store.read()).bindings).toEqual([]);
    expect(await store.findByIdentifier("binding-1")).toBeNull();
  });
});

describe("导出范围判定（纯函数）", () => {
  it("④ 绑定已撤销 ⇒ denied（优先于其它原因）", () => {
    const decision = evaluateRemoteExportScope({
      binding: buildBinding({ revokedAtIso: "2026-11-02T00:00:00.000Z" }),
      request: buildScopeRequest({ projectIdentifier: "somewhere-else" }),
      nowIso: NOW_ISO,
    });
    expect(decision.kind).toBe("denied");
  });

  it("⑤ 已过期或当前时间非法 ⇒ denied", () => {
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding({ expiresAtIso: "2026-11-01T00:00:00.000Z" }),
        request: buildScopeRequest(),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("denied");
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding(),
        request: buildScopeRequest(),
        nowIso: "not-a-date",
      }).kind,
    ).toBe("denied");
  });

  it("⑥ 项目/记录类别越授权 ⇒ **requires-independent-approval**（既不放行也不自动拒绝）", () => {
    const projectDecision = evaluateRemoteExportScope({
      binding: buildBinding(),
      request: buildScopeRequest({ projectIdentifier: "project-beta" }),
      nowIso: NOW_ISO,
    });
    expect(projectDecision.kind).toBe("requires-independent-approval");
    if (projectDecision.kind !== "requires-independent-approval") throw new Error("unreachable");
    expect(projectDecision.reasons.join("|")).toContain("不在授权范围");

    const kindDecision = evaluateRemoteExportScope({
      binding: buildBinding(),
      request: buildScopeRequest({ recordKinds: ["review-conclusion"] }),
      nowIso: NOW_ISO,
    });
    expect(kindDecision.kind).toBe("requires-independent-approval");
  });

  it("⑦ 目标账户既非绑定账户也非认证用户 ⇒ 需独立批准", () => {
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding(),
        request: buildScopeRequest({ targetAccountIdentifier: "someone-else" }),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("requires-independent-approval");
    /** 认证用户本身视为合法目标（平台账户与用户标识两种形态）。 */
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding(),
        request: buildScopeRequest({ targetAccountIdentifier: "user-1" }),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("within-preauthorization");
  });

  it("⑧ 绑定设备非 null 时设备不符 ⇒ 需独立批准；绑定设备为 null 则不因设备拒绝", () => {
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding({ deviceIdentifier: "device-a" }),
        request: buildScopeRequest({ targetDeviceIdentifier: "device-b" }),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("requires-independent-approval");

    expect(
      evaluateRemoteExportScope({
        binding: buildBinding({ deviceIdentifier: null }),
        request: buildScopeRequest({ targetDeviceIdentifier: "any-device" }),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("within-preauthorization");
  });

  it("⑨ 全部符合 ⇒ within-preauthorization", () => {
    expect(
      evaluateRemoteExportScope({
        binding: buildBinding(),
        request: buildScopeRequest(),
        nowIso: NOW_ISO,
      }).kind,
    ).toBe("within-preauthorization");
  });
});

describe("导出服务（假端口）", () => {
  function buildService(options: {
    bindingStore: RemoteIdentityBindingStore;
    evidenceProvider?: () => Promise<unknown>;
    deliveryStatus?: "sent" | "already-sent" | "failed";
  }) {
    const evidenceProvider = vi.fn(
      options.evidenceProvider ??
        (async () => {
          throw new Error("不应调用证据来源");
        }),
    );
    const send = vi.fn(async () => ({ status: options.deliveryStatus ?? "sent" }) as never);
    const service = new RemoteEvidenceExportService({
      bindingStore: options.bindingStore,
      evidenceProvider,
      deliveryPort: { send } as never,
      nowIso: () => NOW_ISO,
    } as never);
    return { service, evidenceProvider, send };
  }

  it("⑩ 绑定不存在 ⇒ mission-not-found（先要求首次确认）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    const { service } = buildService({ bindingStore: store });
    await expect(
      service.prepareEvidenceExport({
        bindingIdentifier: "missing",
        request: { projectIdentifier: "project-alpha" },
        recordKinds: ["run-summary"],
        targetAccountIdentifier: "account-1",
        targetDeviceIdentifier: null,
      } as never),
    ).rejects.toMatchObject({ errorCode: "mission-not-found" });
  });

  it("⑪ 越范围 ⇒ tool-permission-denied（不能自批），且**不取证据**", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    await store.upsert(buildBinding());
    const { service, evidenceProvider } = buildService({ bindingStore: store });

    await expect(
      service.prepareEvidenceExport({
        bindingIdentifier: "binding-1",
        request: { projectIdentifier: "project-beta" },
        recordKinds: ["run-summary"],
        targetAccountIdentifier: "account-1",
        targetDeviceIdentifier: null,
      } as never),
    ).rejects.toMatchObject({ errorCode: "tool-permission-denied" });
    expect(evidenceProvider).not.toHaveBeenCalled();
  });

  it("⑫ 绑定已撤销 ⇒ 导出被拒（task-sequence-permission-denied）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    await store.upsert(buildBinding({ revokedAtIso: "2026-11-02T00:00:00.000Z" }));
    const { service, evidenceProvider } = buildService({ bindingStore: store });

    await expect(
      service.prepareEvidenceExport({
        bindingIdentifier: "binding-1",
        request: { projectIdentifier: "project-alpha" },
        recordKinds: ["run-summary"],
        targetAccountIdentifier: "account-1",
        targetDeviceIdentifier: null,
      } as never),
    ).rejects.toMatchObject({ errorCode: "task-sequence-permission-denied" });
    expect(evidenceProvider).not.toHaveBeenCalled();
  });

  it("⑬ 投递时绑定已删除 ⇒ refused（拒绝而非静默丢弃）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    const { service, send } = buildService({ bindingStore: store });

    const outcome = await service.deliverEvidenceExport({
      preparedExport: {
        exportIdentifier: "export-1",
        bindingIdentifier: "binding-1",
        snapshot: { projectIdentifier: "project-alpha", entries: [] },
        preparedAtIso: NOW_ISO,
        renderedText: "正文",
      } as never,
      targetAccountIdentifier: "account-1",
      targetDeviceIdentifier: null,
    });

    expect(outcome.status).toBe("refused");
    expect(send).not.toHaveBeenCalled();
  });

  it("⑭ 投递端口失败 ⇒ 如实返回失败状态（不冒充 sent）", async () => {
    const store = new RemoteIdentityBindingStore({ baseDirectory });
    await store.upsert(buildBinding());
    const { service } = buildService({ bindingStore: store, deliveryStatus: "failed" });

    const outcome = await service.deliverEvidenceExport({
      preparedExport: {
        exportIdentifier: "export-1",
        bindingIdentifier: "binding-1",
        snapshot: { projectIdentifier: "project-alpha", entries: [] },
        preparedAtIso: NOW_ISO,
        renderedText: "正文",
      } as never,
      targetAccountIdentifier: "account-1",
      targetDeviceIdentifier: null,
    });

    /** 端口返回 failed ⇒ 结果不得是 sent/already-sent。 */
    expect(["sent", "already-sent"]).not.toContain(outcome.status);
  });
});
