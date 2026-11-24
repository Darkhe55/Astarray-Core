/**
 * E3-6（2026-11-25）：broker `serve` 的执行路径（显式开关；本机非管理员）。
 *
 * 语义：
 * - 默认 `serve` **不执行**（`rejected/execution-disabled`）；
 * - `--allow-weak-execution`：经 `run --low-integrity` 执行（写受限、读不设防，如实标注）；
 * - 请求去重：同一 requestIdentifier 第二次 ⇒ `duplicate-request`；
 * - 非绝对/不存在的可执行文件、非目录工作目录 ⇒ 拒绝；
 * - 超时由 `run` 的 Job 真正终止，结果 `timedOut=true`。
 *
 * 不在此声称强档（AppContainer）执行：那需要管理员会话，见 E3-7。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const helperPath = path.join(process.cwd(), "native", "sandbox-helper", "sandbox-helper.exe");
const isAcceptanceHost = process.platform === "win32" && existsSync(helperPath);
const commandPath = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\cmd.exe`
  : "C:\\Windows\\System32\\cmd.exe";

let workingDirectory: string;

beforeAll(async () => {
  workingDirectory = await fs.mkdtemp(
    path.join(process.env.TEMP ?? os.tmpdir(), "astarray-broker-exec-"),
  );
});

afterAll(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let activeChild: ChildProcess | null = null;

afterAll(() => {
  activeChild?.kill();
});

interface ServeHarness {
  readonly child: ChildProcess;
  readonly pipeName: string;
}

function startServe(extraArguments: readonly string[]): Promise<ServeHarness> {
  const pipeName = `\\\\.\\pipe\\astarray-broker-exec-test-${String(process.pid)}-${String(Date.now())}`;
  const child = spawn(helperPath, ["serve", "--pipe-name", pipeName, ...extraArguments], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChild = child;
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`broker 未就绪：${output}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("broker-ready")) {
        clearTimeout(timer);
        resolve({ child, pipeName });
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectWithRetry(pipeName: string, timeoutMilliseconds = 10_000): Promise<net.Socket> {
  const deadline = Date.now() + timeoutMilliseconds;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect(pipeName);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (error) => {
        socket.destroy();
        if (Date.now() > deadline) reject(error);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function readFrameLine(socket: net.Socket, timeoutMilliseconds = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("读取响应超时")), timeoutMilliseconds);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buffer.slice(0, newlineIndex));
      }
    };
    socket.on("data", onData);
  });
}

async function executeRequest(
  pipeName: string,
  requestIdentifier: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const socket = await connectWithRetry(pipeName);
  try {
    const frame = {
      schemaVersion: 1,
      requestIdentifier,
      payload: {
        type: "execute",
        executablePath: commandPath,
        arguments: ["/c", "echo broker-exec-ok"],
        workingDirectory,
        timeoutMilliseconds: 10_000,
        maximumMemoryBytes: 64 * 1024 * 1024,
        maximumProcessCount: 4,
        ...overrides,
      },
    };
    socket.write(JSON.stringify(frame) + "\n");
    return JSON.parse(await readFrameLine(socket)) as Record<string, unknown>;
  } finally {
    socket.end();
  }
}

describe.skipIf(!isAcceptanceHost)("E3-6 broker 执行路径", () => {
  it("① 默认不执行 ⇒ rejected/execution-disabled", async () => {
    const harness = await startServe([]);
    const response = await executeRequest(harness.pipeName, "disabled-1");
    expect(response).toMatchObject({
      requestIdentifier: "disabled-1",
      payload: { outcome: "rejected", reasonCode: "execution-disabled" },
    });
  });

  it("② 显式允许弱档 ⇒ 真实执行并回传 stdout/退出码", async () => {
    const harness = await startServe(["--allow-weak-execution"]);
    const response = await executeRequest(harness.pipeName, "exec-1");
    const payload = response["payload"] as Record<string, unknown>;
    expect(payload["outcome"]).toBe("executed");
    expect(payload["exitCode"]).toBe(0);
    expect(String(payload["stdout"])).toContain("broker-exec-ok");
  });

  it("③ 重复请求标识 ⇒ duplicate-request，不重复执行", async () => {
    const harness = await startServe(["--allow-weak-execution"]);
    await executeRequest(harness.pipeName, "dup-1");
    const second = await executeRequest(harness.pipeName, "dup-1");
    expect(second).toMatchObject({
      payload: { outcome: "rejected", reasonCode: "duplicate-request" },
    });
  });

  it("④ 非绝对/不存在的可执行文件 ⇒ executable-not-allowed", async () => {
    const harness = await startServe(["--allow-weak-execution"]);
    const response = await executeRequest(harness.pipeName, "bad-exe", {
      executablePath: "cmd.exe",
    });
    expect(response).toMatchObject({
      payload: { outcome: "rejected", reasonCode: "executable-not-allowed" },
    });
    const missing = await executeRequest(harness.pipeName, "missing-exe", {
      executablePath: "C:\\definitely-missing\\nope.exe",
    });
    expect(missing).toMatchObject({
      payload: { outcome: "rejected", reasonCode: "executable-not-allowed" },
    });
  });

  it("⑤ 超时 ⇒ executed/timedOut=true（由 Job 真实终止）", async () => {
    const harness = await startServe(["--allow-weak-execution"]);
    const startedAt = Date.now();
    const response = await executeRequest(harness.pipeName, "timeout-1", {
      arguments: ["/c", "ping", "-n", "5", "127.0.0.1"],
      timeoutMilliseconds: 800,
    });
    const payload = response["payload"] as Record<string, unknown>;
    expect(payload["outcome"]).toBe("executed");
    expect(payload["timedOut"]).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  });

  it("⑦ 强档在非管理员会话 ⇒ rejected/strong-tier-unavailable（不回退弱档）", async () => {
    const harness = await startServe(["--allow-strong-execution"]);
    const response = await executeRequest(harness.pipeName, "strong-1");
    const payload = response["payload"] as Record<string, unknown>;
    /**
     * 管理员机器上应成功；非管理员机器上必须**如实拒绝**。
     * 两种都不允许"executed 但退出码非 0"这种把建进程失败伪装成执行结果的行为。
     */
    if (payload["outcome"] === "executed") {
      expect(payload["exitCode"]).toBe(0);
    } else {
      expect(payload).toMatchObject({ outcome: "rejected", reasonCode: "strong-tier-unavailable" });
      expect(String(payload["detail"] ?? "")).toContain("CreateProcessW");
    }
  });
  it("⑥ 弱档真实写限制：写用户主目录 ⇒ 退出码非 0", async () => {
    const harness = await startServe(["--allow-weak-execution"]);
    const response = await executeRequest(harness.pipeName, "write-denied", {
      arguments: ["/c", "echo x > %USERPROFILE%\\astarray-broker-write.txt"],
    });
    const payload = response["payload"] as Record<string, unknown>;
    expect(payload["outcome"]).toBe("executed");
    expect(payload["exitCode"]).not.toBe(0);
  });
});
