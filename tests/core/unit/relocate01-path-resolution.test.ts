/**
 * RELOCATE-01 检查点 03 的**反例**（2026-10-18 第 15 轮）：结构化资源路径解析。
 */
import { describe, expect, it } from "vitest";

import { resolveStructuredResourcePath } from "../../../packages/core/src/orchestration/project-relocation-path-resolution.js";

const mapping = {
  projectIdentifier: "project-alpha",
  deviceIdentifier: "device-1",
  fromLocationRevision: 3,
  oldRootPath: "D:/work/alpha",
  newRootPath: "E:/moved/alpha",
};

const declaredKinds = ["mission-artifact", "checkpoint-record"];

const baseReference = {
  resourceKind: "mission-artifact",
  requestedPath: "D:/work/alpha/missions/m-1/artifact.json",
  owningProjectIdentifier: "project-alpha",
  owningDeviceIdentifier: "device-1",
  capturedLocationRevision: 2,
};

describe("RELOCATE-01-03：结构化路径解析（fail-closed）", () => {
  it("① 声明过的结构化资源 ⇒ 改写到新根下的同一相对路径，并保留原请求路径", () => {
    const outcome = resolveStructuredResourcePath({
      reference: baseReference,
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("应为 resolved");
    expect(outcome.resolvedPath).toBe("E:/moved/alpha/missions/m-1/artifact.json");
    expect(outcome.requestedPath).toBe(baseReference.requestedPath);
    expect(outcome.wasRewritten).toBe(true);
  });

  it("② 未声明的种类（历史消息/日志/源码/命令串）⇒ **永不改写**", () => {
    for (const kind of ["chat-message", "log", "source-file", "shell-command"]) {
      const outcome = resolveStructuredResourcePath({
        reference: { ...baseReference, resourceKind: kind },
        mappings: [mapping],
        declaredStructuredResourceKinds: declaredKinds,
      });
      expect(outcome.kind).toBe("unresolved");
      if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
      expect(outcome.rejectionCode).toBe("unsupported-resource-kind");
    }
  });

  it("③ 跨项目引用 ⇒ 拒绝 foreign-project（不截获其他项目访问）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: { ...baseReference, owningProjectIdentifier: "project-beta" },
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
    expect(outcome.rejectionCode).toBe("foreign-project");
  });

  it("④ 跨设备 ⇒ 拒绝 foreign-device", () => {
    const outcome = resolveStructuredResourcePath({
      reference: { ...baseReference, owningDeviceIdentifier: "device-2" },
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
    expect(outcome.rejectionCode).toBe("foreign-device");
  });

  it("⑤ 路径不在旧根之内 ⇒ 拒绝 outside-old-root（外部文件不纳入）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: { ...baseReference, requestedPath: "F:/elsewhere/artifact.json" },
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
    expect(outcome.rejectionCode).toBe("outside-old-root");
  });

  it("⑥ 嵌套/重叠旧根导致多个映射命中 ⇒ 拒绝 ambiguous-mapping（不自动选择）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: baseReference,
      mappings: [
        mapping,
        { ...mapping, oldRootPath: "D:/work/alpha/missions", newRootPath: "E:/other/missions" },
      ],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
    expect(outcome.rejectionCode).toBe("ambiguous-mapping");
  });

  it("⑦ 映射之后产生的引用（已在新区）⇒ 不改写", () => {
    const outcome = resolveStructuredResourcePath({
      reference: {
        ...baseReference,
        requestedPath: "E:/moved/alpha/missions/m-1/artifact.json",
        capturedLocationRevision: 4,
      },
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("应为 resolved");
    expect(outcome.wasRewritten).toBe(false);
  });

  it("⑧ 声明集合为空 ⇒ 任何种类都不改写（默认不解析）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: baseReference,
      mappings: [mapping],
      declaredStructuredResourceKinds: [],
    });
    expect(outcome.kind).toBe("unresolved");
  });

  it("⑨ `old-project-extra` 不属于 `old-project`（禁前缀判定）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: { ...baseReference, requestedPath: "D:/work/alpha-extra/missions/m-1.json" },
      mappings: [mapping],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
    if (outcome.kind !== "unresolved") throw new Error("应为 unresolved");
    expect(outcome.rejectionCode).toBe("outside-old-root");
  });

  it("⑩ 无任何映射 ⇒ 不改写（未重定位前不猜测路径）", () => {
    const outcome = resolveStructuredResourcePath({
      reference: baseReference,
      mappings: [],
      declaredStructuredResourceKinds: declaredKinds,
    });
    expect(outcome.kind).toBe("unresolved");
  });
});
