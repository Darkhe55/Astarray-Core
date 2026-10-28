/**
 * GUI-03 / 模型运行时池（方案 A）。
 *
 * 关键边界：
 * - 一个配置指纹（provider/model/endpoint/credential/configRevision）共享一个
 *   `ResolvedProviderRuntime`，不按 Agent 创建；
 * - 每次调用只创建轻量 runtime 实例，并由 lease 记录归属/释放；
 * - 缓存只保存已解析配置，不保存对话、权限、用量或当前 Agent。
 */
import type { AgentRuntime } from "../core/types.js";
import type { ResolvedProviderRuntime } from "./provider-runtime-registry.js";

export interface ModelRuntimeConfiguration {
  readonly configurationKey: string;
  readonly providerId: string;
  readonly modelIdentifier: string;
  readonly baseUrl: string;
  readonly protectedCredentialReferenceId: string;
  readonly requestTimeoutMilliseconds: number;
}

export interface ModelRuntimeLease {
  readonly leaseId: string;
  readonly configurationKey: string;
  readonly agentInstanceId: string;
  readonly missionId: string;
  readonly runtime: AgentRuntime;
  release(): void;
}

export interface ModelRuntimePoolOptions {
  /** 解析配置；实现通常调用 ProviderRuntimeRegistry.resolveRuntime。 */
  resolve(configuration: ModelRuntimeConfiguration): Promise<ResolvedProviderRuntime>;
  /** 最多缓存多少个配置；只回收空闲配置。默认 8。 */
  maximumCachedConfigurations?: number;
  nowMilliseconds?: () => number;
}

interface CachedConfiguration {
  readonly resolved: ResolvedProviderRuntime;
  activeLeaseCount: number;
  lastUsedAtMilliseconds: number;
}

let sequence = 0;

export class ModelRuntimePool {
  private readonly entries = new Map<string, Promise<CachedConfiguration>>();
  private readonly states = new Map<string, CachedConfiguration>();
  private readonly maximumCachedConfigurations: number;
  private readonly nowMilliseconds: () => number;

  constructor(private readonly options: ModelRuntimePoolOptions) {
    this.maximumCachedConfigurations = Math.max(
      1,
      options.maximumCachedConfigurations ?? 8,
    );
    this.nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  }

  /** 已缓存配置数（只用于诊断）。 */
  get cachedConfigurationCount(): number {
    return this.entries.size;
  }

  async acquire(input: {
    configuration: ModelRuntimeConfiguration;
    agentInstanceId: string;
    missionId: string;
  }): Promise<ModelRuntimeLease> {
    const entry = await this.getOrCreate(input.configuration);
    entry.activeLeaseCount += 1;
    entry.lastUsedAtMilliseconds = this.nowMilliseconds();
    this.evictIdleConfigurations();
    const runtime = entry.resolved.createRuntime();
    let isReleased = false;
    return {
      leaseId: "model-lease-" + String(++sequence),
      configurationKey: input.configuration.configurationKey,
      agentInstanceId: input.agentInstanceId,
      missionId: input.missionId,
      runtime,
      release: () => {
        if (isReleased) return;
        isReleased = true;
        entry.activeLeaseCount = Math.max(0, entry.activeLeaseCount - 1);
        entry.lastUsedAtMilliseconds = this.nowMilliseconds();
      },
    };
  }

  /** 仅回收空闲配置；在途 lease 保护不被驱逐。 */
  evictIdleConfigurations(): void {
    while (this.states.size > this.maximumCachedConfigurations) {
      const victim = [...this.states.entries()]
        .filter(([, entry]) => entry.activeLeaseCount === 0)
        .sort(
          ([, left], [, right]) =>
            left.lastUsedAtMilliseconds - right.lastUsedAtMilliseconds,
        )[0];
      if (victim === undefined) return;
      this.states.delete(victim[0]);
      this.entries.delete(victim[0]);
    }
  }
  private async getOrCreate(
    configuration: ModelRuntimeConfiguration,
  ): Promise<CachedConfiguration> {
    const existing = this.entries.get(configuration.configurationKey);
    if (existing !== undefined) return existing;
    const promise = this.options
      .resolve(configuration)
      .then((resolved) => {
        const entry: CachedConfiguration = {
          resolved,
          activeLeaseCount: 0,
          lastUsedAtMilliseconds: this.nowMilliseconds(),
        };
        this.states.set(configuration.configurationKey, entry);
        return entry;
      })
      .catch((error: unknown) => {
        this.entries.delete(configuration.configurationKey);
        this.states.delete(configuration.configurationKey);
        throw error;
      });
    this.entries.set(configuration.configurationKey, promise);
    return promise;
  }
}


