/**
 * B9（2026-11-25）：参数授权设置的**纯校验函数**与存储读取分支。
 *
 * 校验器本身是安全边界：任何结构不符都必须 fail-closed 拒绝，而不是"尽量放行"。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
  ParameterAuthorizationSettingsStore,
  validateSettingsDocument,
} from "../../../packages/core/src/tools/parameter-authorization-settings-store.js";

let baseDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-param-settings-"));
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function validDocument(): Record<string, unknown> {
  return {
    schemaVersion: PARAMETER_AUTHORIZATION_SETTINGS_SCHEMA_VERSION,
    settings: {
      isParameterAuthorizationEnabled: true,
      isParameterRulesEnabled: true,
      perToolRulesEnabled: { createProjectFile: true },
    },
    rules: [],
    configurationRevision: 0,
  };
}

describe("B9：参数授权设置校验与读取", () => {
  it("① 校验器：结构/版本/开关/规则形态不符一律拒绝", () => {
    expect(validateSettingsDocument(null as never).isValid).toBe(false);
    expect(
      validateSettingsDocument({ ...validDocument(), schemaVersion: "v0" } as never).isValid,
    ).toBe(false);

    const missingSettings = { ...validDocument(), settings: null } as never;
    expect(validateSettingsDocument(missingSettings).isValid).toBe(false);

    const badBooleans = {
      ...validDocument(),
      settings: { isParameterAuthorizationEnabled: "yes", isParameterRulesEnabled: true },
    } as never;
    expect(validateSettingsDocument(badBooleans).isValid).toBe(false);

    const badPerTool = {
      ...validDocument(),
      settings: {
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        perToolRulesEnabled: { createProjectFile: "yes" },
      },
    } as never;
    expect(validateSettingsDocument(badPerTool).isValid).toBe(false);

    const rulesNotArray = { ...validDocument(), rules: "nope" } as never;
    expect(validateSettingsDocument(rulesNotArray).isValid).toBe(false);
  });

  it("② 校验器：规则字段/动作/匹配种类/重复 ID 与未知工具都被拒绝", () => {
    const baseRule = {
      ruleIdentifier: "rule-1",
      toolName: "createProjectFile",
      action: "create",
      decision: "allow",
      explanation: "说明",
      match: { kind: "path-prefix", field: "path", prefix: "docs/" },
    };

    const valid = { ...validDocument(), rules: [baseRule] } as never;
    expect(validateSettingsDocument(valid).isValid).toBe(true);

    const duplicate = { ...validDocument(), rules: [baseRule, { ...baseRule }] } as never;
    expect(validateSettingsDocument(duplicate).isValid).toBe(false);

    const badMatch = {
      ...validDocument(),
      rules: [{ ...baseRule, match: { kind: "unknown-kind" } }],
    } as never;
    expect(validateSettingsDocument(badMatch).isValid).toBe(false);

    const unknownTool = {
      ...validDocument(),
      rules: [{ ...baseRule, toolName: "not-registered" }],
    } as never;
    expect(
      validateSettingsDocument(unknownTool, {
        knownToolNames: new Set(["createProjectFile"]),
      }).isValid,
    ).toBe(false);
  });

  it("③ 存储：缺文件 ⇒ 默认值且不创建文件；损坏 ⇒ 抛错；写入后可读回", async () => {
    const store = new ParameterAuthorizationSettingsStore({ stateDirectory: baseDirectory });
    const defaults = await store.readSettings();
    expect(defaults.settings.isParameterAuthorizationEnabled).toBe(true);
    expect(await fs.readdir(baseDirectory)).toEqual([]);

    const write = await store.writeSettings({
      settings: defaults.settings,
      rules: [],
      configurationRevision: 1,
    });
    expect(write.isValid).toBe(true);
    expect((await store.readSettings()).configurationRevision).toBe(1);

    const corruptDirectory = path.join(baseDirectory, "corrupt");
    const store2 = new ParameterAuthorizationSettingsStore({ stateDirectory: corruptDirectory });
    await fs.mkdir(corruptDirectory, { recursive: true });
    await fs.writeFile(
      path.join(corruptDirectory, "parameter-authorization-settings.json"),
      "{ 损坏",
      "utf8",
    );
    await expect(store2.readSettings()).rejects.toThrow();
  });
});
