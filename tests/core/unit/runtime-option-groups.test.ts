/**
 * AXIOMATIC-DESIGN P5（2026-11-26）：`createApplicationRuntime` 选项分组的反例。
 *
 * 兼容性：旧平铺字段继续有效；分组只是新增入口。冲突必须显式报错，不得静默择一。
 */
import { describe, expect, it } from "vitest";

import {
  RuntimeOptionConflictError,
  resolveRuntimeOptionGroups,
} from "../../../packages/core/src/application/runtime-option-groups.js";

const baseOptions = {
  mode: "assist" as const,
  stateDirectory: "C:/tmp/state",
  concurrency: 1,
  failureThreshold: 1,
  maxLoopIterations: 1,
  useFeedbackProcess: false,
};

describe("AXIOMATIC P5：运行时选项分组", () => {
  it("① 无分组入口 ⇒ 原样返回（旧调用方零改动）", () => {
    const options = { ...baseOptions };
    expect(resolveRuntimeOptionGroups(options)).toBe(options);
  });

  it("② 分组字段合并为平铺字段（执行/观测/目标三组）", () => {
    const resolved = resolveRuntimeOptionGroups({
      ...baseOptions,
      optionGroups: {
        execution: { isSandboxBackendAutoDetected: true, sandboxApplicationRootPath: "C:/app" },
        observability: { isPerformanceCollectionEnabled: true },
        mission: { maximumTaskChainCumulativeSourceFiles: 42 },
      },
    });
    expect(resolved).toMatchObject({
      isSandboxBackendAutoDetected: true,
      sandboxApplicationRootPath: "C:/app",
      isPerformanceCollectionEnabled: true,
      maximumTaskChainCumulativeSourceFiles: 42,
    });
    expect("optionGroups" in resolved).toBe(false);
  });

  it("③ 平铺与分组同值 ⇒ 允许（以分组为准，不报错）", () => {
    const resolved = resolveRuntimeOptionGroups({
      ...baseOptions,
      isPerformanceCollectionEnabled: true,
      optionGroups: { observability: { isPerformanceCollectionEnabled: true } },
    });
    expect(resolved.isPerformanceCollectionEnabled).toBe(true);
  });

  it("④ 平铺与分组不同值 ⇒ 抛冲突错误并列出字段（不静默择一）", () => {
    expect(() =>
      resolveRuntimeOptionGroups({
        ...baseOptions,
        isDiagnosticCollectionEnabled: false,
        optionGroups: { observability: { isDiagnosticCollectionEnabled: true } },
      }),
    ).toThrow(RuntimeOptionConflictError);

    try {
      resolveRuntimeOptionGroups({
        ...baseOptions,
        isDiagnosticCollectionEnabled: false,
        optionGroups: { observability: { isDiagnosticCollectionEnabled: true } },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeOptionConflictError);
      expect((error as RuntimeOptionConflictError).conflicts).toEqual([
        "isDiagnosticCollectionEnabled",
      ]);
    }
  });

  it("⑤ 非严格模式 ⇒ 冲突字段保留平铺值（供诊断/迁移使用）", () => {
    const resolved = resolveRuntimeOptionGroups(
      {
        ...baseOptions,
        isDiagnosticCollectionEnabled: false,
        optionGroups: { observability: { isDiagnosticCollectionEnabled: true } },
      },
      { strict: false },
    );
    expect(resolved.isDiagnosticCollectionEnabled).toBe(false);
  });

  it("⑥ 分组内 undefined ⇒ 不覆盖平铺值", () => {
    const resolved = resolveRuntimeOptionGroups({
      ...baseOptions,
      isSandboxWeakIsolationEnabled: true,
      optionGroups: { execution: { isSandboxWeakIsolationForced: true } },
    });
    expect(resolved.isSandboxWeakIsolationEnabled).toBe(true);
    expect((resolved as Record<string, unknown>).isSandboxWeakIsolationForced).toBe(true);
  });
});
