/**
 * AUTH-CORE-01 第 2/3 片（2026-11-22）：
 *
 * 1. **工具基线**：显式工具决定只在能力映射之上收紧/覆盖 ask/allow；
 *    能力映射 deny 不可放宽；显式 deny 立即终止（参数 allow 规则不能翻案）。
 * 2. **规则契约**：保存时按判定器实际读取的字段校验 match 形状，
 *    "永不生效/意外全匹配"的规则不得静默保存；整工具规则（空 action）与
 *    整 action 规则（无 match）是合法形态。
 */
import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
  ParameterAuthorizationSettingsStore,
  validateSettingsDocument,
  type ParameterAuthorizationSettingsDocument,
} from "../../../packages/core/src/tools/parameter-authorization-settings-store.js";
import { ConfigurablePermissionPolicyEngine } from "../../../packages/core/src/tools/configurable-permission-policy-engine.js";
import { PermissionCapabilityCatalog } from "../../../packages/core/src/tools/permission-capability-catalog.js";
import type { ParameterAuthorizationRule } from "../../../packages/core/src/tools/parameter-authorization.js";

function documentWithRules(rules: ParameterAuthorizationRule[]): ParameterAuthorizationSettingsDocument {
  return {
    schemaVersion: PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
    settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
    rules,
  };
}

function ruleWithMatch(
  match: unknown,
  overrides: Partial<ParameterAuthorizationRule> = {},
): ParameterAuthorizationRule {
  return {
    ruleIdentifier: "rule-1",
    toolName: "createProjectFile",
    action: "create",
    decision: "allow",
    explanation: "测试规则",
    ...overrides,
    ...(match === undefined ? {} : { match: match as never }),
  };
}

function expectRejected(rule: ParameterAuthorizationRule, expectedFragment: string) {
  const result = validateSettingsDocument(documentWithRules([rule]));
  expect(result.isValid).toBe(false);
  expect(result.reason ?? "").toContain(expectedFragment);
}

describe("AUTH-CORE-01：规则 match 契约统一校验", () => {
  it("① numeric-range 下界大于上界 ⇒ 拒绝（否则永不生效）", () => {
    expectRejected(
      ruleWithMatch({ kind: "numeric-range", field: "timeoutMilliseconds", minimum: 5, maximum: 1 }),
      "minimum 不得大于 maximum",
    );
  });

  it("② numeric-range 非有限数值 ⇒ 拒绝", () => {
    expectRejected(
      ruleWithMatch({ kind: "numeric-range", field: "x", minimum: Number.NaN, maximum: 10 }),
      "minimum 必须是有限数值",
    );
    expectRejected(
      ruleWithMatch({ kind: "numeric-range", field: "x", minimum: 1, maximum: Number.POSITIVE_INFINITY }),
      "maximum 必须是有限数值",
    );
  });

  it("③ allowed-values 空数组或非字符串项 ⇒ 拒绝", () => {
    expectRejected(ruleWithMatch({ kind: "allowed-values", field: "mode", values: [] }), "非空数组");
    expectRejected(
      ruleWithMatch({ kind: "allowed-values", field: "mode", values: ["append", 42] }),
      "全为非空字符串",
    );
  });

  it("④ path-prefix / fixed-value 字段形状非法 ⇒ 拒绝", () => {
    expectRejected(
      ruleWithMatch({ kind: "path-prefix", field: "filePath", prefix: "" }),
      "prefix 必须是非空字符串",
    );
    expectRejected(
      ruleWithMatch({ kind: "fixed-value", field: "mode", value: 7 }),
      "value 必须是字符串",
    );
    expectRejected(
      ruleWithMatch({ kind: "fixed-value", field: "", value: "append" }),
      "field 必须是非空字符串",
    );
  });

  it("⑤ 合法匹配形状 ⇒ 接受（对照，避免校验器把所有规则都拒掉）", () => {
    const result = validateSettingsDocument(
      documentWithRules([
        ruleWithMatch({ kind: "path-prefix", field: "filePath", prefix: "docs/" }),
        ruleWithMatch(
          { kind: "numeric-range", field: "timeoutMilliseconds", minimum: 1, maximum: 60 },
          { ruleIdentifier: "rule-2" },
        ),
      ]),
    );
    expect(result.isValid).toBe(true);
  });

  it("⑥ 整工具规则（空 action）与整 action 规则（无 match）是合法形态", () => {
    const wholeTool = validateSettingsDocument(
      documentWithRules([
        {
          ruleIdentifier: "rule-whole-tool",
          toolName: "taskSequenceStatus",
          action: "",
          decision: "ask",
          explanation: "该工具所有 action 都要求确认",
        },
      ]),
    );
    expect(wholeTool.isValid).toBe(true);

    const wholeAction = validateSettingsDocument(
      documentWithRules([
        {
          ruleIdentifier: "rule-whole-action",
          toolName: "createProjectFile",
          action: "create",
          decision: "ask",
          explanation: "该 action 一律要求确认",
        },
      ]),
    );
    expect(wholeAction.isValid).toBe(true);
  });

  it("⑥b 整工具规则的工具存在性：给出运行时注册表时未知工具被拒，已知工具放行", () => {
    const rule: ParameterAuthorizationRule = {
      ruleIdentifier: "rule-whole-tool",
      toolName: "ghostTool",
      action: "",
      decision: "ask",
      explanation: "未知工具的整工具规则",
    };
    const withRegistry = validateSettingsDocument(documentWithRules([rule]), {
      knownToolNames: new Set(["taskSequenceStatus", "createProjectFile"]),
    });
    expect(withRegistry.isValid).toBe(false);
    expect(withRegistry.reason ?? "").toContain("未在运行时注册");

    const known = validateSettingsDocument(
      documentWithRules([{ ...rule, toolName: "taskSequenceStatus" }]),
      { knownToolNames: new Set(["taskSequenceStatus"]) },
    );
    expect(known.isValid).toBe(true);

    /** 无注册表上下文（旧构造方）⇒ 保持旧行为，不拒绝。 */
    const withoutRegistry = validateSettingsDocument(documentWithRules([rule]));
    expect(withoutRegistry.isValid).toBe(true);
  });

  it("⑥c 设置存储：provider 存在时保存整工具规则会查询注册表", async () => {
    const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-authcore01-"));
    try {
      const settings = {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
      };
      const rejectingStore = new ParameterAuthorizationSettingsStore({
        stateDirectory: baseDirectory,
        knownToolNamesProvider: () => new Set(["taskSequenceStatus"]),
      });
      const rejected = await rejectingStore.writeSettings({
        settings,
        rules: [
          {
            ruleIdentifier: "r-ghost",
            toolName: "ghostTool",
            action: "",
            decision: "ask",
            explanation: "未知工具",
          },
        ],
      });
      expect(rejected.isValid).toBe(false);

      const acceptingStore = new ParameterAuthorizationSettingsStore({
        stateDirectory: baseDirectory,
        knownToolNamesProvider: () => new Set(["taskSequenceStatus"]),
      });
      const accepted = await acceptingStore.writeSettings({
        settings,
        rules: [
          {
            ruleIdentifier: "r-known",
            toolName: "taskSequenceStatus",
            action: "",
            decision: "ask",
            explanation: "已知工具",
          },
        ],
      });
      expect(accepted.isValid).toBe(true);
    } finally {
      await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe("AUTH-CORE-01：工具基线优先级（显式决定 vs 能力映射）", () => {
  function buildEngine(input: {
    capabilityDecisions: Record<string, "allow" | "ask" | "deny">;
    toolDecisions?: Record<string, "allow" | "ask" | "deny">;
    rules?: ParameterAuthorizationRule[];
  }) {
    const catalog = new PermissionCapabilityCatalog();
    const profile = {
      revision: 1,
      catalogVersion: catalog.getCatalogVersion(),
      capabilityDecisions: input.capabilityDecisions,
      toolDecisions: input.toolDecisions ?? {},
      fallbackDecision: "deny",
    };
    const profileStore = { readProfile: async () => profile };
    return new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore: profileStore as never,
      ...(input.rules === undefined
        ? {}
        : {
            parameterAuthorization: {
              settings: {
                isParameterAuthorizationEnabled: true,
                isParameterRulesEnabled: true,
              },
              rules: input.rules,
            },
          }),
    });
  }

  async function decide(
    engine: ConfigurablePermissionPolicyEngine,
    toolName: string,
    action?: string,
  ) {
    return engine.decide({
      toolName,
      ...(action === undefined ? {} : { action }),
      profileReference: { kind: "builtin", profileId: "assist" },
      argumentsJson: JSON.stringify({ filePath: "docs/a.md", content: "x" }),
    });
  }

  it("⑦ 显式 allow 覆盖能力映射的 ask", async () => {
    const engine = buildEngine({
      capabilityDecisions: { "project.create": "ask" },
      toolDecisions: { createProjectFile: "allow" },
    });
    expect((await decide(engine, "createProjectFile", "create")).decision).toBe("allow");
  });

  it("⑧ 能力映射 deny 不可被显式 allow 放宽", async () => {
    const engine = buildEngine({
      capabilityDecisions: { "project.read": "deny" },
      toolDecisions: { readFile: "allow" },
    });
    expect((await decide(engine, "readFile")).decision).toBe("deny");
  });

  it("⑨ 显式 deny 立即终止：匹配的 allow 参数规则不能翻案", async () => {
    const engine = buildEngine({
      capabilityDecisions: { "project.create": "allow" },
      toolDecisions: { createProjectFile: "deny" },
      rules: [
        {
          toolName: "createProjectFile",
          action: "create",
          decision: "allow",
          explanation: "规则想放行",
        },
      ],
    });
    expect((await decide(engine, "createProjectFile", "create")).decision).toBe("deny");
  });

  it("⑩ 整工具规则（空 action）对该工具的所有 action 生效", async () => {    const engine = buildEngine({
      capabilityDecisions: { "task.read": "allow" },
      rules: [
        {
          toolName: "taskSequenceStatus",
          action: "",
          decision: "ask",
          explanation: "该工具所有 action 都要求确认",
        },
      ],
    });
    expect((await decide(engine, "taskSequenceStatus", "state-query")).decision).toBe("ask");
    expect((await decide(engine, "taskSequenceStatus", "other-query")).decision).toBe("ask");
  });

  it("⑪ 未知 action 在工具执行入口即被拒绝（先于任何副作用）", async () => {
    const { executeBuiltinTool } = await import(
      "../../../packages/core/src/tools/builtins.js"
    );
    await expect(
      executeBuiltinTool(
        "processExecution",
        JSON.stringify({ action: "not-a-real-action" }),
        {} as never,
      ),
    ).rejects.toThrow(/未知的族名\/别名与 action 组合/);
  });

  it("⑫ 规则提供者：保存后下一次调用生效；规则版本变化使旧批准失效", async () => {
    const catalog = new PermissionCapabilityCatalog();
    let revision = 1;
    let rules: ParameterAuthorizationRule[] = [];
    const profileStore = {
      readProfile: async () => ({
        revision: 1,
        catalogVersion: catalog.getCatalogVersion(),
        capabilityDecisions: { "task.read": "allow" },
        toolDecisions: {},
        fallbackDecision: "deny" as const,
      }),
    };
    const engine = new ConfigurablePermissionPolicyEngine({
      catalog,
      profileStore: profileStore as never,
      parameterAuthorizationProvider: async () => ({
        settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
        rules,
        configurationRevision: revision,
      }),
    });
    const argumentsJson = JSON.stringify({ sequenceId: "s-1" });
    const decide = () =>
      engine.decide({
        toolName: "taskSequenceStatus",
        action: "state-query",
        profileReference: { kind: "builtin", profileId: "assist" },
        argumentsJson,
      });

    /** 初始无规则 ⇒ 基线 allow（不需要重启）。 */
    expect((await decide()).decision).toBe("allow");

    /** 保存一条 ask 规则（revision 2）⇒ 下一次调用即 ask。 */
    revision = 2;
    rules = [
      {
        ruleIdentifier: "r1",
        toolName: "taskSequenceStatus",
        action: "",
        decision: "ask",
        explanation: "该工具所有 action 要求确认",
      },
    ];
    expect((await decide()).decision).toBe("ask");

    /** 用户批准 ⇒ allow。 */
    await engine.grantSessionAuthorization({
      toolName: "taskSequenceStatus",
      profileReference: { kind: "builtin", profileId: "assist" },
      argumentsJson,
    });
    expect((await decide()).decision).toBe("allow");

    /** 规则版本再变化（仍是 ask）⇒ 旧批准必须失效，不得沿用。 */
    revision = 3;
    rules = [
      {
        ruleIdentifier: "r2",
        toolName: "taskSequenceStatus",
        action: "",
        decision: "ask",
        explanation: "规则改过",
      },
    ];
    expect((await decide()).decision).toBe("ask");
  });
});
