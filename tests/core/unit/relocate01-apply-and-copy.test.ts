/**
 * RELOCATE-01 检查点 02 剩余两项的**反例**（2026-10-18 第 13 轮）：
 * 备份/原子应用（无半提交）与副本独立身份（不继承）。
 */
import { describe, expect, it } from "vitest";

import {
  applyProjectRelocation,
  createCopiedProjectIdentity,
  type ProjectLocationRegistrationIoPort,
} from "../../../packages/core/src/orchestration/project-relocation-apply.js";
import type { ProjectLocationRegistrationV1 } from "../../../packages/core/src/orchestration/project-location-registration.js";

const previousRegistration: ProjectLocationRegistrationV1 = {
  schemaVersion: 1,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 3,
  confirmedBy: "user",
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

const confirmedRegistration: ProjectLocationRegistrationV1 = {
  ...previousRegistration,
  rootPath: "E:/moved/alpha",
  previousRootPath: "D:/work/alpha",
  locationRevision: 4,
};

const confirmedOutcome = {
  kind: "confirmed" as const,
  registration: confirmedRegistration,
  isIdempotentReplay: false,
};

/** 记录调用顺序与内容的假端口。 */
function createRecordingPort(options?: { failWriteRegistrationTimes?: number }) {
  const callLog: string[] = [];
  let failRemaining = options?.failWriteRegistrationTimes ?? 0;
  const port: ProjectLocationRegistrationIoPort = {
    writeBackup: async (registration) => {
      callLog.push("backup:" + String(registration.locationRevision));
    },
    writeRegistration: async (registration) => {
      callLog.push("write:" + String(registration.locationRevision));
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error("模拟写盘失败");
      }
    },
  };
  return { port, callLog };
}

describe("RELOCATE-01-02：备份与原子应用（不得半提交）", () => {
  it("① 未注入写盘端口 ⇒ 拒绝 no-io-port（不假装成功）", async () => {
    const outcome = await applyProjectRelocation({
      ioPort: null,
      previousRegistration,
      confirmation: confirmedOutcome,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("② 未获确认 ⇒ 拒绝 confirmation-not-granted", async () => {
    const { port } = createRecordingPort();
    const outcome = await applyProjectRelocation({
      ioPort: port,
      previousRegistration,
      confirmation: { kind: "rejected", rejectionCode: "revision-conflict", reason: "x" },
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("③ 正常应用 ⇒ **先备份再写**（顺序固定）", async () => {
    const { port, callLog } = createRecordingPort();
    const outcome = await applyProjectRelocation({
      ioPort: port,
      previousRegistration,
      confirmation: confirmedOutcome,
    });
    expect(outcome.kind).toBe("applied");
    expect(callLog).toEqual(["backup:3", "write:4"]);
  });

  it("④ 写新失败 ⇒ 回写旧登记（didRestorePrevious=true，无半提交）", async () => {
    // 第一次 writeRegistration 失败，之后的回写成功
    const { port } = createRecordingPort({ failWriteRegistrationTimes: 1 });
    const outcome = await applyProjectRelocation({
      ioPort: port,
      previousRegistration,
      confirmation: confirmedOutcome,
    });
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("应为 failed");
    expect(outcome.didRestorePrevious).toBe(true);
  });

  it("⑤ 幂等重放 ⇒ **不重复写盘**", async () => {
    const { port, callLog } = createRecordingPort();
    const outcome = await applyProjectRelocation({
      ioPort: port,
      previousRegistration,
      confirmation: { ...confirmedOutcome, isIdempotentReplay: true },
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("应为 applied");
    expect(outcome.isWriteSkipped).toBe(true);
    expect(callLog).toEqual([]);
  });

  it("⑥ 备份失败 ⇒ 拒绝且**不写登记**", async () => {
    const callLog: string[] = [];
    const port: ProjectLocationRegistrationIoPort = {
      writeBackup: async () => {
        throw new Error("模拟备份失败");
      },
      writeRegistration: async (registration) => {
        callLog.push("write:" + String(registration.locationRevision));
      },
    };
    const outcome = await applyProjectRelocation({
      ioPort: port,
      previousRegistration,
      confirmation: confirmedOutcome,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("backup-failed");
    expect(callLog).toEqual([]);
  });
});

describe("RELOCATE-01-02：副本独立身份（不继承）", () => {
  it("⑦ 副本沿用源标识 ⇒ 拒绝（会共享身份与历史域）", () => {
    const outcome = createCopiedProjectIdentity({
      sourceRegistration: previousRegistration,
      newProjectIdentifier: "project-alpha",
      newRootPath: "E:/copy/alpha",
      confirmedAtIso: "2026-10-18T02:00:00.000Z",
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("⑧ 副本创建 ⇒ 新身份、revision=1、无 previousRootPath、**不继承任何状态**", () => {
    const outcome = createCopiedProjectIdentity({
      sourceRegistration: previousRegistration,
      newProjectIdentifier: "project-alpha-copy",
      newRootPath: "E:/copy/alpha",
      confirmedAtIso: "2026-10-18T02:00:00.000Z",
    });
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("应为 created");
    expect(outcome.registration.projectIdentifier).toBe("project-alpha-copy");
    expect(outcome.registration.locationRevision).toBe(1);
    expect(outcome.registration.previousRootPath).toBeNull();
    expect(outcome.inheritedState).toEqual({
      pendingTaskCount: 0,
      outstandingPermissionGrantCount: 0,
      temporaryEscalationCount: 0,
      activeAgentIdentityCount: 0,
    });
  });
});
