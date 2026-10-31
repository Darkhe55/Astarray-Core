/**
 * EVENT-01 生产事件源反例（2026-10-24，用户"按建议做"）。
 *
 * 口径：工具崩溃类=critical、连续 3 次 provider 失败=high、同键 60 秒去重、
 * 普通错误不产生事故、低严重度不阻断、落盘失败不阻塞。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EVENT_SOURCE_MERGE_WINDOW_SECONDS,
  PROVIDER_FAILURE_THRESHOLD,
  evaluateToolFailureSignal,
  isCrashLikeToolFailure,
} from "../../../packages/core/src/orchestration/event-source-policy.js";
import { EventControlChannel } from "../../../packages/core/src/orchestration/event-control-channel.js";
import { EventIncidentJournal } from "../../../packages/core/src/orchestration/event-incident-journal.js";
import { EventSourceBridge } from "../../../packages/core/src/orchestration/event-source-bridge.js";

const temporaryDirectories: string[] = [];
async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-event-source-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  /**
   * R76（2026-10-31）：Windows 上并发落盘可能仍持有目录句柄 ⇒ rm 报 EBUSY。
   * 用 maxRetries/retryDelay 让 Node 自己重试（只对 EBUSY/EPERM 等生效），不吞掉真正错误。
   */
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

function createBridge(stateDirectory: string) {
  const channel = new EventControlChannel({ maximumConcurrentIncidents: 4, responseDeadlineSeconds: 60 });
  const journal = new EventIncidentJournal({ stateDirectory });
  const bridge = new EventSourceBridge({ channel, journal });
  return { channel, journal, bridge };
}

describe("EVENT-01 事件源策略", () => {
  it("① 崩溃类错误识别；普通错误不识别", () => {
    expect(isCrashLikeToolFailure("EPIPE: broken pipe")).toBe(true);
    expect(isCrashLikeToolFailure("spawn ENOENT")).toBe(true);
    expect(isCrashLikeToolFailure("工具进程崩溃")).toBe(true);
    expect(isCrashLikeToolFailure("文件不存在")).toBe(false);
    expect(isCrashLikeToolFailure("参数校验失败")).toBe(false);
    expect(evaluateToolFailureSignal({ toolName: "readFile", failureReason: "文件不存在" })).toBeNull();
  });

  it("② 默认阈值：连续 3 次 provider 失败才发事故", () => {
    expect(PROVIDER_FAILURE_THRESHOLD).toBe(3);
    expect(EVENT_SOURCE_MERGE_WINDOW_SECONDS).toBe(60);
  });
});

describe("EVENT-01 事件源桥", () => {
  it("③ 工具崩溃 ⇒ critical 事故 + 落盘；普通失败不产生事故", async () => {
    const stateDirectory = await createStateDirectory();
    const { bridge, journal } = createBridge(stateDirectory);

    const normal = await bridge.onToolFailed({ toolName: "readFile", failureReason: "文件不存在" });
    expect(normal.signal).toBeNull();

    const crashed = await bridge.onToolFailed({
      toolName: "readFile",
      failureReason: "EPIPE: broken pipe",
      receivedAtIso: "2026-10-24T00:00:00.000Z",
      nowMilliseconds: Date.parse("2026-10-24T00:00:00.000Z"),
    });
    expect(crashed.isNewIncident).toBe(true);
    await bridge.flush();
    const persisted = await journal.read();
    expect(persisted.kind).toBe("valid");
    if (persisted.kind !== "valid") return;
    expect(persisted.record.snapshot.incidents[0]?.severity).toBe("critical");
    expect(persisted.record.snapshot.incidents[0]?.kind).toBe("tool-crash");
  });

  it("④ 同键 60 秒内去重（不重复发事件）", async () => {
    const stateDirectory = await createStateDirectory();
    const { bridge } = createBridge(stateDirectory);
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    const first = await bridge.onToolFailed({ toolName: "readFile", failureReason: "EPIPE", nowMilliseconds: now });
    const second = await bridge.onToolFailed({ toolName: "readFile", failureReason: "EPIPE", nowMilliseconds: now + 30_000 });
    const third = await bridge.onToolFailed({ toolName: "readFile", failureReason: "EPIPE", nowMilliseconds: now + 61_000 });
    expect(first.isNewIncident).toBe(true);
    // 窗口内：信号被去重 ⇒ 不发新事件（也不是新事故）。
    expect(second.wasEmitted).toBe(false);
    // 窗口外：允许再发信号，但同一资源仍是**合并**到既有未解除事故（不是新事故）。
    expect(third.wasEmitted).toBe(true);
    expect(third.isNewIncident).toBe(false);
  });

  it("⑤ 连续 3 次 provider 失败 ⇒ high 事故；成功清零", async () => {
    const stateDirectory = await createStateDirectory();
    const { bridge } = createBridge(stateDirectory);
    const now = Date.parse("2026-10-24T00:00:00.000Z");
    expect((await bridge.onProviderFailure({ resourceKey: "unisound", nowMilliseconds: now })).signal).toBeNull();
    expect((await bridge.onProviderFailure({ resourceKey: "unisound", nowMilliseconds: now + 1_000 })).signal).toBeNull();
    const third = await bridge.onProviderFailure({ resourceKey: "unisound", nowMilliseconds: now + 2_000 });
    expect(third.signal?.severity).toBe("high");

    bridge.onProviderSuccess("unisound");
    const afterSuccess = await bridge.onProviderFailure({ resourceKey: "unisound", nowMilliseconds: now + 3_000 });
    expect(afterSuccess.signal).toBeNull();
    expect(afterSuccess.consecutiveFailureCount).toBe(1);
  });

  it("⑥ 门禁：critical 事故 ⇒ 模型被拒；低严重度不阻断", async () => {
    const stateDirectory = await createStateDirectory();
    const { bridge, channel } = createBridge(stateDirectory);
    expect((await bridge.gate({ gatePoint: "model" })).kind).toBe("allow");

    channel.receiveEvent({ kind: "tool-crash", resourceKey: "tool:x", severity: "low", epoch: 1, receivedAtIso: "2026-10-24T00:00:00.000Z" });
    expect((await bridge.gate({ gatePoint: "model", nowIso: "2026-10-24T00:00:00.000Z" })).kind).toBe("allow");

    channel.receiveEvent({ kind: "process-exit", resourceKey: "runtime-1", severity: "critical", epoch: 2, receivedAtIso: "2026-10-24T00:00:00.000Z" });
    const denied = await bridge.gate({ gatePoint: "model", nowIso: "2026-10-24T00:00:00.000Z" });
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.reasonCode).toBe("event-incident-active");
  });

  it("⑦ 日志写入失败不阻塞业务（catch 后仍返回信号）", async () => {
    const stateDirectory = await createStateDirectory();
    const channel = new EventControlChannel({ maximumConcurrentIncidents: 4, responseDeadlineSeconds: 60 });
    const journal = new EventIncidentJournal({ stateDirectory });
    vi.spyOn(journal, "save").mockRejectedValue(new Error("disk full"));
    const bridge = new EventSourceBridge({ channel, journal });
    const result = await bridge.onToolFailed({ toolName: "readFile", failureReason: "SIGSEGV" });
    expect(result.signal?.kind).toBe("tool-crash");
    await expect(bridge.flush()).resolves.toBeUndefined();
  });
});

