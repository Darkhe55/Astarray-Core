/**
 * CLUSTER-01 §5：主 Agent 不得获得聚类工具。
 *
 * 卡内要求"主 Agent 和思索模式只可用只读 action，不能 build/feedback"。
 * 现状实现比要求**更严格**：主 Agent 用**固定只读白名单**，聚类工具根本不在名单里，
 * 因此连只读 action 也不暴露。本用例锁定这个事实，避免以后有人"顺手"把它加进去。
 */
import { describe, expect, it } from "vitest";

import { DIAGNOSTIC_CLUSTER_TOOL_NAME } from "../../../packages/core/src/orchestration/diagnostic-cluster-tools.js";
import {
  MAIN_AGENT_READONLY_TOOL_NAMES,
  MainAgentReadonlyToolProjection,
} from "../../../packages/core/src/tools/main-agent-readonly-projection.js";

describe("CLUSTER-01 主 Agent 投影", () => {
  it("聚类工具不在主 Agent 只读白名单里，且投影会把它过滤掉", () => {
    expect((MAIN_AGENT_READONLY_TOOL_NAMES as readonly string[]).includes(DIAGNOSTIC_CLUSTER_TOOL_NAME)).toBe(
      false,
    );
    const projection = new MainAgentReadonlyToolProjection();
    const projected = projection.projectTools([DIAGNOSTIC_CLUSTER_TOOL_NAME, "readFile"]);
    expect(projected).toEqual(["readFile"]);
  });

  it("即使只请求只读 action，主 Agent 也拿不到该工具（比卡内要求更严格）", () => {
    const projection = new MainAgentReadonlyToolProjection();
    /** 投影只看工具名，不看 action：不存在"传了 read 就放行"的路径。 */
    expect(projection.projectTools([DIAGNOSTIC_CLUSTER_TOOL_NAME])).toEqual([]);
  });
});
