/**
 * COORD-02 §7 反例：**授权代际**（2026-11-18）。
 *
 * §7 要求：关系首次有效为 1；撤销/收窄/替换在同一次持久化提交内递增；
 * 同一变更重放不重复递增；进程重启不重置；其他关系不递增。
 *
 * 本文件先钉住"权威来源 + 建立与变更"两段（跨项目授权关系）：
 * 生产盖章、传输透传与消费复核仍待接线，卡内不得据此宣布全链已完成。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "authorization-epoch-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

function buildStore(): CrossProjectAuthorizationStore {
  return new CrossProjectAuthorizationStore({ baseDirectory: stateDirectory });
}

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    authorizationIdentifier: "authorization-1",
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
    argumentsHash: `sha256:${"0".repeat(64)}`,
    expiresAtIso: "2026-12-31T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-001",
    receivingAgentInstanceId: "agent-1",
    nowIso: "2026-11-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("COORD-02 §7：授权代际", () => {
  it("① 新关系首次授权 ⇒ 代际为 1", async () => {
    const store = buildStore();
    const result = await store.grantAuthorization(grantInput());
    expect(result.outcome).toBe("granted");
    expect(result.record?.authorizationEpoch).toBe(1);
  }, 30_000);

  it("② 撤销 ⇒ 代际 +1，且**重启后不重置**", async () => {
    const store = buildStore();
    await store.grantAuthorization(grantInput());
    await store.revokeAuthorization("authorization-1", "用户撤权");

    const reloaded = await buildStore().getAuthorization("authorization-1");
    expect(reloaded?.state).toBe("revoked");
    expect(reloaded?.authorizationEpoch).toBe(2);
  }, 30_000);

  it("③ 同一撤销重放 ⇒ 代际不再增加（幂等）", async () => {
    const store = buildStore();
    await store.grantAuthorization(grantInput());
    await store.revokeAuthorization("authorization-1", "用户撤权");
    await store.revokeAuthorization("authorization-1", "用户撤权");
    const reloaded = await buildStore().getAuthorization("authorization-1");
    expect(reloaded?.authorizationEpoch).toBe(2);
  }, 30_000);

  it("④ 同一关系重新授权 ⇒ 取得更高代际（3 > 撤销后的 2）", async () => {
    const store = buildStore();
    await store.grantAuthorization(grantInput());
    await store.revokeAuthorization("authorization-1", "用户撤权");
    const reGranted = await store.grantAuthorization(
      grantInput({ authorizationIdentifier: "authorization-2" }),
    );
    expect(reGranted.outcome).toBe("granted");
    expect(reGranted.record?.authorizationEpoch).toBe(3);
  }, 30_000);

  it("⑤ 无关关系（换接收个体）从 1 开始，不共享代际", async () => {
    const store = buildStore();
    await store.grantAuthorization(grantInput());
    await store.revokeAuthorization("authorization-1", "用户撤权");
    const otherRelationship = await store.grantAuthorization(
      grantInput({ authorizationIdentifier: "authorization-3", receivingAgentInstanceId: "agent-2" }),
    );
    expect(otherRelationship.record?.authorizationEpoch).toBe(1);
  }, 30_000);

  it("⑥ 旧记录没有代际字段 ⇒ 载入时初始化为 1（不给历史补章）", async () => {
    /** 直接写一份旧格式文档（无 authorizationEpoch 字段）。 */
    const directoryPath = path.join(stateDirectory, "cross-project");
    await fs.mkdir(directoryPath, { recursive: true });
    await fs.writeFile(
      path.join(directoryPath, "cross-project-authorizations.json"),
      JSON.stringify({
        schemaVersion: 1,
        authorizations: [
          {
            authorizationIdentifier: "legacy-authorization",
            sourceProjectIdentifier: "project-a",
            sourceProjectRevision: 1,
            targetProjectIdentifier: "project-b",
            targetProjectRevision: 1,
            operationKind: "read",
            resourceScope: { pathPrefixes: ["docs/"], realPaths: [], isDynamicSharedDirectory: false },
            argumentsHash: `sha256:${"0".repeat(64)}`,
            expiresAtIso: "2026-12-31T00:00:00.000Z",
            grantedByUserId: "user-1",
            taskIdentifier: "T-001",
            receivingAgentInstanceId: "agent-1",
            state: "active",
            revokedReason: null,
            derivationDepth: 0,
            parentAuthorizationIdentifier: null,
            createdAtIso: "2026-11-01T00:00:00.000Z",
          },
        ],
        copyReceipts: [],
      }),
      "utf8",
    );

    const loaded = await buildStore().getAuthorization("legacy-authorization");
    expect(loaded?.authorizationEpoch).toBe(1);
  }, 30_000);
});
