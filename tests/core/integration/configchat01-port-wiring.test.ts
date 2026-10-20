/**
 * CONFIGCHAT-01-02 **端口接线**反例（2026-10-20）。
 *
 * 真实运行时（mock）验证：
 * - `permission-profile-default` 能真正切换并**读回确认**；
 * - 账目**落盘**，重启（新 facade 实例）后同 ID 同内容 ⇒ 幂等复用；
 * - 同 ID 异内容 ⇒ conflict（不覆盖）；
 * - 无 setter 的键（mode-selection）⇒ `failed` + `previousValueKept`，且真实权限组**未被改动**；
 * - 秘密类/非用户来源 ⇒ 拒绝。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";
import type { SettingChangeProposal } from "../../../packages/core/src/orchestration/config-chat-contract.js";

let stateDirectory: string;
let application: AstarrayApplicationFacade | null = null;

async function createApplication(): Promise<AstarrayApplicationFacade> {
  application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    concurrency: 1,
    failureThreshold: 1,
    maxLoopIterations: 1,
    useFeedbackProcess: false,
  } as never);
  application.createSession({ sessionId: "config-chat", mode: "assist" });
  return application;
}

function proposal(overrides: Partial<SettingChangeProposal> = {}): SettingChangeProposal {
  return {
    settingKey: "permission-profile-default",
    proposedValueJson: JSON.stringify({ kind: "builtin", profileId: "ponder" }),
    scopeKind: "session",
    sourceKind: "authenticated-user",
    isExplicitUserInstruction: true,
    changeIdentifier: "change-1",
    expectedRevision: 1,
    currentRevision: 1,
    riskKinds: ["low"],
    ...overrides,
  };
}

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-config-chat-port-"));
});

afterEach(async () => {
  if (application !== null) await application.shutdown().catch(() => {});
  application = null;
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("CONFIGCHAT-01-02 端口接线（真实设置）", () => {
  it("① 切换 permission-profile-default ⇒ applied，且读回的有效权限组确实变了", async () => {
    const app = await createApplication();
    const outcome = await app.applyChatSettingChange({ proposal: proposal() });
    expect(outcome.outcome.kind).toBe("applied");
    const effective = await app.getCurrentPermissionProfileReference();
    expect((effective as { profileId?: string } | null)?.profileId).toBe("ponder");
  });

  it("② 账目落盘：新实例（模拟重启）同 ID 同内容 ⇒ idempotent-replay", async () => {
    const first = await createApplication();
    const firstOutcome = await first.applyChatSettingChange({ proposal: proposal() });
    expect(firstOutcome.outcome.kind).toBe("applied");
    await first.shutdown();
    application = null;

    const second = await createApplication();
    const replay = await second.applyChatSettingChange({ proposal: proposal() });
    expect(replay.outcome.kind).toBe("idempotent-replay");
  });

  it("③ 同 ID 异内容 ⇒ conflict（不覆盖既有变更）", async () => {
    const app = await createApplication();
    await app.applyChatSettingChange({ proposal: proposal() });
    const conflict = await app.applyChatSettingChange({
      proposal: proposal({ proposedValueJson: JSON.stringify({ kind: "builtin", profileId: "assist" }) }),
    });
    expect(conflict.outcome).toMatchObject({ kind: "rejected", reasonCode: "conflict" });
  });

  it("④ 无 setter 的键 ⇒ failed + previousValueKept，且真实权限组未被改动", async () => {
    const app = await createApplication();
    const before = await app.getCurrentPermissionProfileReference();
    const outcome = await app.applyChatSettingChange({
      proposal: proposal({
        settingKey: "mode-selection",
        proposedValueJson: JSON.stringify("devolve"),
      }),
    });
    expect(outcome.outcome).toMatchObject({ kind: "failed", previousValueKept: true });
    const after = await app.getCurrentPermissionProfileReference();
    expect(after).toEqual(before);
  });

  it("⑤ 非法值（不是 PermissionProfileReference）⇒ failed，权限组不变", async () => {
    const app = await createApplication();
    const before = await app.getCurrentPermissionProfileReference();
    const outcome = await app.applyChatSettingChange({
      proposal: proposal({ proposedValueJson: JSON.stringify({ kind: "nope", profileId: 1 }) }),
    });
    expect(outcome.outcome.kind).toBe("failed");
    expect(await app.getCurrentPermissionProfileReference()).toEqual(before);
  });

  it("⑥ 秘密类设置 ⇒ 拒绝（不进对话），且不产生账目", async () => {
    const app = await createApplication();
    const outcome = await app.applyChatSettingChange({
      proposal: proposal({ settingKey: "api-key" }),
    });
    expect(outcome.outcome).toMatchObject({
      kind: "rejected",
      reasonCode: "secret-setting-requires-protected-entry",
    });
    expect(outcome.ledger).toHaveLength(0);
  });

  it("⑦ 非认证用户来源 ⇒ 拒绝（主 Agent 无写工具）", async () => {
    const app = await createApplication();
    const outcome = await app.applyChatSettingChange({
      proposal: proposal({ sourceKind: "model" }),
    });
    expect(outcome.outcome).toMatchObject({
      kind: "rejected",
      reasonCode: "requires-authenticated-user-source",
    });
  });

  it("⑧ 并发编辑（expectedRevision 落后）⇒ stale-revision，权限组不变", async () => {
    const app = await createApplication();
    const before = await app.getCurrentPermissionProfileReference();
    const outcome = await app.applyChatSettingChange({
      proposal: proposal({ expectedRevision: 1, currentRevision: 5 }),
    });
    expect(outcome.outcome).toMatchObject({ kind: "rejected", reasonCode: "stale-revision" });
    expect(await app.getCurrentPermissionProfileReference()).toEqual(before);
  });
});
