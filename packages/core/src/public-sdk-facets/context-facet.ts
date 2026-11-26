/**
 * AXIOMATIC-DESIGN 阶段②（P2，2026-11-26）：**上下文预算子门面**。
 *
 * 从 `public-sdk.ts` 切出上下文预算读/写两个方法：
 * - `queryContextSettings`：读全局预算策略 + 真实装配事件，返回生效值；
 * - `updateContextBudget`：CAS 写入后重新读回，并发出 `budget-policy-updated` 事件。
 *
 * 约束：行为逐字一致（含 `assertOpen()`、DomainError → 门面错误的转换、事件字段）；
 * 门面保留同名委托；宿主以窄接口注入。
 */
import { resolveContextBudget } from "../orchestration/context-prompt-assembler.js";

export interface PublicContextSettings {
  configuredMaximumGlobalContextTokenCount: number;
  effectiveMaximumGlobalContextTokenCount: number;
  budgetPolicyRevision: number;
  budgetReductionReason: string | null;
  /** 已记录的上下文装配事件样本数（实际值分母）。 */
  assemblySampleSize: number;
  /** 最近一次真实装配使用的预算 revision（证明"下一次请求已按新配置生效"）。 */
  lastAssemblyBudgetPolicyRevision: number | null;
}

export interface ContextFacetHost {
  assertOpen(): void;
  readBudgetPolicy(): Promise<{
    configuredMaximumGlobalContextTokenCount: number;
    globalContextBudgetPolicyRevision: number;
  }>;
  readAssemblyEvents(): Promise<ReadonlyArray<{ budgetPolicyRevision: number }>>;
  updateBudgetPolicy(input: {
    expectedRevision: number;
    configuredMaximumGlobalContextTokenCount: number;
    updatedByUserId: string;
  }): Promise<void>;
  /** 领域错误 → 公开错误（保留 errorCode；非领域错误原样抛出）。 */
  createPublicErrorFrom(error: unknown): Error;
  emitBudgetPolicyUpdated(settings: PublicContextSettings): void;
}

export class ContextFacet {
  constructor(private readonly host: ContextFacetHost) {}

  /**
   * GUI-01-R-03：读取上下文预算配置与真实装配实际值。
   * 数据来自全局预算权威存储与真实装配事件，不复制状态机、不引入前端缓存。
   */
  async queryContextSettings(): Promise<PublicContextSettings> {
    this.host.assertOpen();
    const policy = await this.host.readBudgetPolicy();
    const resolution = resolveContextBudget({
      configuredMaximumGlobalContextTokenCount:
        policy.configuredMaximumGlobalContextTokenCount,
      budgetPolicyRevision: policy.globalContextBudgetPolicyRevision,
    });
    const assemblyEvents = await this.host.readAssemblyEvents();
    const lastAssembly = assemblyEvents.at(-1) ?? null;
    return {
      configuredMaximumGlobalContextTokenCount:
        resolution.configuredMaximumGlobalContextTokenCount,
      effectiveMaximumGlobalContextTokenCount:
        resolution.effectiveMaximumGlobalContextTokenCount,
      budgetPolicyRevision: resolution.budgetPolicyRevision,
      budgetReductionReason: resolution.budgetReductionReason,
      assemblySampleSize: assemblyEvents.length,
      lastAssemblyBudgetPolicyRevision: lastAssembly?.budgetPolicyRevision ?? null,
    };
  }

  /**
   * GUI-01-R-03：以 CAS 写入预算策略；下一模型请求的装配按新 revision 生效
   * （装配提供者从同一存储读取，revision 变化使选择缓存失效）。
   */
  async updateContextBudget(input: {
    expectedRevision: number;
    configuredMaximumGlobalContextTokenCount: number;
  }): Promise<PublicContextSettings> {
    this.host.assertOpen();
    try {
      await this.host.updateBudgetPolicy({
        expectedRevision: input.expectedRevision,
        configuredMaximumGlobalContextTokenCount:
          input.configuredMaximumGlobalContextTokenCount,
        updatedByUserId: "authenticated-user",
      });
    } catch (error) {
      throw this.host.createPublicErrorFrom(error);
    }
    const settings = await this.queryContextSettings();
    this.host.emitBudgetPolicyUpdated(settings);
    return settings;
  }
}
