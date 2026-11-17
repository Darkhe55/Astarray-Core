/**
 * 守卫（2026-11-17）：`resultLocation` 的语义边界。
 *
 * 背景：`docs/reports/TASKCARD_BACKLOG_2026-10-17.md` 曾记录"回填 resultLocation 让返修任务变 blocked"。
 * 查明结论是**语义冲突**：`resultLocation` 在恢复对账里表示"已产出但未回执"，
 * 不是"送审产物指针"。送审产物必须走完成收据。
 *
 * 本守卫钉住两条事实，防止将来有人再次用 resultLocation 冒充送审产物。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("resultLocation 语义守卫", () => {
  it("① 送审产物必须来自完成收据（不是 resultLocation）", async () => {
    const orchestrator = await readSource(
      "packages/core/src/orchestration/mission-orchestrator.ts",
    );
    expect(orchestrator).toContain("[...outcome.completionReceipt.artifactPaths]");
  }, 30_000);

  it("② 恢复对账把非空 resultLocation 当作『已产出未回执』（blocked 原因）", async () => {
    const controller = await readSource("packages/core/src/orchestration/main-controller.ts");
    expect(controller).toContain("producedButUnacknowledgedTaskIdentifiers.push(task.id)");
    expect(controller).toContain("任务已产出但未回执，需先对账");
  }, 30_000);

  it("③ Worker 成功分支不得回填 resultLocation（恢复对账信号不能被占用）", async () => {
    const worker = await readSource("packages/core/src/orchestration/worker-agent.ts");
    /** 只允许 null；出现 `resultLocation: <表达式>` 即视为有人开始回填。 */
    /** 允许 `resultLocation: null` 与类型声明 `resultLocation: string | null`；其余赋值即视为回填。 */
    expect(worker).not.toMatch(/resultLocation:\s*(?!null\b|string\b)[A-Za-z_$]/u);
  }, 30_000);
});