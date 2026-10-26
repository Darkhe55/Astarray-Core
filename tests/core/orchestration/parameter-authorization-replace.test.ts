/** GUI-03-03：参数授权规则集原子替换。 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ParameterAuthorizationSettingsStore } from "../../../packages/core/src/tools/parameter-authorization-settings-store.js";

const directories: string[] = [];
async function createStore(): Promise<ParameterAuthorizationSettingsStore> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-param-"));
  directories.push(directory);
  return new ParameterAuthorizationSettingsStore({ stateDirectory: directory });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("参数授权规则集替换", () => {
  it("① 按 revision 替换并递增", async () => {
    const store = await createStore();
    const updated = await store.replaceDocument({
      settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
      rules: [
        {
          ruleIdentifier: "rule-1",
          toolName: "createProjectFile",
          action: "create",
          decision: "deny",
          explanation: "默认拒绝",
          match: { kind: "path-prefix", field: "filePath", prefix: "docs/" },
        },
      ],
      expectedRevision: 0,
    });
    expect(updated.configurationRevision).toBe(1);
    expect(updated.rules).toHaveLength(1);
  });

  it("② 过期 revision 拒绝", async () => {
    const store = await createStore();
    await store.replaceDocument({
      settings: { isParameterAuthorizationEnabled: true, isParameterRulesEnabled: true },
      rules: [],
      expectedRevision: 0,
    });
    await expect(
      store.replaceDocument({
        settings: { isParameterAuthorizationEnabled: false, isParameterRulesEnabled: false },
        rules: [],
        expectedRevision: 0,
      }),
    ).rejects.toThrow("revision");
  });
});


