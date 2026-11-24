/**
 * RESUME-02 补口（2026-11-25）：恢复包"真实内容读取 + 注入前扫描"的反例。
 */
import { describe, expect, it } from "vitest";

import {
  assembleContinuationPackFromDisk,
  type ContinuationDiskNode,
  type ContinuationDiskScanFinding,
} from "../../../packages/core/src/orchestration/continuation-context-pack.js";

const baseRequest = {
  targetTaskIdentifier: "task-a",
  expectedRevision: 3,
  modelWindowTokens: 8_192,
  systemAndToolTokens: 1_000,
  outputReserveTokens: 1_000,
  safetyMarginTokens: 500,
} as const;

function node(overrides: Partial<ContinuationDiskNode> = {}): ContinuationDiskNode {
  return {
    taskIdentifier: "task-a",
    revision: 3,
    contentHash: "sha256:abc",
    filePath: "C:\\state\\task-a.txt",
    isClosedOrIrrelevant: false,
    isCurrentPrerequisite: true,
    securityConstraints: ["不得外发"],
    ...overrides,
  };
}

function cleanScan(): Promise<readonly ContinuationDiskScanFinding[]> {
  return Promise.resolve([]);
}

describe("RESUME-02 恢复包：磁盘读取与注入前扫描", () => {
  it("① 内容来自磁盘并进入恢复包（excerpt 非调用方自报）", async () => {
    const result = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [node()],
      readFile: async () => "磁盘上的真实正文",
      scan: cleanScan,
    });
    expect(result.kind).toBe("assembled");
    if (result.kind !== "assembled") return;
    expect(result.pack.entries).toHaveLength(1);
    expect(result.pack.entries[0]?.excerpt).toBe("磁盘上的真实正文");
    expect(result.pack.isTokenEstimate).toBe(true);
    expect(result.withheldTaskIdentifiers).toEqual([]);
  });

  it("② 扫描命中 ⇒ 节点被扣留、不回填，且记入 withheld", async () => {
    const result = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [
        node({ taskIdentifier: "secret-task", filePath: "C:\\state\\secret-task.txt" }),
        node({ taskIdentifier: "ok-task", filePath: "C:\\state\\ok-task.txt" }),
      ],
      readFile: async (filePath) =>
        filePath.includes("secret") ? "token=abcdef" : "clean content",
      scan: async (content) =>
        content.includes("token=") ? [{ ruleIdentifier: "credential-pattern" }] : [],
    });
    expect(result.kind).toBe("assembled");
    if (result.kind !== "assembled") return;
    expect(result.withheldTaskIdentifiers).toEqual(["secret-task"]);
    expect(result.pack.entries.map((entry) => entry.taskIdentifier)).toEqual(["ok-task"]);
    /** 扣留节点不进入 packNodes，故不在 leftOnDisk 里——它由 withheld 单独如实列出。 */
    expect(result.pack.entries).toHaveLength(1);
  });

  it("③ 扫描失败 ⇒ blocked/scan-failed（不把失败当干净）", async () => {
    const result = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [node()],
      readFile: async () => "正文",
      scan: async () => {
        throw new Error("scanner offline");
      },
    });
    expect(result).toMatchObject({ kind: "blocked", reasonCode: "scan-failed" });
  });

  it("④ 所有节点都被扣留 ⇒ blocked/sensitive-content-withheld（不拼空包）", async () => {
    const result = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [node({ taskIdentifier: "a" }), node({ taskIdentifier: "b" })],
      readFile: async () => "secret",
      scan: async () => [{ ruleIdentifier: "x" }],
    });
    expect(result).toMatchObject({
      kind: "blocked",
      reasonCode: "sensitive-content-withheld",
      withheldTaskIdentifiers: ["a", "b"],
    });
  });

  it("⑤ 读取失败 ⇒ 记入 unreadable；全部读不到 ⇒ no-readable-nodes", async () => {
    const partial = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [
        node({ taskIdentifier: "gone", filePath: "C:\\state\\gone.txt" }),
        node({ taskIdentifier: "ok", filePath: "C:\\state\\ok.txt" }),
      ],
      readFile: async (filePath) => {
        if (filePath.includes("gone")) throw new Error("ENOENT");
        return "ok content";
      },
      scan: cleanScan,
    });
    expect(partial.kind).toBe("assembled");
    if (partial.kind !== "assembled") return;
    expect(partial.unreadableTaskIdentifiers).toEqual(["gone"]);

    const none = await assembleContinuationPackFromDisk({
      request: baseRequest,
      nodes: [node()],
      readFile: async () => {
        throw new Error("ENOENT");
      },
      scan: cleanScan,
    });
    expect(none).toMatchObject({ kind: "blocked", reasonCode: "no-readable-nodes" });
  });

  it("⑥ 预算不足 ⇒ 透传 blocked（能读磁盘也不能绕过预算）", async () => {
    const result = await assembleContinuationPackFromDisk({
      request: { ...baseRequest, modelWindowTokens: 1_200 },
      nodes: [node()],
      readFile: async () => "x".repeat(10_000),
      scan: cleanScan,
    });
    expect(result).toMatchObject({ kind: "blocked", reasonCode: "budget-non-positive" });
  });
});
