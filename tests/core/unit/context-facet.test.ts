/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：上下文预算子门面的独立契约。
 *
 * 验证：只读视图来自预算策略 + 真实装配事件；写入走 CAS 后重新读回并发事件；
 * 领域错误转换为公开错误；关闭态不触达存储。
 */
import { describe, expect, it, vi } from "vitest";

import { ContextFacet } from "../../../packages/core/src/public-sdk-facets/context-facet.js";

function buildHost(overrides: Record<string, unknown> = {}) {
  const assertOpen = vi.fn();
  const readBudgetPolicy = vi.fn(async () => ({
    configuredMaximumGlobalContextTokenCount: 8192,
    globalContextBudgetPolicyRevision: 2,
  }));
  const readAssemblyEvents = vi.fn(async () => [
    { budgetPolicyRevision: 1 },
    { budgetPolicyRevision: 2 },
  ]);
  const updateBudgetPolicy = vi.fn(async () => ({ schemaVersion: 1 }));
  const emitBudgetPolicyUpdated = vi.fn();
  const createPublicErrorFrom = vi.fn((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const host = {
    assertOpen,
    readBudgetPolicy,
    readAssemblyEvents,
    updateBudgetPolicy,
    emitBudgetPolicyUpdated,
    createPublicErrorFrom,
    ...overrides,
  };
  return { host: host as never, assertOpen, updateBudgetPolicy, emitBudgetPolicyUpdated, createPublicErrorFrom };
}

describe("AXIOMATIC P2：上下文预算子门面", () => {
  it("① 查询：返回生效预算 + 装配样本数与最近 revision，且先 assertOpen", async () => {
    const { host, assertOpen } = buildHost();
    const facet = new ContextFacet(host);
    const settings = await facet.queryContextSettings();
    expect(settings).toMatchObject({
      configuredMaximumGlobalContextTokenCount: 8192,
      budgetPolicyRevision: 2,
      assemblySampleSize: 2,
      lastAssemblyBudgetPolicyRevision: 2,
    });
    expect(assertOpen).toHaveBeenCalledTimes(1);
  });

  it("② 无装配事件 ⇒ lastAssembly 为 null（不猜测）", async () => {
    const { host } = buildHost({ readAssemblyEvents: async () => [] });
    const settings = await new ContextFacet(host).queryContextSettings();
    expect(settings.assemblySampleSize).toBe(0);
    expect(settings.lastAssemblyBudgetPolicyRevision).toBeNull();
  });

  it("③ 写入：成功后重新读回并发 budget-policy-updated 事件", async () => {
    const { host, updateBudgetPolicy, emitBudgetPolicyUpdated } = buildHost();
    const facet = new ContextFacet(host);
    const settings = await facet.updateContextBudget({
      expectedRevision: 2,
      configuredMaximumGlobalContextTokenCount: 16384,
    });
    expect(updateBudgetPolicy).toHaveBeenCalledWith({
      expectedRevision: 2,
      configuredMaximumGlobalContextTokenCount: 16384,
      updatedByUserId: "authenticated-user",
    });
    expect(settings.budgetPolicyRevision).toBe(2);
    expect(emitBudgetPolicyUpdated).toHaveBeenCalledTimes(1);
    expect(emitBudgetPolicyUpdated.mock.calls[0]?.[0]).toMatchObject({
      budgetPolicyRevision: 2,
    });
  });

  it("④ 写入失败：领域错误经宿主转换后抛出，且不发事件", async () => {
    const domainError = Object.assign(new Error("revision 不匹配"), {
      errorCode: "stale-revision",
    });
    const { host, emitBudgetPolicyUpdated } = buildHost({
      updateBudgetPolicy: async () => {
        throw domainError;
      },
      createPublicErrorFrom: (error: unknown) =>
        Object.assign(new Error((error as Error).message), {
          errorCode: (error as { errorCode?: string }).errorCode,
        }),
    });
    const facet = new ContextFacet(host);
    await expect(
      facet.updateContextBudget({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: 4096 }),
    ).rejects.toMatchObject({ errorCode: "stale-revision" });
    expect(emitBudgetPolicyUpdated).not.toHaveBeenCalled();
  });

  it("⑤ assertOpen 抛错 ⇒ 不触达预算存储", async () => {
    const { host, updateBudgetPolicy } = buildHost({
      assertOpen: () => {
        throw new Error("application-closed");
      },
    });
    const facet = new ContextFacet(host);
    await expect(
      facet.updateContextBudget({ expectedRevision: 1, configuredMaximumGlobalContextTokenCount: 4096 }),
    ).rejects.toThrow("application-closed");
    expect(updateBudgetPolicy).not.toHaveBeenCalled();
  });
});
