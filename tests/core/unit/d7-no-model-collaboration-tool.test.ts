/**
 * D7（2026-11-23 产品裁决）：**不把 sendCollaborationRequest 注册为模型写工具**。
 *
 * 裁决要点：
 * - Worker 只能通过反馈信箱逐级请示，本级有权且能决定就结案；
 * - 到主层仍未决时只呈交用户或已激活秘书；
 * - "原有宿主定向通信继续使用" ⇒ SDK/宿主方法保留，但**不得**出现在模型工具集里。
 *
 * 本文件把这条边界钉成实用新型：模型侧工具集不含协作请求工具；宿主 API 仍存在。
 */
import { describe, expect, it } from "vitest";

import { BUILTIN_TOOL_DESCRIPTORS } from "../../../packages/core/src/tools/builtins.js";
import { ToolRegistry } from "../../../packages/core/src/tools/registry.js";
import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

describe("D7：协作请求只走宿主通道，不作为模型工具", () => {
  it("① 内置工具集不含协作请求类工具", () => {
    const builtinNames = BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);
    expect(builtinNames).not.toContain("sendCollaborationRequest");
    expect(
      builtinNames.filter((name) => /collaboration|collaborationRequest|sendRequest/i.test(name)),
    ).toEqual([]);
  });

  it("② 生产注册表（内置描述符全集）查不到该工具", () => {
    const registry = new ToolRegistry();
    registry.registerMany(BUILTIN_TOOL_DESCRIPTORS);
    expect(registry.getDescriptor("sendCollaborationRequest")).toBeUndefined();
    expect(registry.getPreviewDescriptors().map((descriptor) => descriptor.name)).not.toContain(
      "sendCollaborationRequest",
    );
  });

  it("③ 宿主 API 仍在（原有定向通信继续使用）", () => {
    expect(typeof AstarrayApplicationFacade.prototype.sendCollaborationRequest).toBe("function");
  });
});
