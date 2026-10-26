/** GUI-03 / 方案 A：模型运行时池。 */
import { describe, expect, it } from "vitest";

import { ModelRuntimePool } from "../../../packages/core/src/runtime/model-runtime-pool.js";

function configuration(key: string) {
  return {
    configurationKey: key,
    providerId: "provider-" + key,
    modelIdentifier: "model-" + key,
    baseUrl: "https://example.invalid",
    protectedCredentialReferenceId: "credential-" + key,
    requestTimeoutMilliseconds: 1000,
  };
}

describe("模型运行时池", () => {
  it("① 同一配置只解析一次，每次调用独立 runtime", async () => {
    let resolveCount = 0;
    const pool = new ModelRuntimePool({
      resolve: async () => {
        resolveCount += 1;
        return {
          descriptor: {
            providerId: "p",
            protocol: "openai-compatible",
            protocolVersion: "v1",
            supportedCapabilities: ["streaming"],
          },
          createRuntime: () => ({ runtimeId: resolveCount }),
        } as never;
      },
    });
    const first = await pool.acquire({
      configuration: configuration("a"),
      agentInstanceId: "agent-1",
      missionId: "mission-1",
    });
    const second = await pool.acquire({
      configuration: configuration("a"),
      agentInstanceId: "agent-2",
      missionId: "mission-2",
    });
    expect(resolveCount).toBe(1);
    expect(first.runtime).not.toBe(second.runtime);
    first.release();
    second.release();
    expect(pool.cachedConfigurationCount).toBe(1);
  });

  it("② 空闲配置超过上限时回收，在途 lease 保护", async () => {
    let resolveCount = 0;
    const pool = new ModelRuntimePool({
      maximumCachedConfigurations: 1,
      resolve: async () => {
        resolveCount += 1;
        return {
          descriptor: {
            providerId: "p",
            protocol: "openai-compatible",
            protocolVersion: "v1",
            supportedCapabilities: [],
          },
          createRuntime: () => ({}),
        } as never;
      },
    });
    const lease = await pool.acquire({
      configuration: configuration("a"),
      agentInstanceId: "agent-1",
      missionId: "mission-1",
    });
    await pool.acquire({
      configuration: configuration("b"),
      agentInstanceId: "agent-2",
      missionId: "mission-2",
    });
    expect(pool.cachedConfigurationCount).toBe(2);
    lease.release();
    pool.evictIdleConfigurations();
    expect(pool.cachedConfigurationCount).toBe(1);
    expect(resolveCount).toBe(2);
  });
});
