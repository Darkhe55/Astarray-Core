/**
 * 接线守卫（2026-11-16）：上下文提供者与独立审查派发。
 *
 * 为什么要守卫：这两条链都曾经"能力存在但没人调用"。
 * 本守卫只钉住**已被核实为真实生产调用**的事实，不宣称未接线的部分。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("上下文与独立审查接线守卫", () => {
  it("① 工作路径必须把 contextPromptProvider 传给 WorkerAgent", async () => {
    const orchestrator = await readSource("packages/core/src/orchestration/mission-orchestrator.ts");
    /** 提供者在 `buildWorkerAgent(...)` 的选项里传入，再经 `new WorkerAgent({ ...options })` 展开。 */
    expect(orchestrator).toContain("contextPromptProvider: this.options.contextPromptProvider");
    expect(orchestrator).toMatch(/new WorkerAgent\(\{[\s\S]*\.\.\.options/u);
  }, 30_000);

  it("② WorkerAgent 必须真的调用它，且必要条件缺失时阻塞", async () => {
    const worker = await readSource("packages/core/src/orchestration/worker-agent.ts");
    expect(worker).toContain("await contextPromptProvider({");
    expect(worker).toContain("context-mandatory-constraint-missing");
  }, 30_000);

  it("③ 独立审查必须派发真实审查任务，而不是就地写裁决", async () => {
    const controller = await readSource("packages/core/src/orchestration/main-controller.ts");
    expect(controller).toContain("reviewTask: buildReviewTaskNode({");
    /** 审查任务自身不再派生（防递归）。 */
    expect(controller).toContain('if (task?.taskType === "review") {');
  }, 30_000);

  it("④ 审查任务必须在安全点注入（由编排器调度，而非绕过调度器执行）", async () => {
    const orchestrator = await readSource("packages/core/src/orchestration/mission-orchestrator.ts");
    expect(orchestrator).toContain("reviewTask");
    expect(orchestrator).toContain("injectTaskAtSafePoint");
  }, 30_000);
});
