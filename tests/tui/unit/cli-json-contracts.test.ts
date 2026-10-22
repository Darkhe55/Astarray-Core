/**
 * CLI `--json` 契约测试（2026-10-23）。
 *
 * 目的：锁住**输出结构**与**退出码**，防止以后静默改字段名（验收脚本依赖这些字段）。
 *
 * 实测结构（空状态）：
 * - `usage overview`：`coverage / metrics / usageSource / costEstimate / budget / page`；
 * - `obs diag`：`kind / coverage{discardedLineCount} / findings / isReportable / page / notice`；
 * - `obs perf`：`kind / coverage{discardedLineCount} / metrics{sampleSize} / page / alerts / hasSamples`；
 * - `accuracy status`：`status:"ok" / policy{tier,isEnabled,budget,revision}`。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeAccuracyStatusCommand,
  executeUsageOverviewCommand,
} from "../../../packages/tui/src/cli/commands.js";
import {
  executeObsDiagCommand,
  executeObsPerfCommand,
} from "../../../packages/tui/src/cli/observability-command.js";

const temporaryDirectories: string[] = [];

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "astarray-cli-json-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function captureJson(
  execute: () => Promise<number>,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stdout.write);
  try {
    const status = await execute();
    const text = chunks.join("").trim();
    return { status, payload: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  } finally {
    spy.mockRestore();
  }
}

describe("CLI --json 输出契约", () => {
  it("① usage overview：空账目 → 字段齐全，金额恒未估算", async () => {
    const stateDirectory = await createStateDirectory();
    const { status, payload } = await captureJson(() =>
      executeUsageOverviewCommand({
        stateDirectory,
        detailLevel: "summary",
        isJsonOutput: true,
      } as never),
    );
    expect(status).toBe(0);
    for (const key of ["coverage", "metrics", "usageSource", "costEstimate", "budget", "page"]) {
      expect(payload).toHaveProperty(key);
    }
    const costEstimate = payload.costEstimate as Record<string, unknown> | null;
    expect(costEstimate === null || costEstimate.amountMinorUnits === null).toBe(true);
  });

  it("② obs diag：空库 → isReportable:false 且 coverage 里坏行计数为 0", async () => {
    const stateDirectory = await createStateDirectory();
    const { status, payload } = await captureJson(() =>
      executeObsDiagCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(status).toBe(0);
    expect(payload.kind).toBe("ok");
    expect(payload.isReportable).toBe(false);
    const coverage = payload.coverage as Record<string, unknown>;
    expect(coverage.discardedLineCount).toBe(0);
  });

  it("③ obs perf：空库 → metrics.sampleSize 为 0（不报零均值）", async () => {
    const stateDirectory = await createStateDirectory();
    const { status, payload } = await captureJson(() =>
      executeObsPerfCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(status).toBe(0);
    expect(payload.kind).toBe("ok");
    const metrics = payload.metrics as Record<string, unknown>;
    expect(metrics.sampleSize).toBe(0);
    expect(payload.hasSamples).toBe(false);
  });

  it("④ accuracy status：status 为 ok，policy 含档位/预算/revision", async () => {
    const stateDirectory = await createStateDirectory();
    const { status, payload } = await captureJson(() =>
      executeAccuracyStatusCommand({ stateDirectory, isJsonOutput: true }),
    );
    expect(status).toBe(0);
    expect(payload.status).toBe("ok");
    const policy = payload.policy as Record<string, unknown>;
    for (const key of ["tier", "isEnabled", "budget", "revision"]) {
      expect(policy).toHaveProperty(key);
    }
  });

  it("⑤ 非法参数 ⇒ 非 0（fail-closed），且不输出 JSON", async () => {
    const stateDirectory = await createStateDirectory();
    const { status, payload } = await captureJson(() =>
      executeUsageOverviewCommand({
        stateDirectory,
        detailLevel: "verbose",
        isJsonOutput: true,
      } as never),
    );
    expect(status).not.toBe(0);
    expect(payload).toEqual({});
  });
});
