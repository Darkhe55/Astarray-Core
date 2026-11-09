/**
 * ALIGN-03-02（2026-11-10）：**任务包信包**的白名单、六项校验与权限求交。
 *
 * 卡内 2026-10-28 记录"未跑求交/禁止字段/六项缺失任何一条路径"。本文件补上。
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildTaskBundleDispatchEnvelope,
  intersectToolPermissionCeiling,
} from "../../../packages/core/src/orchestration/task-bundle-dispatch-envelope.js";

vi.setConfig({ testTimeout: 30_000 });

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bundleIdentifier: "bundle-1",
    toolPermissionCeiling: { requestedToolNames: ["readFile", "listDirectory"] },
    projectBoundary: {
      projectIdentifier: "project-alpha",
      workspaceRootPath: "C:/workspace/project-alpha",
      isReadOnly: false,
    },
    originalRequirements: {
      userTaskReference: "user-task-1",
      instructionText: "原始要求",
    },
    completionConditions: {
      acceptanceCriteria: "产物存在",
      requiredArtifactIdentifiers: ["artifact-1"],
    },
    selectedAttachments: [
      { attachmentIdentifier: "attachment-1", contentHash: "hash-1" },
    ],
    toolDocumentationReference: { toolGroupIdentifier: "core", toolGroupRevision: 7 },
    ...overrides,
  };
}

describe("ALIGN-03-02 任务包信包", () => {
  it("合法信包 ⇒ 构造成功，六项齐备", () => {
    const envelope = buildTaskBundleDispatchEnvelope({
      payload: buildPayload(),
      parentEffectiveToolNames: ["readFile", "listDirectory", "writeFileTemporary"],
    });
    expect(envelope.bundleIdentifier).toBe("bundle-1");
    expect(envelope.projectBoundary.projectIdentifier).toBe("project-alpha");
    expect(envelope.originalRequirements.userTaskReference).toBe("user-task-1");
    expect(envelope.completionConditions.acceptanceCriteria).toBe("产物存在");
    expect(envelope.toolDocumentationReference.toolGroupRevision).toBe(7);
  }, 30_000);

  it("**禁止字段**（想重发完整工具库）⇒ 拒绝，不静默忽略", () => {
    for (const forbiddenFieldName of [
      "toolDescriptors",
      "availableTools",
      "toolLibrary",
      "fullDocumentation",
      "toolSchemas",
    ]) {
      expect(() =>
        buildTaskBundleDispatchEnvelope({
          payload: buildPayload({ [forbiddenFieldName]: [] }),
          parentEffectiveToolNames: ["readFile"],
        }),
      ).toThrow(/完整工具库|task-bundle-invalid/u);
    }
  }, 30_000);

  it("未知字段 ⇒ 拒绝（白名单外一律不静默忽略）", () => {
    expect(() =>
      buildTaskBundleDispatchEnvelope({
        payload: buildPayload({ surpriseField: 1 }),
        parentEffectiveToolNames: ["readFile"],
      }),
    ).toThrow(/不支持的字段/u);
  }, 30_000);

  it("**权限求交**：超出上级的工具进 denied，不进入 allowed", () => {
    const envelope = buildTaskBundleDispatchEnvelope({
      payload: buildPayload({
        toolPermissionCeiling: { requestedToolNames: ["readFile", "writeFileTemporary"] },
      }),
      parentEffectiveToolNames: ["readFile", "listDirectory"],
    });
    expect(envelope.allowedToolNames).toEqual(["readFile"]);
    expect(envelope.deniedToolNames).toEqual(["writeFileTemporary"]);
  }, 30_000);

  it("求交为空 ⇒ 拒绝（不发出空权限信包）", () => {
    expect(() =>
      buildTaskBundleDispatchEnvelope({
        payload: buildPayload({
          toolPermissionCeiling: { requestedToolNames: ["writeFileTemporary"] },
        }),
        parentEffectiveToolNames: ["readFile"],
      }),
    ).toThrow(/空权限/u);
  }, 30_000);

  it("**必需项**缺失任一项 ⇒ 拒绝", () => {
    for (const missingFieldName of [
      "toolPermissionCeiling",
      "projectBoundary",
      "originalRequirements",
      "completionConditions",
      "toolDocumentationReference",
    ]) {
      const payload = buildPayload();
      delete payload[missingFieldName];
      expect(() =>
        buildTaskBundleDispatchEnvelope({
          payload,
          parentEffectiveToolNames: ["readFile"],
        }),
      ).toThrow(/task-bundle-invalid|缺失|必须/u);
    }
  }, 30_000);

  it("`selectedAttachments` 是**唯一可选**项：缺省为空数组（不是拒绝）", () => {
    const payload = buildPayload();
    delete payload["selectedAttachments"];
    const envelope = buildTaskBundleDispatchEnvelope({
      payload,
      parentEffectiveToolNames: ["readFile"],
    });
    expect(envelope.selectedAttachments).toEqual([]);
  }, 30_000);

  it("附件缺 contentHash ⇒ 拒绝（不能只给标识）", () => {
    expect(() =>
      buildTaskBundleDispatchEnvelope({
        payload: buildPayload({
          selectedAttachments: [{ attachmentIdentifier: "attachment-1" }],
        }),
        parentEffectiveToolNames: ["readFile"],
      }),
    ).toThrow(/task-bundle-invalid|contentHash|必须/u);
  }, 30_000);

  it("非对象信包 ⇒ 拒绝（数组/字符串/null）", () => {
    for (const payload of [[], "text", null, 42]) {
      expect(() =>
        buildTaskBundleDispatchEnvelope({ payload, parentEffectiveToolNames: ["readFile"] }),
      ).toThrow(/必须是 JSON 对象/u);
    }
  }, 30_000);

  it("权限求交函数：去重并保留顺序", () => {
    const result = intersectToolPermissionCeiling({
      requestedToolNames: ["b", "a", "b"],
      parentEffectiveToolNames: ["a", "b"],
    });
    expect(result.allowedToolNames).toEqual(["b", "a"]);
    expect(result.deniedToolNames).toEqual([]);
  }, 30_000);
});
