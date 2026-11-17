/**
 * WIRING-04-03 守卫（2026-11-17）：**没有权威校验凭证不得标记 done**。
 *
 * 背景：`completeTaskByTaskIdentifier` 是公开入口，历史上任何调用方都能直接标 done，
 * 绕过 `evaluateAuthoritativeCompletion`。现在它要求受控凭证，本守卫钉住三点：
 *
 * 1. 入口内部必须有凭证校验（缺凭证抛 `completion-not-authorized`）；
 * 2. 控制器转发凭证（不吞、不伪造）；
 * 3. 运行时只在 `done` 时发放凭证。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function readSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

describe("完成凭证守卫", () => {
  it("① 公开完成入口校验凭证", async () => {
    const orchestrator = await readSource(
      "packages/core/src/orchestration/mission-orchestrator.ts",
    );
    expect(orchestrator).toContain('"completion-not-authorized"');
    expect(orchestrator).toContain("completionAuthorization");
  }, 30_000);


  it("①b 非活动 mission 的写链入口同样校验凭证", async () => {
    const chainUpdater = await readSource(
      "packages/core/src/orchestration/coordination-task-state.ts",
    );
    expect(chainUpdater).toContain("completion-not-authorized");
    expect(chainUpdater).toContain("completionAuthorization");
  }, 30_000);
  it("② 控制器转发凭证（不吞不造）", async () => {
    const controller = await readSource("packages/core/src/orchestration/main-controller.ts");
    expect(controller).toContain("completionAuthorization");
    expect(controller).toContain("input.completionAuthorization");
  }, 30_000);

  it("③ 运行时只在 done 时发放凭证", async () => {
    const runtime = await readSource("packages/core/src/application/application-runtime.ts");
    expect(runtime).toContain("authoritative-completion-accepted");
    expect(runtime).toContain('coordinationTaskStatus === "done"');
  }, 30_000);
});