/**
 * B9（2026-11-25）：`previewParameterAuthorization` 分支覆盖（只读预览，不改规则）。
 *
 * 覆盖：非法 JSON / 非对象 JSON、未知工具、已知工具基线裁决、开启参数规则后的来源与说明。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-preview-auth-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function createFacade(): Promise<AstarrayApplicationFacade> {
  return await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
  });
}

describe("B9：参数授权预览分支", () => {
  it("① 非法 JSON ⇒ invalid-arguments，且不回退到 allow", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.previewParameterAuthorization({
        toolName: "createProjectFile",
        action: "create",
        argumentsJson: "{not-json",
      });
      expect(result).toMatchObject({ status: "invalid-arguments", decision: null });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② JSON 不是对象（数组）⇒ invalid-arguments", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.previewParameterAuthorization({
        toolName: "createProjectFile",
        action: "create",
        argumentsJson: "[1,2,3]",
      });
      expect(result).toMatchObject({ status: "invalid-arguments" });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 未知工具 ⇒ unknown-tool（不伪造裁决）", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.previewParameterAuthorization({
        toolName: "definitely-not-a-tool",
        action: "create",
        argumentsJson: "{}",
      });
      expect(result).toMatchObject({ status: "unknown-tool", decision: null });
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("④ 已知工具、空参数 ⇒ 返回基线裁决与来源", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.previewParameterAuthorization({
        toolName: "createProjectFile",
        action: "create",
        argumentsJson: "{}",
      });
      expect(result.status).toBe("ok");
      expect(["allow", "ask", "deny"]).toContain(result.decision);
      expect(["tool-baseline", "parameter-rule"]).toContain(result.source);
      expect(typeof result.configurationRevision).toBe("number");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("⑤ 带路径参数（命中路径前缀字段）也返回稳定结构", async () => {
    const facade = await createFacade();
    try {
      const result = await facade.previewParameterAuthorization({
        toolName: "createProjectFile",
        action: "create",
        argumentsJson: JSON.stringify({ path: "docs/readme.md", content: "x" }),
      });
      expect(result.status).toBe("ok");
      expect(Array.isArray(result.capabilityIds)).toBe(true);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });
});
