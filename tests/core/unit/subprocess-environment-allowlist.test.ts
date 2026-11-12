/**
 * 子进程环境允许列表（此前 `tests/` 零引用）：**不继承宿主凭据环境**。
 *
 * 反例优先：白名单外的变量不复制；白名单内但命中凭据命名的也排除；
 * 被排除项**只记名字、绝不记值**；一致性校验能挡住 `{...process.env}` 回潮。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES,
  assertSubprocessEnvironmentIsRestricted,
  buildRestrictedSubprocessEnvironment,
} from "../../../packages/core/src/infra/subprocess-environment-allowlist.js";

describe("受限子进程环境", () => {
  it("① 只复制允许项；白名单外的普通变量静默省略（不算凭据排除）", () => {
    const result = buildRestrictedSubprocessEnvironment({
      hostEnvironment: { PATH: "/usr/bin", FOO: "bar", ANTHROPIC_API_KEY: "sk-secret" },
    });
    expect(result.environment).toEqual({ PATH: "/usr/bin" });
    expect(result.allowedVariableNames).toEqual(["PATH"]);
    expect(result.excludedCredentialVariableNames).toEqual([]);
  });

  it("② 白名单内但命中凭据命名 ⇒ 排除并记名", () => {
    const result = buildRestrictedSubprocessEnvironment({
      hostEnvironment: { MY_API_KEY: "sk-1", SERVICE_TOKEN: "t-2", MY_TOOL: "ok" },
      additionalAllowedVariableNames: ["MY_API_KEY", "SERVICE_TOKEN", "MY_TOOL"],
    });
    expect(result.environment).toEqual({ MY_TOOL: "ok" });
    expect([...result.excludedCredentialVariableNames].sort()).toEqual(["MY_API_KEY", "SERVICE_TOKEN"]);
  });

  it("③ 被排除项的值绝不出现在返回结果中的任何位置", () => {
    const secretValue = "sk-live-SECRET-VALUE-DO-NOT-LEAK";
    const result = buildRestrictedSubprocessEnvironment({
      hostEnvironment: { SECRET_TOKEN: secretValue, PATH: "/usr/bin" },
      additionalAllowedVariableNames: ["SECRET_TOKEN"],
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-SECRET-VALUE-DO-NOT-LEAK");
    expect(result.excludedCredentialVariableNames).toEqual(["SECRET_TOKEN"]);
  });

  it("④ undefined 值跳过（不会写出 undefined 到子进程环境）", () => {
    const result = buildRestrictedSubprocessEnvironment({
      hostEnvironment: { PATH: undefined, HOME: "/home/user" },
    });
    expect(result.environment).toEqual({ HOME: "/home/user" });
  });

  it("⑤ 默认白名单本身不含凭据命名的变量", () => {
    const hostEnvironment = Object.fromEntries(
      DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES.map((name) => [name, "value"]),
    );
    const result = buildRestrictedSubprocessEnvironment({ hostEnvironment });
    expect(result.excludedCredentialVariableNames).toEqual([]);
    expect(Object.keys(result.environment).sort()).toEqual(
      [...DEFAULT_ALLOWED_ENVIRONMENT_VARIABLE_NAMES].sort(),
    );
  });

  it("⑥ 一致性校验：含未允许变量 ⇒ 抛错且只报名字", () => {
    expect(() =>
      assertSubprocessEnvironmentIsRestricted({
        environment: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-1" },
      }),
    ).toThrow(/未允许的变量.*ANTHROPIC_API_KEY/u);
    expect(() =>
      assertSubprocessEnvironmentIsRestricted({ environment: { PATH: "/usr/bin" } }),
    ).not.toThrow();
  });

  it("⑦ 额外允许的普通变量会进入子进程环境", () => {
    const result = buildRestrictedSubprocessEnvironment({
      hostEnvironment: { CUSTOM_FLAG: "1" },
      additionalAllowedVariableNames: ["CUSTOM_FLAG"],
    });
    expect(result.environment).toEqual({ CUSTOM_FLAG: "1" });
    expect(result.allowedVariableNames).toEqual(["CUSTOM_FLAG"]);
  });
});
