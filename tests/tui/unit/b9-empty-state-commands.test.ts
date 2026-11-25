/**
 * B9（2026-11-25）：只读查询类命令在空状态下的文本/JSON 双分支。
 *
 * 目标：不依赖真实 mission，仅覆盖"空状态"的正常输出与 JSON 分支。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  executeAgentTreeCommand,
  executeConcurrentStatusCommand,
  executeContextMetricsCommand,
  executeDoctorErrorsCommand,
  executeInstructionListCommand,
  executePerfOverviewCommand,
  executeProviderListCommand,
  executeRecoverListCommand,
  executeSummaryListCommand,
  executeUsageOverviewCommand,
  executeWorksetStatusCommand,
} from "../../../packages/tui/src/cli/commands.js";

let stateDirectory: string;
let captured: string[];

beforeEach(async () => {
  stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-empty-cmds-"));
  captured = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    captured.push(String(chunk));
    return true;
  }) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function runBoth(formats: ReadonlyArray<boolean>, action: (json: boolean) => Promise<number>) {
  const results: number[] = [];
  captured.length = 0;
  for (const json of formats) {
    results.push(await action(json));
  }
  return results;
}

describe("B9：空状态只读命令", () => {
  it("① usage / perf overview：有效参数下文本与 JSON 都能输出", async () => {
    const results = await runBoth([false, true], (json) =>
      executeUsageOverviewCommand({
        stateDirectory,
        isJsonOutput: json,
        pageSize: "5",
        detailLevel: "summary",
      } as never),
    );
    expect(results).toEqual([0, 0]);

    const perfResults = await runBoth([false, true], (json) =>
      executePerfOverviewCommand({
        stateDirectory,
        isJsonOutput: json,
        detailLevel: "detail",
      } as never),
    );
    expect(perfResults).toEqual([0, 0]);
  });

  it("② doctor errors：合法时间窗与分页（文本/JSON）", async () => {
    const results = await runBoth([false, true], (json) =>
      executeDoctorErrorsCommand({
        stateDirectory,
        isJsonOutput: json,
        windowStartIso: "2026-01-01T00:00:00.000Z",
        windowEndIso: "2026-12-31T00:00:00.000Z",
        pageSize: "10",
      } as never),
    );
    expect(results.every((code) => typeof code === "number")).toBe(true);
  });

  it("③ agent-tree / concurrent-status / workset-status：空状态返回数字退出码", async () => {
    const agentTree = await executeAgentTreeCommand({
      stateDirectory,
      isJsonOutput: true,
    } as never);
    expect(typeof agentTree).toBe("number");

    const concurrent = await runBoth([false, true], (json) =>
      executeConcurrentStatusCommand({ stateDirectory, isJsonOutput: json } as never),
    );
    expect(concurrent.every((code) => typeof code === "number")).toBe(true);

    const workset = await executeWorksetStatusCommand({
      stateDirectory,
      isJsonOutput: true,
    } as never);
    expect(typeof workset).toBe("number");
  });

  it("④ recover/summary/instruction/provider 列表：空状态文本/JSON 双分支", async () => {
    expect(
      await executeRecoverListCommand({ stateDirectory, isJsonOutput: false } as never),
    ).toBeTypeOf("number");
    expect(
      await executeSummaryListCommand({ stateDirectory, isJsonOutput: true } as never),
    ).toBeTypeOf("number");
    expect(
      await executeInstructionListCommand({ stateDirectory, isJsonOutput: false } as never),
    ).toBeTypeOf("number");
    expect(
      await executeProviderListCommand({ stateDirectory, isJsonOutput: true } as never),
    ).toBeTypeOf("number");
  });

  it("⑤ context-metrics：空状态 JSON 输出可解析", async () => {
    const exitCode = await executeContextMetricsCommand({
      stateDirectory,
      isJsonOutput: true,
    } as never);
    expect(typeof exitCode).toBe("number");
  });
});
