/**
 * GUI-03-03 / F12（2026-11-10）：**参数级工具授权**的端到端行为。
 *
 * 卡内此前没有这条能力的行为证据。本文件钉住三件关键语义：
 *  ① 写入后读得回；
 *  ② **陈旧 revision ⇒ rejected**（不覆盖别人刚写的值）；
 *  ③ **放宽规则（改成 allow）且未确认 ⇒ confirmation-required，且不落盘**。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AstarrayApplicationFacade } from "../../packages/core/src/public-sdk.js";

vi.setConfig({ testTimeout: 60_000 });

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-parameter-auth-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
  });
}

function buildRule(decision: "allow" | "ask" | "deny") {
  return {
    ruleIdentifier: "rule-1",
    toolName: "createProjectFile",
    action: "create",
    decision,
    explanation: "测试规则",
    /** 设置存储要求每条规则带 match（缺省会以"规则缺少 match"拒绝）。 */
    match: { kind: "path-prefix", field: "path", prefix: "docs/" },
  } as never;
}

describe("GUI-03-03 参数级工具授权", () => {
  it("写入后**读得回**，revision 递增", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryParameterAuthorizationRuleDetails();
      const result = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("deny")],
        expectedRevision: before.configurationRevision,
        isConfirmedByAuthenticatedUser: false,
      });
      expect(result.status).toBe("saved");
      expect(result.revision).toBeGreaterThan(before.configurationRevision);

      const readBack = await facade.queryParameterAuthorizationRuleDetails();
      expect(readBack.isParameterAuthorizationEnabled).toBe(true);
      expect(readBack.rules.map((rule) => rule.decision)).toContain("deny");
    } finally {
      await facade.shutdown();
    }
  }, 60_000);

  it("**陈旧 revision ⇒ rejected**（不覆盖并发写入）", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryParameterAuthorizationRuleDetails();
      await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("deny")],
        expectedRevision: before.configurationRevision,
        isConfirmedByAuthenticatedUser: false,
      });
      const stale = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: false,
        isParameterRulesEnabled: false,
        rules: [],
        expectedRevision: before.configurationRevision,
        isConfirmedByAuthenticatedUser: true,
      });
      expect(stale.status).toBe("rejected");
      expect(stale.message).toContain("revision");
    } finally {
      await facade.shutdown();
    }
  }, 60_000);

  it("**放宽且未确认 ⇒ confirmation-required，且不落盘**", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryParameterAuthorizationRuleDetails();
      const tightened = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("deny")],
        expectedRevision: before.configurationRevision,
        isConfirmedByAuthenticatedUser: false,
      });
      expect(tightened.status).toBe("saved");

      const widened = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("allow")],
        expectedRevision: tightened.revision,
        isConfirmedByAuthenticatedUser: false,
      });
      expect(widened.status).toBe("confirmation-required");
      expect(widened.widenedRules.length).toBeGreaterThan(0);

      /** 未确认 ⇒ 配置**保持不变**（仍是 deny）。 */
      const readBack = await facade.queryParameterAuthorizationRuleDetails();
      expect(readBack.rules.map((rule) => rule.decision)).toContain("deny");
      expect(readBack.rules.map((rule) => rule.decision)).not.toContain("allow");
    } finally {
      await facade.shutdown();
    }
  }, 60_000);

  it("**确认后**放宽才生效", async () => {
    const facade = await createFacade();
    try {
      const before = await facade.queryParameterAuthorizationRuleDetails();
      const tightened = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("deny")],
        expectedRevision: before.configurationRevision,
        isConfirmedByAuthenticatedUser: false,
      });
      const confirmed = await facade.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [buildRule("allow")],
        expectedRevision: tightened.revision,
        isConfirmedByAuthenticatedUser: true,
      });
      expect(confirmed.status).toBe("saved");
      const readBack = await facade.queryParameterAuthorizationRuleDetails();
      expect(readBack.rules.map((rule) => rule.decision)).toContain("allow");
    } finally {
      await facade.shutdown();
    }
  }, 60_000);
});
