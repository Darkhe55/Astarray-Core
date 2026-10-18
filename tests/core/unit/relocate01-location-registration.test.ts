/**
 * RELOCATE-01 检查点 01：位置登记 schema 的**反例**（2026-10-18 第 10 轮）。
 *
 * 三条不可退让：旧格式**不得自动升级**、不认识版本**不得按 v1 解释**、缺字段**不得当作有效**。
 */
import { describe, expect, it } from "vitest";

import { parseProjectLocationRegistration } from "../../../packages/core/src/orchestration/project-location-registration.js";

const validRegistration = {
  schemaVersion: 1,
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  rootPath: "D:/work/alpha",
  previousRootPath: null,
  locationRevision: 3,
  confirmedBy: "user",
  confirmedAtIso: "2026-10-18T00:00:00.000Z",
};

describe("RELOCATE-01-01：位置登记解析（fail-closed）", () => {
  it("① 完整 v1 记录 ⇒ valid，且字段原样返回", () => {
    const outcome = parseProjectLocationRegistration(validRegistration);
    expect(outcome.kind).toBe("valid");
    if (outcome.kind !== "valid") throw new Error("应为 valid");
    expect(outcome.registration.locationRevision).toBe(3);
    expect(outcome.registration.previousRootPath).toBeNull();
  });

  it("② 无 schemaVersion ⇒ legacy（**不得**自动升级）", () => {
    const { schemaVersion, ...withoutVersion } = validRegistration;
    void schemaVersion;
    const outcome = parseProjectLocationRegistration(withoutVersion);
    expect(outcome.kind).toBe("legacy");
    if (outcome.kind !== "legacy") throw new Error("应为 legacy");
    expect(outcome.reason).toContain("不自动升级");
  });

  it("③ 有版本但缺 deviceIdentifier ⇒ legacy（早于设备登记）", () => {
    const { deviceIdentifier, ...withoutDevice } = validRegistration;
    void deviceIdentifier;
    const outcome = parseProjectLocationRegistration(withoutDevice);
    expect(outcome.kind).toBe("legacy");
  });

  it("④ 不认识的 schemaVersion ⇒ invalid（不得按 v1 解释）", () => {
    const outcome = parseProjectLocationRegistration({ ...validRegistration, schemaVersion: 2 });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") throw new Error("应为 invalid");
    expect(outcome.reason).toContain("拒绝按 v1 解释");
  });

  it("⑤ locationRevision 必须是 ≥1 整数（0 / 小数 / 字符串均 invalid）", () => {
    for (const badRevision of [0, -1, 1.5, "3", null]) {
      const outcome = parseProjectLocationRegistration({
        ...validRegistration,
        locationRevision: badRevision,
      });
      expect(outcome.kind).toBe("invalid");
    }
  });

  it("⑥ confirmedBy 只能是 user / system-migration（模型不得作为来源）", () => {
    for (const badSource of ["model", "assistant", "agent", null]) {
      const outcome = parseProjectLocationRegistration({
        ...validRegistration,
        confirmedBy: badSource,
      });
      expect(outcome.kind).toBe("invalid");
    }
  });

  it("⑦ 缺 rootPath / confirmedAtIso ⇒ invalid；非对象 ⇒ invalid", () => {
    const { rootPath, ...withoutRoot } = validRegistration;
    void rootPath;
    expect(parseProjectLocationRegistration(withoutRoot).kind).toBe("invalid");

    const { confirmedAtIso, ...withoutTime } = validRegistration;
    void confirmedAtIso;
    expect(parseProjectLocationRegistration(withoutTime).kind).toBe("invalid");

    expect(parseProjectLocationRegistration(null).kind).toBe("invalid");
    expect(parseProjectLocationRegistration([validRegistration]).kind).toBe("invalid");
    expect(parseProjectLocationRegistration("not-an-object").kind).toBe("invalid");
  });

  it("⑧ 空串字段不得当作有效（projectIdentifier / deviceIdentifier 空串 ⇒ legacy）", () => {
    expect(
      parseProjectLocationRegistration({ ...validRegistration, projectIdentifier: "   " }).kind,
    ).toBe("legacy");
    expect(
      parseProjectLocationRegistration({ ...validRegistration, deviceIdentifier: "" }).kind,
    ).toBe("legacy");
  });

  it("⑨ previousRootPath 若存在必须是非空字符串", () => {
    expect(
      parseProjectLocationRegistration({ ...validRegistration, previousRootPath: "  " }).kind,
    ).toBe("invalid");
    expect(
      parseProjectLocationRegistration({ ...validRegistration, previousRootPath: "D:/work/old" })
        .kind,
    ).toBe("valid");
  });
});
