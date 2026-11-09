/**
 * EXEC-01-03（2026-11-09）：持久化与**重启对账**的反例优先验证。
 *
 * 核心纪律：重启后**绝不自动重跑**；不确定就保持 unknown 并毒化幂等键。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessExecutionRecord } from "../../../packages/core/src/execution/process-execution-controller.js";
import {
  FileSystemProcessExecutionStore,
  isTerminalProcessExecutionStatus,
  reconcileProcessExecutionsAfterRestart,
} from "../../../packages/core/src/execution/process-execution-store.js";

let stateDirectory: string;

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-exec-store-"));
});

afterEach(async () => {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 6 });
});

function buildRecord(
  overrides: Partial<ProcessExecutionRecord> & {
    executionId?: string;
    status?: ProcessExecutionRecord["status"];
    idempotencyKey?: string;
    backendExecutionHandle?: string | null;
  } = {},
): ProcessExecutionRecord {
  const executionId = overrides.executionId ?? "exec-aaa";
  const base: ProcessExecutionRecord = {
    identity: {
      executionId,
      environmentIdentifier: "node-offline-22",
      environmentFingerprint: "sha256:" + "a".repeat(64),
      requestFingerprint: "sha256:" + "b".repeat(64),
      projectIdentifier: "project-a",
      agentInstanceIdentifier: "tertiary-agent-1",
      missionIdentifier: "mission-1",
      taskIdentifier: "task-1",
      attemptNumber: 1,
      authorizationRevision: 1,
    },
    request: {
      environmentIdentifier: "node-offline-22",
      executableIdentifier: "run-test",
      arguments: ["--test"],
      workingDirectory: "src",
      timeoutMilliseconds: 1000,
      ...(overrides.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: overrides.idempotencyKey }),
    },
    executableEntryPoint: "/sandbox/bin/node",
    status: overrides.status ?? "running",
    backendExecutionHandle:
      overrides.backendExecutionHandle === undefined
        ? `handle-${executionId}`
        : overrides.backendExecutionHandle,
    exitCode: null,
    failureReason: null,
    queuedAtIso: "2026-11-09T00:00:00.000Z",
    startedAtIso: "2026-11-09T00:00:01.000Z",
    finishedAtIso: null,
    stdoutCursorBytes: 0,
    stderrCursorBytes: 0,
  };
  return { ...base, ...overrides, identity: base.identity, request: base.request };
}

describe("EXEC-01-03 持久化存储", () => {
  it("写入后可读回（跨实例，证明真的落盘）", async () => {
    const writer = new FileSystemProcessExecutionStore({ stateDirectory });
    await writer.write(buildRecord({ status: "running" }));
    const reader = new FileSystemProcessExecutionStore({ stateDirectory });
    const record = await reader.read("exec-aaa");
    expect(record?.status).toBe("running");
    expect(record?.identity.agentInstanceIdentifier).toBe("tertiary-agent-1");
  });

  it("幂等索引跨实例生效（重启后同键仍能找回原执行）", async () => {
    const writer = new FileSystemProcessExecutionStore({ stateDirectory });
    await writer.write(buildRecord({ status: "succeeded", idempotencyKey: "key-1" }));
    const reader = new FileSystemProcessExecutionStore({ stateDirectory });
    const found = await reader.readByIdempotencyKey({
      agentInstanceIdentifier: "tertiary-agent-1",
      idempotencyKey: "key-1",
    });
    expect(found?.identity.executionId).toBe("exec-aaa");
    /** 不同主体的同名字键不得互相命中。 */
    const other = await reader.readByIdempotencyKey({
      agentInstanceIdentifier: "tertiary-agent-2",
      idempotencyKey: "key-1",
    });
    expect(other).toBeNull();
  });

  it("毒化幂等键跨实例保留", async () => {
    const writer = new FileSystemProcessExecutionStore({ stateDirectory });
    await writer.poisonIdempotencyKey({
      agentInstanceIdentifier: "tertiary-agent-1",
      idempotencyKey: "key-poison",
      reason: "测试",
    });
    const reader = new FileSystemProcessExecutionStore({ stateDirectory });
    expect(
      await reader.isIdempotencyKeyPoisoned({
        agentInstanceIdentifier: "tertiary-agent-1",
        idempotencyKey: "key-poison",
      }),
    ).toBe(true);
    expect(
      await reader.isIdempotencyKeyPoisoned({
        agentInstanceIdentifier: "tertiary-agent-1",
        idempotencyKey: "key-clean",
      }),
    ).toBe(false);
  });

  it("损坏的执行记录 ⇒ journal-corrupted（不按猜测恢复）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord());
    const recordPath = path.join(
      stateDirectory,
      "process-executions",
      "exec-aaa.json",
    );
    await fs.writeFile(recordPath, "{not-json", "utf8");
    await expect(store.read("exec-aaa")).rejects.toThrowError(
      expect.objectContaining({ errorCode: "journal-corrupted" }),
    );
  });

  it("执行标识含非法字符 ⇒ 拒绝（防路径注入）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await expect(store.read("../../etc/passwd")).rejects.toThrowError(
      expect.objectContaining({ errorCode: "execution-request-invalid" }),
    );
  });

  it("listAll 跳过索引文件、只列执行记录", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ executionId: "exec-1", idempotencyKey: "k1" }));
    await store.write(buildRecord({ executionId: "exec-2" }));
    const all = await store.listAll();
    expect(all.map((record) => record.identity.executionId).sort()).toEqual([
      "exec-1",
      "exec-2",
    ]);
  });

  it("终态判定覆盖全部终止状态", () => {
    expect(isTerminalProcessExecutionStatus("succeeded")).toBe(true);
    expect(isTerminalProcessExecutionStatus("failed")).toBe(true);
    expect(isTerminalProcessExecutionStatus("cancelled")).toBe(true);
    expect(isTerminalProcessExecutionStatus("timed-out")).toBe(true);
    expect(isTerminalProcessExecutionStatus("rejected")).toBe(true);
    expect(isTerminalProcessExecutionStatus("running")).toBe(false);
    expect(isTerminalProcessExecutionStatus("queued")).toBe(false);
    expect(isTerminalProcessExecutionStatus("unknown")).toBe(false);
  });
});

describe("EXEC-01-03 重启对账", () => {
  it("隔离单元报终态 ⇒ 采纳状态与退出码（不重跑）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ status: "running" }));
    const entries = await reconcileProcessExecutionsAfterRestart({
      store,
      readBackendSnapshot: async () => ({
        status: "succeeded",
        exitCode: 0,
        failureReason: null,
      }),
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.nextStatus).toBe("succeeded");
    const record = await store.read("exec-aaa");
    expect(record?.status).toBe("succeeded");
    expect(record?.exitCode).toBe(0);
  });

  it("隔离单元查不到 ⇒ 保持 unknown 并毒化幂等键（禁止复用启动新副作用）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ status: "running", idempotencyKey: "key-x" }));
    const entries = await reconcileProcessExecutionsAfterRestart({
      store,
      readBackendSnapshot: async () => null,
    });
    expect(entries[0]?.nextStatus).toBe("unknown");
    const record = await store.read("exec-aaa");
    expect(record?.status).toBe("unknown");
    expect(record?.failureReason).toContain("禁止自动重跑");
    expect(
      await store.isIdempotencyKeyPoisoned({
        agentInstanceIdentifier: "tertiary-agent-1",
        idempotencyKey: "key-x",
      }),
    ).toBe(true);
  });

  it("查询抛错也不猜：同样落 unknown", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ status: "queued" }));
    const entries = await reconcileProcessExecutionsAfterRestart({
      store,
      readBackendSnapshot: async () => {
        throw new Error("引擎断连");
      },
    });
    expect(entries[0]?.nextStatus).toBe("unknown");
    expect((await store.read("exec-aaa"))?.status).toBe("unknown");
  });

  it("终态执行不被对账改动（已完成的不得被重写）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ status: "succeeded" }));
    const entries = await reconcileProcessExecutionsAfterRestart({
      store,
      readBackendSnapshot: async () => {
        throw new Error("不应该被调用");
      },
    });
    expect(entries).toEqual([]);
    expect((await store.read("exec-aaa"))?.status).toBe("succeeded");
  });

  it("没有后端句柄的执行 ⇒ unknown（不假定它没跑过）", async () => {
    const store = new FileSystemProcessExecutionStore({ stateDirectory });
    await store.write(buildRecord({ status: "queued", backendExecutionHandle: null }));
    const entries = await reconcileProcessExecutionsAfterRestart({
      store,
      readBackendSnapshot: async () => {
        throw new Error("不应该被调用");
      },
    });
    expect(entries[0]?.nextStatus).toBe("unknown");
  });
});
