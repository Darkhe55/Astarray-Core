/**
 * anthropic-messages provider 注册（此前 `tests/` 零引用）；**不发起任何网络请求**。
 *
 * 重点是"注册信息准确 + 配置真的透传"，因为漏传 `baseUrl`/`model` 会在运行期才炸，
 * 而注册层自己看起来完全正常。
 */
import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MESSAGES_PROVIDER_ID,
  createAnthropicMessagesProviderRegistration,
} from "../../../packages/core/src/runtime/anthropic-messages-provider-registration.js";
import {
  ANTHROPIC_MESSAGES_PROTOCOL,
  ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION,
  AnthropicMessagesRuntime,
} from "../../../packages/core/src/runtime/anthropic-messages-runtime.js";

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    providerId: ANTHROPIC_MESSAGES_PROVIDER_ID,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fake-key-for-test",
    modelIdentifier: "claude-test-model",
    requestTimeoutMilliseconds: 1_000,
    ...overrides,
  } as never;
}

describe("anthropic-messages 注册", () => {
  it("① providerId / protocol / protocolVersion 与运行时模块一致（单一来源）", () => {
    const registration = createAnthropicMessagesProviderRegistration();
    expect(ANTHROPIC_MESSAGES_PROVIDER_ID).toBe("anthropic-messages");
    expect(registration.providerId).toBe(ANTHROPIC_MESSAGES_PROVIDER_ID);
    expect(registration.protocol).toBe(ANTHROPIC_MESSAGES_PROTOCOL);
    expect(registration.protocolVersion).toBe(ANTHROPIC_MESSAGES_RUNTIME_PROTOCOL_VERSION);
  });

  it("② 能力声明包含流式、工具调用与取消", () => {
    const registration = createAnthropicMessagesProviderRegistration();
    expect(registration.supportedCapabilities).toEqual(
      expect.arrayContaining(["streaming", "tool-calling", "cancellation"]),
    );
  });

  it("③ createRuntime 返回正确的运行时类型", () => {
    const registration = createAnthropicMessagesProviderRegistration();
    const runtime = registration.createRuntime(buildConfig());
    expect(runtime).toBeInstanceOf(AnthropicMessagesRuntime);
  });

  it("④ 配置真的透传（baseUrl / model / apiKey / timeout），漏传会在此红", () => {
    const registration = createAnthropicMessagesProviderRegistration();
    const runtime = registration.createRuntime(
      buildConfig({ maxOutputTokens: 512 }),
    );
    const options = (runtime as unknown as { options: Record<string, unknown> }).options;
    expect(options["baseUrl"]).toBe("http://127.0.0.1:1/v1");
    expect(options["apiKey"]).toBe("fake-key-for-test");
    expect(options["model"]).toBe("claude-test-model");
    expect(options["requestTimeoutMilliseconds"]).toBe(1_000);
    expect(options["maxTokens"]).toBe(512);
  });

  it("⑤ 未给 maxOutputTokens 时不写 maxTokens；每次调用返回新实例；注册对象不含密钥", () => {
    const registration = createAnthropicMessagesProviderRegistration();
    const runtime = registration.createRuntime(buildConfig());
    const options = (runtime as unknown as { options: Record<string, unknown> }).options;
    expect("maxTokens" in options).toBe(false);

    const another = registration.createRuntime(buildConfig());
    expect(another).not.toBe(runtime);

    /** 注册对象本身不得携带密钥（apiKey 只在 createRuntime 的入参里出现）。 */
    expect(Object.keys(registration).sort()).toEqual(
      ["createRuntime", "protocol", "protocolVersion", "providerId", "supportedCapabilities"].sort(),
    );
  });
});
