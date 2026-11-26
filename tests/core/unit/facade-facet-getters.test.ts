/**
 * AXIOMATIC-DESIGN P2（2026-11-26）：门面**子门面只读入口**的契约。
 *
 * 目的：CLI/宿主可按需依赖 `facade.goal` 等窄面，而不是整门面；
 * 验证：getter 存在、重复访问返回同一实例（缓存）、关闭后调用走关闭态。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-facets-"));
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

describe("AXIOMATIC P2：门面子门面入口", () => {
  it("① 五个子门面都存在，且重复访问返回同一实例（缓存）", async () => {
    const facade = await createFacade();
    try {
      expect(facade.goal).toBe(facade.goal);
      expect(facade.permission).toBe(facade.permission);
      expect(facade.ops).toBe(facade.ops);
      expect(facade.context).toBe(facade.context);
      expect(facade.mission).toBe(facade.mission);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 子门面暴露窄方法面（不含门面其余方法）", async () => {
    const facade = await createFacade();
    try {
      expect(typeof facade.goal.describeGoalStatus).toBe("function");
      expect(typeof facade.permission.previewParameterAuthorization).toBe("function");
      expect(typeof facade.ops.queryArtifacts).toBe("function");
      expect(typeof facade.context.queryContextSettings).toBe("function");
      expect(typeof facade.mission.queryMissionRawStatus).toBe("function");

      /** 窄面：子门面对象上不应出现"整个门面"的方法（例如 submitTask）。 */
      expect("submitTask" in facade.goal).toBe(false);
      expect("shutdown" in facade.ops).toBe(false);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 关闭后调用子门面方法 ⇒ 关闭态拒绝（不触达底层服务）", async () => {
    const facade = await createFacade();
    await facade.shutdown();
    await expect(facade.context.queryContextSettings()).rejects.toThrow();
    expect(() => facade.goal.getGoalModeActivation()).toThrow();
  });
});
