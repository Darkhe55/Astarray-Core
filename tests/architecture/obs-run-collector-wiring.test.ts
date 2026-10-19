/**
 * 活规则：`run` 命令的 OBS 采集接线必须成对存在（2026-10-19 R73）。
 *
 * 为什么用静态守卫：真实 `run` 端到端要 provider 与任务轮询，跑一次很贵；
 * 而**接线最容易犯的错**恰恰是"接了一半"——只 start 不 stop（定时器泄漏）、
 * 或开关没透传（`--perf-collect` 变成空开关，用户以为开了其实没采）。
 *
 * 本守卫校验：①CLI 有开关且**只看 === true**；②命令侧**默认 off**、start 在 create 之后、
 * stop 在 finally 内。它不校验行为语义（那由用例覆盖），只防"接线被悄悄拆掉"。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..");

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("run 采集接线（静态）", () => {
  it("① CLI：存在 --perf-collect 开关，且只在显式 true 时才开启", async () => {
    const cliText = await readSource("packages/tui/src/cli.tsx");
    expect(cliText).toContain('"--perf-collect"');
    expect(cliText).toContain("isPerfCollectionEnabled: options.perfCollect === true");
  });

  it("② 命令侧：默认 off（只认 === true），并真的调用 start", async () => {
    const runCommandText = await readSource("packages/tui/src/cli/run-command.ts");
    expect(runCommandText).toContain("prepareRunPerfCollection");
    expect(runCommandText).toContain("isPerfCollectionEnabled: options.isPerfCollectionEnabled === true");
    expect(runCommandText).toContain("runPerfCollector.start()");
  });

  it("③ 命令侧：stop 必须落在 finally 块内（防定时器泄漏）", async () => {
    const runCommandText = await readSource("packages/tui/src/cli/run-command.ts");
    const finallyIndex = runCommandText.indexOf("} finally {");
    const stopIndex = runCommandText.indexOf("runPerfCollector.stop()");
    expect(finallyIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(finallyIndex);
    // 且 stop 在 application.shutdown 之前（先停采集再关应用）
    const shutdownIndex = runCommandText.indexOf("application.shutdown()", finallyIndex);
    expect(stopIndex).toBeLessThan(shutdownIndex);
  });
});
