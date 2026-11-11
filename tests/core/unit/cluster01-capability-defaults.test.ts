/**
 * CLUSTER-01 §5：权限能力与默认值锁定（`getCapabilityIdsForCall` 支持 action 级）。
 *
 * 为什么必须测：默认值写错会**静默放行写操作**。
 * 这里断言"查询允许、构建需询问"，并验证 action 级调用能拿到对应能力。
 */
import { describe, expect, it } from "vitest";

import {
  PermissionCapabilityCatalog,
  PERMISSION_CATALOG_VERSION,
} from "../../../packages/core/src/tools/permission-capability-catalog.js";
import { DIAGNOSTIC_CLUSTER_TOOL_NAME } from "../../../packages/core/src/orchestration/diagnostic-cluster-tools.js";

describe("CLUSTER-01 权限能力目录", () => {
  const catalog = new PermissionCapabilityCatalog();

  it("能力已登记且版本号未倒退", () => {
    expect(catalog.getCatalogVersion()).toBe(PERMISSION_CATALOG_VERSION);
    expect(catalog.getCapability("diagnostic.clusters.read")?.capabilityId).toBe("diagnostic.clusters.read");
    expect(catalog.getCapability("diagnostic.clusters.build")?.capabilityId).toBe("diagnostic.clusters.build");
  });

  it("**查询默认允许、构建默认需询问**（默认值不得写反）", () => {
    const readCapability = catalog.getCapability("diagnostic.clusters.read");
    const buildCapability = catalog.getCapability("diagnostic.clusters.build");
    expect(readCapability?.assistDefault).toBe("allow");
    expect(readCapability?.devolveDefault).toBe("allow");
    expect(buildCapability?.assistDefault).toBe("ask");
    expect(buildCapability?.devolveDefault).toBe("ask");
  });

  it("工具映射同时登记读与构建两个能力（按最严格登记）", () => {
    expect(catalog.getToolCapabilityIds(DIAGNOSTIC_CLUSTER_TOOL_NAME)).toEqual([
      "diagnostic.clusters.read",
      "diagnostic.clusters.build",
    ]);
  });

  it("action 级调用能区分读写（build 带上构建能力）", () => {
    const readActions = catalog.getCapabilityIdsForCall(DIAGNOSTIC_CLUSTER_TOOL_NAME, "list");
    const buildActions = catalog.getCapabilityIdsForCall(DIAGNOSTIC_CLUSTER_TOOL_NAME, "build");
    expect(readActions).toContain("diagnostic.clusters.read");
    expect(buildActions).toContain("diagnostic.clusters.build");
  });
});
