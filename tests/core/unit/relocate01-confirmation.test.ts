/**
 * RELOCATE-01 检查点 02 的**反例**（2026-10-18 第 12 轮）。
 *
 * 核心不变量：**模型不得代签**、冲突 revision 拒绝且**无半提交**、重复请求幂等、
 * 执行前复检身份（防确认后被替换）。
 */
import { describe, expect, it } from "vitest";

import { confirmProjectRelocation } from "../../../packages/core/src/orchestration/project-relocation-confirmation.js";
import type { ProjectLocationRegistrationV1 } from "../../../packages/core/src/orchestration/project-location-registration.js";

const registration: ProjectLocationRegistrationV1 = {
  schemaVersion: 1,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 3,
  confirmedBy: "user",
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

const baseInput = {
  registration,
  expectedLocationRevision: 3,
  confirmedProjectRootPath: "E:/moved/alpha",
  isHumanConfirmed: true,
  currentObservedProjectIdentifier: "project-alpha",
  confirmedAtIso: "2026-10-18T01:00:00.000Z",
};

describe("RELOCATE-01-02：重定位确认（fail-closed）", () => {
  it("① 模型/自动流程代签 ⇒ 拒绝 not-human-confirmed", () => {
    const outcome = confirmProjectRelocation({ ...baseInput, isHumanConfirmed: false });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("not-human-confirmed");
    expect(outcome.reason).toContain("不得代确认");
  });

  it("② revision 冲突 ⇒ 拒绝 revision-conflict，且**不返回新登记**（无半提交）", () => {
    const outcome = confirmProjectRelocation({ ...baseInput, expectedLocationRevision: 2 });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("revision-conflict");
    expect("registration" in outcome).toBe(false);
  });

  it("③ 幂等：同 revision + 同目标 ⇒ confirmed + isIdempotentReplay，revision **不递增**", () => {
    const outcome = confirmProjectRelocation({
      ...baseInput,
      confirmedProjectRootPath: registration.rootPath,
    });
    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("应为 confirmed");
    expect(outcome.isIdempotentReplay).toBe(true);
    expect(outcome.registration.locationRevision).toBe(3);
  });

  it("④ 执行前复检身份不符 ⇒ 拒绝 identity-mismatch（防确认后目录被替换）", () => {
    const outcome = confirmProjectRelocation({
      ...baseInput,
      currentObservedProjectIdentifier: "project-beta",
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("identity-mismatch");
  });

  it("⑤ 正常重定位 ⇒ revision+1、保留旧根、来源固定 user", () => {
    const outcome = confirmProjectRelocation(baseInput);
    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("应为 confirmed");
    expect(outcome.isIdempotentReplay).toBe(false);
    expect(outcome.registration.locationRevision).toBe(4);
    expect(outcome.registration.previousRootPath).toBe("D:/work/alpha");
    expect(outcome.registration.rootPath).toBe("E:/moved/alpha");
    expect(outcome.registration.confirmedBy).toBe("user");
  });

  it("⑥ 目标根为空 ⇒ 拒绝 invalid-target", () => {
    const outcome = confirmProjectRelocation({ ...baseInput, confirmedProjectRootPath: "   " });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("invalid-target");
  });

  it("⑦ 复检读不到标识（null）⇒ 拒绝，不得乐观放行", () => {
    const outcome = confirmProjectRelocation({
      ...baseInput,
      currentObservedProjectIdentifier: null,
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("⑧ 代签 + revision 冲突 ⇒ 优先报 not-human-confirmed（代签永远先拒）", () => {
    const outcome = confirmProjectRelocation({
      ...baseInput,
      isHumanConfirmed: false,
      expectedLocationRevision: 1,
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") throw new Error("应为 rejected");
    expect(outcome.rejectionCode).toBe("not-human-confirmed");
  });
});
