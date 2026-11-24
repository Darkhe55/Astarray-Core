/**
 * E3-5（2026-11-25）：helper `serve` 命名管道骨架的真实验收（Windows）。
 *
 * 验证范围（只证明传输与身份，不证明强档隔离）：
 * - 管道可连、ping → pong、请求标识回显；
 * - 未知请求 ⇒ rejected/unknown-request；
 * - 超大帧 ⇒ rejected/frame-too-large；
 * - 一个连接结束后仍可接受下一个连接（循环服务）。
 *
 * 不在此声称：模拟调用方令牌、AppContainer 建进程（需管理员会话，E3-6）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const helperPath = path.join(process.cwd(), "native", "sandbox-helper", "sandbox-helper.exe");
const isAcceptanceHost = process.platform === "win32" && existsSync(helperPath);

interface ServeHarness {
  readonly child: ChildProcess;
  readonly pipeName: string;
}

let activeChild: ChildProcess | null = null;

afterAll(() => {
  activeChild?.kill();
});

function startServe(): Promise<ServeHarness> {
  const pipeName = `\\\\.\\pipe\\astarray-broker-test-${String(process.pid)}-${String(Date.now())}`;
  const child = spawn(helperPath, ["serve", "--pipe-name", pipeName], {
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
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`broker 提前退出（${String(code)}）：${output}`));
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

function readFrameLine(socket: net.Socket, timeoutMilliseconds = 5_000): Promise<string> {
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

async function roundTrip(pipeName: string, frame: string): Promise<Record<string, unknown>> {
  const socket = await connectWithRetry(pipeName);
  try {
    socket.write(frame + "\n");
    return JSON.parse(await readFrameLine(socket)) as Record<string, unknown>;
  } finally {
    socket.end();
  }
}

describe.skipIf(!isAcceptanceHost)("E3-5 broker serve 骨架", () => {
  it("① ping → pong，请求标识回显", async () => {
    const harness = await startServe();
    const response = await roundTrip(
      harness.pipeName,
      JSON.stringify({ schemaVersion: 1, requestIdentifier: "ping-1", payload: { type: "ping" } }),
    );
    expect(response).toMatchObject({
      schemaVersion: 1,
      requestIdentifier: "ping-1",
      payload: { outcome: "pong" },
    });
  });

  it("② 未知请求 ⇒ rejected/unknown-request（不执行任何东西）", async () => {
    const harness = await startServe();
    const response = await roundTrip(
      harness.pipeName,
      JSON.stringify({ schemaVersion: 1, requestIdentifier: "exec-1", payload: { type: "execute" } }),
    );
    expect(response).toMatchObject({
      requestIdentifier: "exec-1",
      payload: { outcome: "rejected", reasonCode: "unknown-request" },
    });
  });

  it("③ 超大帧 ⇒ rejected/frame-too-large", async () => {
    const harness = await startServe();
    const oversized = "x".repeat(70 * 1024);
    const response = await roundTrip(
      harness.pipeName,
      JSON.stringify({
        schemaVersion: 1,
        requestIdentifier: "big-1",
        payload: { type: "ping", padding: oversized },
      }),
    );
    expect(response).toMatchObject({
      requestIdentifier: "unknown",
      payload: { outcome: "rejected", reasonCode: "frame-too-large" },
    });
  });

  it("④ 一个连接结束后仍可继续服务下一个连接", async () => {
    const harness = await startServe();
    const first = await roundTrip(
      harness.pipeName,
      JSON.stringify({ schemaVersion: 1, requestIdentifier: "a", payload: { type: "ping" } }),
    );
    const second = await roundTrip(
      harness.pipeName,
      JSON.stringify({ schemaVersion: 1, requestIdentifier: "b", payload: { type: "ping" } }),
    );
    expect(first).toMatchObject({ requestIdentifier: "a", payload: { outcome: "pong" } });
    expect(second).toMatchObject({ requestIdentifier: "b", payload: { outcome: "pong" } });
  });
});
