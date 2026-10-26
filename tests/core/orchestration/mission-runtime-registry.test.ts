/** GUI-03 / 方案 A2：mission runtime registry。 */
import { describe, expect, it } from "vitest";

import { MissionRuntimeRegistry } from "../../../packages/core/src/orchestration/mission-runtime-registry.js";

function lease(missionId: string) {
  let released = 0;
  return {
    leaseId: "lease-" + missionId,
    missionId,
    configurationKey: "config",
    runtime: {} as never,
    release: () => {
      released += 1;
    },
    get releasedCount() {
      return released;
    },
  };
}

describe("mission runtime registry", () => {
  it("① 登记后同步取用，结束后释放", () => {
    const registry = new MissionRuntimeRegistry();
    const item = lease("mission-1");
    registry.register(item);
    expect(registry.get("mission-1")?.leaseId).toBe("lease-mission-1");
    expect(registry.get("mission-2")).toBeNull();
    registry.release("mission-1");
    expect(item.releasedCount).toBe(1);
    expect(registry.has("mission-1")).toBe(false);
  });

  it("② 重复登记拒绝；重复释放幂等", () => {
    const registry = new MissionRuntimeRegistry();
    registry.register(lease("mission-1"));
    expect(() => registry.register(lease("mission-1"))).toThrow("已有运行时租约");
    registry.release("mission-1");
    registry.release("mission-1");
  });
});
