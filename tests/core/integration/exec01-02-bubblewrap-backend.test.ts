/**
 * EXEC-01-02（2026-11-09）：**Linux 隔离后端（bubblewrap）**。
 *
 * 参数构造与探测判定在此验证；真实的隔离效果由 WSL 实测记录证明
 * （`docs/reports/EXEC01_02_B1_REVISED_2026-11-09.md` §2），本文件不声称隔离。
 */
import { describe, expect, it, vi } from "vitest";

import {
  BubblewrapSandboxBackend,
  buildBubblewrapArguments,
} from "../../../packages/core/src/execution/bubblewrap-sandbox-backend.js";
import type { SandboxHelperProcess } from "../../../packages/core/src/execution/sandbox-helper-backend.js";

vi.setConfig({ testTimeout: 30_000 });

function buildFakeProcess(input: {
  readonly exitCode: number;
  readonly output?: string;
}): SandboxHelperProcess {
  return {
    processIdentifier: 1234,
    standardOutput: (async function* () {
      if (input.output !== undefined) yield input.output;
    })(),
    standardError: (async function* () {
      // 无
    })(),
    exited: Promise.resolve(input.exitCode),
    terminate: () => undefined,
  };
}

describe("EXEC-01-02 bubblewrap 参数构造", () => {
  it("断开命名空间并只 bind 必需目录（未 bind 的宿主目录不可见）", () => {
    const bwrapArguments = buildBubblewrapArguments({
      workingDirectory: "/work",
      executableEntryPoint: "node",
      arguments: ["-e", "1"],
    });
    expect(bwrapArguments).toContain("--unshare-all");
    expect(bwrapArguments).toContain("--die-with-parent");
    /** 只读 bind 运行时目录，且工作目录也是只读 bind（写入需另配，避免静默可写）。 */
    expect(bwrapArguments.join(" ")).toContain("--ro-bind /usr /usr");
    expect(bwrapArguments.join(" ")).toContain("--ro-bind /work /work");
    /** 不得出现"整个宿主根可写"这类放宽。 */
    expect(bwrapArguments.join(" ")).not.toContain("--bind / /");
    /** 工作目录与命令在 `--` 之后，避免被 bwrap 当成自己的参数。 */
    const separatorIndex = bwrapArguments.indexOf("--");
    expect(separatorIndex).toBeGreaterThan(0);
    expect(bwrapArguments[separatorIndex + 1]).toBe("node");
  });

  it("自定义 bind 列表生效（不写死 /usr 等）", () => {
    const bwrapArguments = buildBubblewrapArguments({
      workingDirectory: "/data/work",
      executableEntryPoint: "/opt/bin/run",
      arguments: [],
      readOnlyBindPaths: ["/opt"],
    });
    const joined = bwrapArguments.join(" ");
    expect(joined).toContain("--ro-bind /opt /opt");
    expect(joined).not.toContain("--ro-bind /usr /usr");
  });
});

describe("EXEC-01-02 bubblewrap 探测与拒绝", () => {
  it("探测成功 ⇒ 判定可用", async () => {
    const backend = new BubblewrapSandboxBackend({
      spawnProcess: () => buildFakeProcess({ exitCode: 0 }),
    });
    const capability = await backend.probeCapability();
    expect(capability.isAvailable).toBe(true);
    expect(capability.backendIdentifier).toBe("bubblewrap");
  });

  it("探测失败 ⇒ 判定不可用，且**不**据版本号放行", async () => {
    const backend = new BubblewrapSandboxBackend({
      spawnProcess: () => buildFakeProcess({ exitCode: 1, output: "bwrap: No permissions" }),
    });
    const capability = await backend.probeCapability();
    expect(capability.isAvailable).toBe(false);
    expect(capability.reasonUnavailable).toContain("No permissions");
  });

  it("不可用 ⇒ start 拒绝执行（不降级到宿主执行）", async () => {
    const backend = new BubblewrapSandboxBackend({
      spawnProcess: () => buildFakeProcess({ exitCode: 1, output: "no user namespaces" }),
    });
    await expect(
      backend.start({
        identity: { executionId: "exec-1" },
        executableEntryPoint: "node",
        arguments: [],
        workingDirectory: "/work",
        timeoutMilliseconds: 1_000,
        streamStorageLimitBytes: 1_024,
      }),
    ).rejects.toThrow(/不可用/u);
  });

  it("可用 ⇒ 正常启动并按退出码落状态", async () => {
    let callCount = 0;
    const backend = new BubblewrapSandboxBackend({
      spawnProcess: () => {
        callCount += 1;
        return callCount === 1
          ? buildFakeProcess({ exitCode: 0 })
          : buildFakeProcess({ exitCode: 0, output: "hello\n" });
      },
    });
    const started = await backend.start({
      identity: { executionId: "exec-2" },
      executableEntryPoint: "node",
      arguments: ["-e", "1"],
      workingDirectory: "/work",
      timeoutMilliseconds: 5_000,
      streamStorageLimitBytes: 1_024,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = await backend.readStatus(started.backendExecutionHandle);
    expect(status.status).toBe("succeeded");
    const chunk = await backend.readOutputStream({
      backendExecutionHandle: started.backendExecutionHandle,
      stream: "stdout",
      fromCursorBytes: 0,
      maximumBytes: 1_024,
    });
    expect(chunk.text).toContain("hello");
  });
});
