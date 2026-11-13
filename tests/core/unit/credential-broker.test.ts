/**
 * 凭据引用与最小读取（此前 `tests/` 零引用，SEC-02-07）。
 *
 * 三件东西各自的安全边界：引用**不含秘密**；broker 是唯一"引用→秘密"入口且必须匹配服务与操作；
 * 交给模型/日志前用同一目录做四态扫描，非 clean 即拒。
 */
import { describe, expect, it, vi } from "vitest";

import {
  CredentialBroker,
  assertCredentialReferenceUsable,
  assertModelVisiblePayloadHasNoCredential,
} from "../../../packages/core/src/tools/credential-broker.js";
import type { CredentialReference } from "../../../packages/core/src/tools/credential-broker.js";

const FAKE_SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

function buildReference(overrides: Partial<CredentialReference> = {}): CredentialReference {
  return {
    credentialIdentifier: "credential-1",
    serviceIdentifier: "provider:openai",
    allowedOperations: ["chat.completions"],
    ...overrides,
  };
}

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    reference: buildReference(),
    targetServiceIdentifier: "provider:openai",
    operation: "chat.completions",
    ...overrides,
  } as never;
}

describe("引用可用性校验（不读秘密）", () => {
  it("① 缺标识 ⇒ 拒绝", () => {
    expect(() =>
      assertCredentialReferenceUsable(buildInput({ reference: buildReference({ credentialIdentifier: "  " }) })),
    ).toThrow(/缺少标识/u);
  });

  it("② 跨服务 ⇒ 拒绝（不得跨目标透传认证）", () => {
    expect(() =>
      assertCredentialReferenceUsable(buildInput({ targetServiceIdentifier: "provider:anthropic" })),
    ).toThrow(/不能用于/u);
  });

  it("③ 操作未授权 / 允许列表为空 ⇒ 拒绝", () => {
    expect(() =>
      assertCredentialReferenceUsable(buildInput({ operation: "admin.delete" })),
    ).toThrow(/未授权操作/u);
    expect(() =>
      assertCredentialReferenceUsable(buildInput({ reference: buildReference({ allowedOperations: [] }) })),
    ).toThrow(/允许：无/u);
  });
});

describe("凭据中介", () => {
  it("④ 合法请求 ⇒ 返回秘密；空秘密 ⇒ 拒绝（不以空凭据认证）", async () => {
    const broker = new CredentialBroker({ resolveSecret: async () => FAKE_SECRET });
    expect(await broker.resolveForRequest(buildInput())).toBe(FAKE_SECRET);

    const emptyBroker = new CredentialBroker({ resolveSecret: async () => "   " });
    await expect(emptyBroker.resolveForRequest(buildInput())).rejects.toThrow(/解析为空/u);
  });

  it("⑤ 引用不合法 ⇒ **不调用解析端口**（先校验后解析）", async () => {
    const resolveSecret = vi.fn(async () => FAKE_SECRET);
    const broker = new CredentialBroker({ resolveSecret });
    await expect(
      broker.resolveForRequest(buildInput({ operation: "admin.delete" })),
    ).rejects.toThrow();
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("⑥ 解析端口抛错 ⇒ 不把原始异常（可能含秘密/路径）透给调用方", async () => {
    const broker = new CredentialBroker({
      resolveSecret: async () => {
        throw new Error(`凭据库读取失败：/secrets/vault.db 值=${FAKE_SECRET}`);
      },
    });
    let caught: unknown = null;
    try {
      await broker.resolveForRequest(buildInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(FAKE_SECRET);
    expect(message).not.toContain("/secrets/vault.db");
  });

  it("⑦ describeReference 只给标识与范围（无秘密、无凭据库路径），且数组是副本", () => {
    const broker = new CredentialBroker({ resolveSecret: async () => FAKE_SECRET });
    const reference = buildReference();
    const described = broker.describeReference(reference);

    expect(described).toEqual({
      credentialIdentifier: "credential-1",
      serviceIdentifier: "provider:openai",
      allowedOperations: ["chat.completions"],
    });
    expect(JSON.stringify(described)).not.toContain(FAKE_SECRET);
    (reference.allowedOperations as string[]).push("admin.delete");
    expect(described.allowedOperations).toEqual(["chat.completions"]);
  });
});

describe("模型可见内容兜底", () => {
  it("⑧ 干净内容 ⇒ 通过；命中 ⇒ 拒绝且**不回显命中值**", () => {
    expect(() =>
      assertModelVisiblePayloadHasNoCredential({
        payloadText: "请总结这份文档",
        destinationDescription: "模型上下文",
      }),
    ).not.toThrow();

    let caught: unknown = null;
    try {
      assertModelVisiblePayloadHasNoCredential({
        payloadText: `配置：${FAKE_SECRET}`,
        destinationDescription: "日志",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("拒绝把内容送往日志");
    expect(message).not.toContain(FAKE_SECRET);
  });

  it("⑨ 扫描没跑完（超长内容）⇒ 同样拒绝", () => {
    expect(() =>
      assertModelVisiblePayloadHasNoCredential({
        payloadText: "普通文本".repeat(500_000),
        destinationDescription: "模型上下文",
      }),
    ).toThrow(/incomplete|拒绝/u);
  });
});
