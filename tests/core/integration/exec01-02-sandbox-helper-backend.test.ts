/**
 * EXEC-01-02（2026-11-09）：**原生沙箱辅助程序后端**的协议与如实探测。
 *
 * 本文件钉住两条纪律：
 *  1. 探测输出**不完整**（缺成功标记）时一律判不可用 —— 不允许"看起来像成功"；
 *  2. 能力不可用时 `start` **拒绝执行**（`execution-backend-unsupported`），
 *     绝不静默降级到宿主进程执行。
 *
 * 这里用**注入的进程实现**验证协议与判定逻辑；隔离强度本身由
 * `docs/reports/EXEC01_02_B1_REVISED_2026-11-09.md` 的真实运行记录证明，不在此声称。
 */
import { describe, expect, it } from "vitest";

import {
  interpretProbeOutput,
  SandboxHelperBackend,
  type SandboxHelperProcess,
} from "../../../packages/core/src/execution/sandbox-helper-backend.js";

/** 可编排的辅助程序替身：只模拟**输出协议**，不模拟隔离。 */
function buildFakeHelper(script: {
  readonly probeOutput?: string;
  readonly exitCode?: number;
  readonly runOutput?: string;
  /** 一直不退出，直到被 `terminate()`（用于验证取消）。 */
  readonly isHanging?: boolean;
}): {
  spawnHelper: (input: {
    command: string;
    arguments: readonly string[];
  }) => SandboxHelperProcess;
  readonly invocations: string[][];
} {
  const invocations: string[][] = [];
  return {
    invocations,
    spawnHelper: (input) => {
      invocations.push([...input.arguments]);
      const isProbe = input.arguments.includes("probe");
      const outputText = isProbe ? (script.probeOutput ?? "") : (script.runOutput ?? "");
      const exitCode = isProbe ? 0 : (script.exitCode ?? 0);
      /** 挂起模式：退出只能由 terminate 触发，否则取消测不出真实行为。 */
      let resolveHangingExit: ((code: number | null) => void) | null = null;
      const exitedPromise = script.isHanging === true && !isProbe
        ? new Promise<number | null>((resolve) => {
            resolveHangingExit = resolve;
          })
        : Promise.resolve(exitCode);
      return {
        processIdentifier: 4242,
        standardOutput: (async function* () {
          if (outputText.length > 0) yield outputText;
        })(),
        standardError: (async function* () {
          // 无 stderr
        })(),
        exited: exitedPromise,
        terminate: () => {
          resolveHangingExit?.(143);
        },
      };
    },
  };
}

const FULL_SUCCESS_PROBE = [
  "derive-nonexistent hresult=0x00000000 lastError=0 sid-null=false",
  "appcontainer-created sid-present=true",
  "appcontainer-deleted hresult=0x00000000",
  "job-created",
].join("\n");

describe("EXEC-01-02 沙箱辅助程序后端", () => {
  it("探测完整成功 ⇒ 判定可用", () => {
    const capability = interpretProbeOutput(FULL_SUCCESS_PROBE);
    expect(capability.isAvailable).toBe(true);
    expect(capability.reasonUnavailable).toBeNull();
  });

  it("探测缺成功标记 ⇒ 判定**不可用**（不得据「看起来像」放行）", () => {
    const capability = interpretProbeOutput("job-created\n");
    expect(capability.isAvailable).toBe(false);
    expect(capability.reasonUnavailable).toContain("完整");
  });

  it("AppContainer 不可建 ⇒ 不可用，且原因如实带出", () => {
    const capability = interpretProbeOutput(
      "appcontainer-unavailable CreateAppContainerProfile 失败: HRESULT=0x80070005\njob-created\n",
    );
    expect(capability.isAvailable).toBe(false);
    expect(capability.reasonUnavailable).toContain("0x80070005");
  });

  it("能力不可用 ⇒ start 拒绝执行（不降级到宿主执行）", async () => {
    const fake = buildFakeHelper({
      probeOutput: "appcontainer-unavailable CreateAppContainerProfile 失败: HRESULT=0x80070005\n",
    });
    const backend = new SandboxHelperBackend({
      helperExecutablePath: "sandbox-helper",
      spawnHelper: fake.spawnHelper,
    });
    await expect(
      backend.start({
        identity: { executionId: "exec-1" },
        executableEntryPoint: "node",
        arguments: ["-e", "1"],
        workingDirectory: "docs",
        timeoutMilliseconds: 1_000,
        streamStorageLimitBytes: 1_024,
      }),
    ).rejects.toThrow(/execution-backend-unsupported|不可用/u);
    /** 只发生了一次 probe，没有真的去 `run`（拒绝发生在启动之前）。 */
    expect(fake.invocations).toHaveLength(1);
    expect(fake.invocations[0]).toContain("probe");
  });

  it("能力可用 ⇒ start 走 run 协议，输出可按字节游标读取", async () => {
    const fake = buildFakeHelper({
      probeOutput: FULL_SUCCESS_PROBE,
      runOutput: "编译完成\n",
      exitCode: 0,
    });
    const backend = new SandboxHelperBackend({
      helperExecutablePath: "sandbox-helper",
      spawnHelper: fake.spawnHelper,
    });
    const started = await backend.start({
      identity: { executionId: "exec-2" },
      executableEntryPoint: "node",
      arguments: ["-e", "console.log(1)"],
      workingDirectory: "docs",
      timeoutMilliseconds: 5_000,
      streamStorageLimitBytes: 1_024,
    });
    expect(fake.invocations.some((invocation) => invocation.includes("run"))).toBe(true);
    /** 等待输出收集与退出码落定（后端在后台收集）。 */
    await new Promise((resolve) => setTimeout(resolve, 50));
    const chunk = await backend.readOutputStream({
      backendExecutionHandle: started.backendExecutionHandle,
      stream: "stdout",
      fromCursorBytes: 0,
      maximumBytes: 1_024,
    });
    expect(chunk.text).toContain("编译完成");
    const status = await backend.readStatus(started.backendExecutionHandle);
    expect(status.status).toBe("succeeded");
  }, 30_000);

  it("取消 ⇒ 终止辅助程序并如实回报 cancelled", async () => {
    const fake = buildFakeHelper({
      probeOutput: FULL_SUCCESS_PROBE,
      runOutput: "",
      exitCode: 0,
      isHanging: true,
    });
    const backend = new SandboxHelperBackend({
      helperExecutablePath: "sandbox-helper",
      spawnHelper: fake.spawnHelper,
    });
    const started = await backend.start({
      identity: { executionId: "exec-3" },
      executableEntryPoint: "node",
      arguments: [],
      workingDirectory: "docs",
      timeoutMilliseconds: 5_000,
      streamStorageLimitBytes: 1_024,
    });
    const cancelled = await backend.cancel(started.backendExecutionHandle, "用户取消");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.failureReason).toBe("用户取消");
  }, 30_000);
});
