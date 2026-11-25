/**
 * B9（2026-11-25）：跨项目授权存储的授权/撤销/回执分支。
 *
 * 纪律：非认证用户来源一律不生效；撤销后列表按状态过滤；状态文件损坏按空继续（不伪造历史）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cross-auth-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read" as const,
    resourceScope: {
      pathPrefixes: ["docs/"],
      realPaths: [],
      isDynamicSharedDirectory: false,
    },
    argumentsHash: "hash-1",
    expiresAtIso: "2026-12-31T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-1",
    ...overrides,
  };
}

describe("B9：跨项目授权存储", () => {
  it("① 非认证用户来源 ⇒ 拒绝且不落记录", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const outcome = await store.grantAuthorization(grantInput({ grantedByUserId: null }) as never);
    expect(outcome.outcome).toBe("rejected-not-authenticated-user");
    expect(outcome.record).toBeNull();
    expect(await store.listAuthorizations()).toEqual([]);

    const blankUser = await store.grantAuthorization(grantInput({ grantedByUserId: "   " }) as never);
    expect(blankUser.outcome).toBe("rejected-not-authenticated-user");
  });

  it("② 有效授权 ⇒ granted；可读取、可按状态过滤；重新授权代际递增", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const granted = await store.grantAuthorization(grantInput() as never);
    expect(granted.outcome).toBe("granted");
    expect(granted.record?.authorizationEpoch).toBe(1);

    expect(await store.getAuthorization("auth-1")).toMatchObject({ state: "active" });
    const activeOnly = (await store.listAuthorizations()).filter((record) => record.state === "active");
    expect(activeOnly).toHaveLength(1);

    const regranted = await store.grantAuthorization(grantInput() as never);
    expect(regranted.record?.authorizationEpoch).toBe(2);
  });

  it("③ 撤销后状态为 revoked，列表按状态过滤生效", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization(grantInput() as never);
    await store.revokeAuthorization("auth-1", "用户撤销");

    expect(await store.getAuthorization("auth-1")).toMatchObject({
      state: "revoked",
      revokedReason: "用户撤销",
    });
    const all = await store.listAuthorizations();
    expect(all.filter((record) => record.state === "active")).toHaveLength(0);
    expect(all.filter((record) => record.state === "revoked")).toHaveLength(1);
  });

  it("④ 回执：记录后可查/计数/列表；未知键返回 null", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const receipt = {
      receiptIdentifier: "receipt-1",
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: "project-a",
      sourceRevision: 1,
      targetProjectIdentifier: "project-b",
      sourceResourcePath: "docs/a.md",
      targetResourcePath: "imports/a.md",
      contentHash: "sha256:x",
      isCopyOfExternalSource: true as const,
      createdAtIso: "2026-11-25T00:00:00.000Z",
    };
    await store.recordCopyReceipt(receipt as never);

    expect(await store.countCopyReceipts()).toBe(1);
    expect(await store.listCopyReceipts()).toHaveLength(1);
    const found = await store.findCopyReceipt({
      authorizationIdentifier: "auth-1",
      sourceProjectIdentifier: "project-a",
      sourceRevision: 1,
      sourceResourcePath: "docs/a.md",
      targetResourcePath: "imports/a.md",
      contentHash: "sha256:x",
    } as never);
    expect(found?.receiptIdentifier).toBe("receipt-1");

    const missing = await store.findCopyReceipt({
      authorizationIdentifier: "auth-missing",
      sourceProjectIdentifier: "project-a",
      sourceRevision: 1,
      sourceResourcePath: "docs/a.md",
      targetResourcePath: "imports/a.md",
      contentHash: "sha256:x",
    } as never);
    expect(missing).toBeNull();
  });

  it("⑤ 状态文件损坏 ⇒ 按空继续（不伪造历史）", async () => {
    await fs.mkdir(path.join(baseDirectory, "cross-project"), { recursive: true });
    await fs.writeFile(
      path.join(baseDirectory, "cross-project", "cross-project-authorizations.json"),
      "{ 损坏",
      "utf8",
    );
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    expect(await store.listAuthorizations()).toEqual([]);
    expect(await store.countCopyReceipts()).toBe(0);
  });
});
