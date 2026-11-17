/**
 * 架构守卫（COORD 检查点 2，2026-11-16）：**消费必须接在启动恢复上**。
 *
 * 背景：`runConsumptionStep` 曾在生产代码里零调用，"四检查点全部有生产接线"的说法因此站不住。
 * 本守卫钉住两件事，防止接线被悄悄摘掉：
 * 1. 启动恢复里确实调用 `runCoordinationConsumptionOnce(...)`；
 * 2. 消费结果确实被送进**权威任务链**（`applyCoordinationMessageToTaskState`），
 *    而不是只更新协调器内部状态。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const RUNTIME_FILE_PATH = path.join(
  process.cwd(),
  "packages",
  "core",
  "src",
  "application",
  "application-runtime.ts",
);

async function readProductionCode(): Promise<string> {
  const content = await fs.readFile(RUNTIME_FILE_PATH, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
}

describe("COORD 消费接线守卫", () => {
  it("① 启动恢复必须真的调用消费入口", async () => {
    const code = await readProductionCode();
    expect(code).toContain("runCoordinationConsumptionOnce({");
  }, 30_000);

  it("② 消费结果必须落到权威任务链（不得只改协调器内部状态）", async () => {
    const code = await readProductionCode();
    expect(code).toContain("applyCoordinationMessageToTaskState({");
  }, 30_000);
});

describe("COORD 入库通知触发（第二条触发路径）", () => {
  it("③ 运行时必须提供入库通知端口，并复用同一消费实现", async () => {
    const code = await readProductionCode();
    expect(code).toContain("coordinationIngestionNotifier:");
    expect(code).toContain("runCoordinationConsumptionForMission(missionIdentifier)");
  }, 30_000);

  it("④ 主控制器必须把通知转给 AssistScheduler（不得只在 options 里声明）", async () => {
    const controllerCode = await fs.readFile(
      path.join(process.cwd(), "packages", "core", "src", "orchestration", "main-controller.ts"),
      "utf8",
    );
    expect(controllerCode).toContain("onCoordinationMessageIngested:");
  }, 30_000);

  it("⑤ AssistScheduler 收到消息必须真的回调（含非指令消息）", async () => {
    const schedulerCode = await fs.readFile(
      path.join(process.cwd(), "packages", "core", "src", "orchestration", "assist-scheduler.ts"),
      "utf8",
    );
    expect(schedulerCode).toContain("assistOptions.onCoordinationMessageIngested?.()");
  }, 30_000);
});

describe("运行中 mission 必须打到调度器（2026-11-16）", () => {
  it("⑥ 运行时先问运行中调度器，未运行才写任务链", async () => {
    const code = await readProductionCode();
    expect(code).toContain("applyCoordinationTaskOutcome({");
    /** 顺序：先 active 判定，再链写入（缩进无关，只看两处存在且 active 在前）。 */
    const activeIndex = code.indexOf("applyCoordinationTaskOutcome({");
    const chainIndex = code.indexOf("applyCoordinationMessageToTaskState({", activeIndex);
    expect(activeIndex).toBeGreaterThan(-1);
    expect(chainIndex).toBeGreaterThan(activeIndex);
  }, 30_000);

  it("⑦ 主控制器用运行中注册表派发（不得凭空造调度器）", async () => {
    const controllerCode = await fs.readFile(
      path.join(process.cwd(), "packages", "core", "src", "orchestration", "main-controller.ts"),
      "utf8",
    );
    expect(controllerCode).toContain("this.activeOrchestrators.get(input.missionIdentifier)");
    expect(controllerCode).toContain("completeTaskByTaskIdentifier(");
    expect(controllerCode).toContain("input.completionAuthorization");
  }, 30_000);

  it("⑧ 阻塞不得来自消息：任务状态模块不含 blocked 分支", async () => {
    const taskStateCode = await fs.readFile(
      path.join(process.cwd(), "packages", "core", "src", "orchestration", "coordination-task-state.ts"),
      "utf8",
    );
    const productionLines = taskStateCode
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    expect(productionLines.join("\n")).not.toContain('kind === "blocked"');
  }, 30_000);
});
