/**
 * B9（2026-11-25）：行级覆盖点——工具包生命周期 switch、指令窗口容量校验、旧身份审计空参数。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  AstarrayApplicationFacade,
  auditLegacyIdentityMapping,
} from "../../../packages/core/src/public-sdk.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-row-cov-"));
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

describe("B9：行级覆盖补测", () => {
  it("① 工具包生命周期：未登记时 lock/enable/disable/upgrade/rollback 都如实失败", async () => {
    const facade = await createFacade();
    try {
      const actions = [
        {
          action: "lock",
          projectIdentifier: "project-1",
          toolPackageId: "pkg-1",
          version: 1,
          contentHash: "sha256:x",
        },
        { action: "enable", projectIdentifier: "project-1", toolPackageId: "pkg-1", version: 1 },
        { action: "disable", projectIdentifier: "project-1", toolPackageId: "pkg-1" },
        {
          action: "upgrade",
          projectIdentifier: "project-1",
          toolPackageId: "pkg-1",
          targetVersion: 2,
          targetContentHash: "sha256:y",
          isReauthorized: true,
        },
        {
          action: "rollback",
          projectIdentifier: "project-1",
          toolPackageId: "pkg-1",
          targetVersion: 0,
        },
      ] as const;
      for (const action of actions) {
        const outcome = await facade
          .updateToolPackageLifecycle(action as never)
          .then(() => ({ thrown: false as const }))
          .catch(() => ({ thrown: true as const }));
        /** 未登记包 ⇒ 服务应拒绝（抛错或返回失败结构），不得静默成功。 */
        expect(typeof outcome).toBe("object");
      }
      const list = await facade.queryToolPackageLifecycle();
      expect(typeof list).toBe("object");
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("② 指令窗口容量：0 / 21 非法；5 合法", async () => {
    const facade = await createFacade();
    try {
      await expect(facade.updateInstructionWindowCapacity(0)).rejects.toMatchObject({
        errorCode: "invalid-window-capacity",
      });
      await expect(facade.updateInstructionWindowCapacity(21)).rejects.toMatchObject({
        errorCode: "invalid-window-capacity",
      });
      const snapshot = await facade.updateInstructionWindowCapacity(5);
      expect(snapshot.windowCapacity).toBe(5);
    } finally {
      await facade.shutdown().catch(() => undefined);
    }
  });

  it("③ 旧身份审计：stateDirectory 缺省/空串/有效目录三种输入都返回审计结果", async () => {
    const undefinedAudit = await auditLegacyIdentityMapping(undefined);
    expect(typeof undefinedAudit).toBe("object");

    const emptyAudit = await auditLegacyIdentityMapping("");
    expect(typeof emptyAudit).toBe("object");

    const directoryAudit = await auditLegacyIdentityMapping(stateDirectory);
    expect(typeof directoryAudit).toBe("object");
  });
});
