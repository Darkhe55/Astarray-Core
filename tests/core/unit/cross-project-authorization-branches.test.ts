/**
 * B9（2026-11-24）：跨项目授权的代际/缩权/列表过滤分支。
 *
 * 纪律：
 * - 撤销幂等（同记录同理由不重复递增代际），未知标识不报错；
 * - 缩权派生必须**不宽于**父授权（空前缀/更宽前缀/额外真实路径/动态共享升级都拒绝）；
 * - 再转交一律拒绝（授权不可再转授）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CrossProjectAuthorizationStore } from "../../../packages/core/src/orchestration/cross-project-authorization-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-cpxa-branches-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const nowIso = "2026-11-24T00:00:00.000Z";

function scope(overrides: Partial<{ pathPrefixes: string[]; realPaths: string[]; isDynamicSharedDirectory: boolean }> = {}) {
  return {
    pathPrefixes: ["src/", "docs/"],
    realPaths: ["/work/a/src"],
    isDynamicSharedDirectory: false,
    ...overrides,
  };
}

function grantInput(overrides: Record<string, unknown> = {}) {
  return {
    authorizationIdentifier: "auth-1",
    sourceProjectIdentifier: "project-a",
    sourceProjectRevision: 1,
    targetProjectIdentifier: "project-b",
    targetProjectRevision: 1,
    operationKind: "read" as const,
    resourceScope: scope(),
    argumentsHash: "sha256:abc",
    expiresAtIso: "2099-01-01T00:00:00.000Z",
    grantedByUserId: "user-1",
    taskIdentifier: "T-1",
    nowIso,
    ...overrides,
  };
}

describe("B9：跨项目授权存储分支", () => {
  it("① 未认证用户授予 ⇒ rejected-not-authenticated-user，不落记录", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    expect((await store.grantAuthorization(grantInput({ grantedByUserId: null }))).outcome).toBe(
      "rejected-not-authenticated-user",
    );
    expect((await store.grantAuthorization(grantInput({ grantedByUserId: "   " }))).outcome).toBe(
      "rejected-not-authenticated-user",
    );
    expect(await store.getAuthorization("auth-1")).toBeNull();
  });

  it("② 撤销幂等：同理由重复撤销不递增代际；未知标识不报错", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization(grantInput());
    const granted = await store.getAuthorization("auth-1");
    expect(granted?.authorizationEpoch).toBe(1);

    await store.revokeAuthorization("auth-1", "用户撤销");
    const afterFirst = await store.getAuthorization("auth-1");
    const firstEpoch = afterFirst?.authorizationEpoch;
    await store.revokeAuthorization("auth-1", "用户撤销");
    const afterSecond = await store.getAuthorization("auth-1");
    expect(afterSecond?.state).toBe("revoked");
    expect(afterSecond?.authorizationEpoch).toBe(firstEpoch);
    await expect(store.revokeAuthorization("missing-auth", "x")).resolves.toBeUndefined();
  });

  it("③ 列表过滤：来源/目标/接收 Agent 三个维度", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization(grantInput({ authorizationIdentifier: "auth-1" }));
    await store.grantAuthorization(
      grantInput({
        authorizationIdentifier: "auth-2",
        sourceProjectIdentifier: "project-c",
        targetProjectIdentifier: "project-d",
        receivingAgentInstanceId: "agent-9",
      }),
    );
    expect((await store.listAuthorizations()).length).toBe(2);
    expect((await store.listAuthorizations({ sourceProjectIdentifier: "project-a" })).map((r) => r.authorizationIdentifier)).toEqual([
      "auth-1",
    ]);
    expect((await store.listAuthorizations({ targetProjectIdentifier: "project-d" })).map((r) => r.authorizationIdentifier)).toEqual([
      "auth-2",
    ]);
    expect((await store.listAuthorizations({ receivingAgentInstanceId: "agent-9" })).map((r) => r.authorizationIdentifier)).toEqual([
      "auth-2",
    ]);
    expect(await store.listAuthorizations({ receivingAgentInstanceId: "agent-absent" })).toEqual([]);
  });

  it("④ 缩权派生：父不存在/空前缀/更宽前缀/额外真实路径/动态共享升级 全拒绝", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization(grantInput());
    expect(
      (
        await store.deriveNarrowedAuthorization({
          parentAuthorizationIdentifier: "missing",
          authorizationIdentifier: "derived-0",
          resourceScope: scope(),
          taskIdentifier: "T-2",
        })
      ).outcome,
    ).toBe("parent-not-found");

    const cases = [
      scope({ pathPrefixes: [] }),
      scope({ pathPrefixes: ["src/", "other/"] }),
      scope({ realPaths: ["/work/a/src", "/work/a/extra"] }),
      scope({ isDynamicSharedDirectory: true }),
    ];
    for (const [index, resourceScope] of cases.entries()) {
      expect(
        (
          await store.deriveNarrowedAuthorization({
            parentAuthorizationIdentifier: "auth-1",
            authorizationIdentifier: `derived-bad-${String(index)}`,
            resourceScope,
            taskIdentifier: "T-2",
          })
        ).outcome,
      ).toBe("rejected-not-narrower");
    }
  });

  it("⑤ 合法缩权 ⇒ 派生深度+1、绑定父授权，且跨实例可读", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await store.grantAuthorization(grantInput());
    expect(
      (
        await store.deriveNarrowedAuthorization({
          parentAuthorizationIdentifier: "auth-1",
          authorizationIdentifier: "derived-1",
          resourceScope: scope({ pathPrefixes: ["src/"], realPaths: ["/work/a/src"] }),
          taskIdentifier: "T-2",
          nowIso,
        })
      ).outcome,
    ).toBe("derived-narrowed");
    const reader = new CrossProjectAuthorizationStore({ baseDirectory });
    const derived = await reader.getAuthorization("derived-1");
    expect(derived).toMatchObject({
      derivationDepth: 1,
      parentAuthorizationIdentifier: "auth-1",
      taskIdentifier: "T-2",
    });
  });

  it("⑥ 再转交一律拒绝（授权不可再转授）", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    await expect(
      store.attemptRedelegation({
        parentAuthorizationIdentifier: "auth-1",
        authorizationIdentifier: "re-delegate",
        targetProjectIdentifier: "project-c",
        targetAgentInstanceId: "agent-9",
      }),
    ).resolves.toBe("rejected-no-redelegation");
  });

  it("⑦ 同项目关系：首次 created、重试 existing；撤销后拒绝复活", async () => {
    const store = new CrossProjectAuthorizationStore({ baseDirectory });
    const relationshipInput = {
      sourceProjectIdentifier: "project-a",
      targetProjectIdentifier: "project-a",
      sourceAgentInstanceId: "agent-1",
      receivingAgentInstanceId: "agent-2",
      taskIdentifier: "T-1",
      nowIso,
    };
    const created = await store.ensureLocalCollaborationRelationship(relationshipInput);
    expect(created.outcome).toBe("created");
    const existing = await store.ensureLocalCollaborationRelationship(relationshipInput);
    expect(existing.outcome).toBe("existing");
    expect(existing.record?.authorizationIdentifier).toBe(created.record?.authorizationIdentifier);
    await store.revokeAuthorization(created.record!.authorizationIdentifier, "撤销");
    expect((await store.ensureLocalCollaborationRelationship(relationshipInput)).outcome).toBe(
      "revoked",
    );
  });
});
