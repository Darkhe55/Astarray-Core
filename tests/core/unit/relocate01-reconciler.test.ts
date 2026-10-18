/**
 * RELOCATE-01-03 接线判定的反例（2026-10-19 R31）。
 *
 * 用户决策（按推荐）：冷启动只碰"进行中/未决"、只读可自动恢复、含写必须人工确认、
 * 不满足即 blocked、已完成绝不重放、旧一次性许可/临时提升不恢复、副作用未知即阻塞。
 */
import { describe, expect, it } from "vitest";

import { reconcileProjectRelocation } from "../../../packages/core/src/orchestration/project-relocation-reconciler.js";

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    projectIdentifier: "project-a",
    deviceIdentifier: "device-1",
    fromLocationRevision: 2,
    oldRootPath: "/old/project-a",
    newRootPath: "/new/project-a",
    ...overrides,
  };
}

function reference(overrides: Record<string, unknown> = {}) {
  return {
    resourceKind: "document",
    requestedPath: "/old/project-a/docs/spec.md",
    owningProjectIdentifier: "project-a",
    owningDeviceIdentifier: "device-1",
    capturedLocationRevision: 2,
    ...overrides,
  };
}

function pendingOperation(overrides: Record<string, unknown> = {}) {
  return {
    operation: {
      operationIdentifier: "op-1",
      isCompleted: false,
      isIdempotent: true,
      hasUnknownSideEffect: false,
      ...(overrides.operation as Record<string, unknown> | undefined),
    },
    hasCurrentPermissionAtNewLocation: true,
    reliesOnPreviousOneTimeGrant: false,
    reliesOnTemporaryEscalation: false,
    ...overrides,
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    projectIdentifier: "project-a",
    projectStatus: "in-progress" as const,
    locationMappings: [mapping()],
    declaredStructuredResourceKinds: ["document"],
    references: [reference()],
    pendingOperations: [pendingOperation()],
    hasWriteOrExternalSideEffects: false,
    ...overrides,
  };
}

describe("RELOCATE-01-03：重定位对账判定", () => {
  it("① 只读且全部解析 ⇒ 允许自动恢复", () => {
    const result = reconcileProjectRelocation(baseInput());
    expect(result.kind).toBe("reconciled");
    expect(result.isAutoResumeAllowed).toBe(true);
    expect(result.isExecutionAllowed).toBe(true);
    expect(result.resolvedReferences[0]?.resolvedPath).toContain("/new/project-a");
  });

  it("② 已完成项目 ⇒ 跳过，绝不重放", () => {
    const result = reconcileProjectRelocation(
      baseInput({ projectStatus: "completed", pendingOperations: [] }),
    );
    expect(result.kind).toBe("skipped-already-completed");
    expect(result.isAutoResumeAllowed).toBe(false);
    expect(result.isExecutionAllowed).toBe(false);
  });

  it("③ 引用无法解析（种类未声明/跨项目/旧根外）⇒ blocked，不自动降级", () => {
    expect(
      reconcileProjectRelocation(
        baseInput({ declaredStructuredResourceKinds: [] }),
      ),
    ).toMatchObject({ kind: "blocked" });

    expect(
      reconcileProjectRelocation(
        baseInput({ references: [reference({ owningProjectIdentifier: "project-b" })] }),
      ),
    ).toMatchObject({ kind: "blocked" });

    expect(
      reconcileProjectRelocation(
        baseInput({ references: [reference({ requestedPath: "/elsewhere/spec.md" })] }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("④ 含写/外部副作用 ⇒ 不自动恢复，需人工确认", () => {
    const result = reconcileProjectRelocation(
      baseInput({ hasWriteOrExternalSideEffects: true }),
    );
    expect(result.kind).toBe("reconciled");
    expect(result.isAutoResumeAllowed).toBe(false);
    expect(result.isExecutionAllowed).toBe(false);
    expect(result.requiredUserAction).toContain("人工确认");
  });

  it("⑤ 旧一次性许可/临时提升不恢复 ⇒ blocked", () => {
    expect(
      reconcileProjectRelocation(
        baseInput({
          pendingOperations: [pendingOperation({ reliesOnPreviousOneTimeGrant: true })],
        }),
      ),
    ).toMatchObject({ kind: "blocked" });

    expect(
      reconcileProjectRelocation(
        baseInput({
          pendingOperations: [pendingOperation({ reliesOnTemporaryEscalation: true })],
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("⑥ 新位置权限复检失败 ⇒ blocked；副作用未知 ⇒ blocked", () => {
    expect(
      reconcileProjectRelocation(
        baseInput({
          pendingOperations: [pendingOperation({ hasCurrentPermissionAtNewLocation: false })],
        }),
      ),
    ).toMatchObject({ kind: "blocked" });

    expect(
      reconcileProjectRelocation(
        baseInput({
          pendingOperations: [
            pendingOperation({
              operation: {
                operationIdentifier: "op-1",
                isCompleted: false,
                isIdempotent: false,
                hasUnknownSideEffect: true,
              },
            }),
          ],
        }),
      ),
    ).toMatchObject({ kind: "blocked" });
  });

  it("⑦ 已完成的操作 ⇒ 跳过（不重放），不影响其余判定", () => {
    const result = reconcileProjectRelocation(
      baseInput({
        pendingOperations: [
          pendingOperation({
            operation: {
              operationIdentifier: "op-done",
              isCompleted: true,
              isIdempotent: true,
              hasUnknownSideEffect: false,
            },
          }),
        ],
      }),
    );
    expect(result.kind).toBe("reconciled");
    expect(result.pendingOperationDecisions[0]?.decisionKind).toBe("skip-already-completed");
    expect(result.isAutoResumeAllowed).toBe(true);
  });

  it("⑧ 符号链接/junction 指向项目外 ⇒ 解析失败即 blocked（不静默跟随）", () => {
    const result = reconcileProjectRelocation(
      baseInput({
        references: [reference({ requestedPath: "/old/project-a/../../outside/secret.txt" })],
      }),
    );
    expect(result.kind).toBe("blocked");
    expect(result.unresolvedReferences[0]?.rejectionCode).toBeTruthy();
  });
});


