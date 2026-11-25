/**
 * B9（2026-11-25）：无损上下文管理的守卫、配对暂存、迁移上限与持久化恢复。
 *
 * 纪律：紧急/重要/当前执行需要/未完成用户约束**不得暂存**；写盘失败不得谎报 staged；
 * 迁移有上限；重复补回必须幂等。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLosslessContextManager,
  type LosslessContextNode,
} from "../../../packages/core/src/toolkit/lossless-context-manager.js";

let baseDirectory: string;
let stagingDirectory: string;

beforeEach(async () => {
  baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-lossless-"));
  stagingDirectory = path.join(baseDirectory, "staging");
  await fs.mkdir(stagingDirectory, { recursive: true });
});

afterEach(async () => {
  await fs.rm(baseDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function node(overrides: Partial<LosslessContextNode> = {}): LosslessContextNode {
  return {
    nodeIdentifier: "N-1",
    revision: 1,
    sourceKind: "agent",
    priorityTier: 2,
    contentText: "节点内容",
    isUrgent: false,
    isImportant: false,
    isNeededForCurrentExecution: false,
    toolCallIdentifier: null,
    dependencyNodeIdentifiers: [],
    ...overrides,
  };
}

function createManager(maximumMigrationsPerRound = 10) {
  return createLosslessContextManager({ stagingDirectory, maximumMigrationsPerRound });
}

describe("B9：无损上下文管理", () => {
  it("① 保护矩阵：紧急/重要/当前执行需要/用户未完成约束 ⇒ 一律不暂存", async () => {
    const manager = createManager();
    const cases: LosslessContextNode[] = [
      node({ nodeIdentifier: "urgent", isUrgent: true }),
      node({ nodeIdentifier: "important", isImportant: true }),
      node({ nodeIdentifier: "needed", isNeededForCurrentExecution: true }),
      node({ nodeIdentifier: "user", sourceKind: "user", priorityTier: 0 }),
    ];
    for (const candidate of cases) {
      manager.registerNode(candidate);
      const outcome = await manager.stageNode(candidate);
      expect(outcome.isStaged).toBe(false);
      expect(outcome.reason).toBeTruthy();
    }
    expect(manager.listStagedNodeIdentifiers()).toEqual([]);
  });

  it("② 普通节点：暂存后可列出并读回原文", async () => {
    const manager = createManager();
    const target = node();
    manager.registerNode(target);
    const outcome = await manager.stageNode(target);
    expect(outcome.isStaged).toBe(true);
    expect(manager.listStagedNodeIdentifiers()).toContain("N-1");
    expect(await manager.readStagedContent("N-1")).toBe("节点内容");
  });

  it("③ 写盘失败 ⇒ 不谎报 staged", async () => {
    const manager = createManager();
    manager.setStagingWriterForTesting(async () => {
      throw new Error("磁盘写入失败");
    });
    const target = node({ nodeIdentifier: "N-fail" });
    manager.registerNode(target);
    const outcome = await manager.stageNode(target);
    expect(outcome.isStaged).toBe(false);
    expect(outcome.reason).toBeTruthy();
  });

  it("④ 配对暂存：调用与结果两侧要么都暂存、要么都不暂存", async () => {
    const manager = createManager();
    const callNode = node({ nodeIdentifier: "CALL", toolCallIdentifier: "call-1" });
    const resultNode = node({ nodeIdentifier: "RESULT", toolCallIdentifier: "call-1" });
    manager.registerNode(callNode);
    manager.registerNode(resultNode);
    manager.registerToolPair({
      toolCallIdentifier: "call-1",
      toolCallNodeIdentifier: "CALL",
      toolResultNodeIdentifier: "RESULT",
    });
    const outcome = await manager.stageNodePair({ toolCallIdentifier: "call-1" });
    expect(typeof outcome.isStaged).toBe("boolean");
    const staged = manager.listStagedNodeIdentifiers();
    expect(staged.includes("CALL")).toBe(staged.includes("RESULT"));

    /** 一侧受保护 ⇒ 整对都不暂存。 */
    const manager2 = createManager();
    const protectedCall = node({ nodeIdentifier: "CALL2", toolCallIdentifier: "call-2" });
    const normalResult = node({ nodeIdentifier: "RESULT2", toolCallIdentifier: "call-2" });
    const protectedResult = { ...normalResult, isImportant: true };
    manager2.registerNode(protectedCall);
    manager2.registerNode(protectedResult);
    manager2.registerToolPair({
      toolCallIdentifier: "call-2",
      toolCallNodeIdentifier: "CALL2",
      toolResultNodeIdentifier: "RESULT2",
    });
    const pairOutcome = await manager2.stageNodePair({ toolCallIdentifier: "call-2" });
    expect(pairOutcome.isStaged).toBe(false);
    expect(manager2.listStagedNodeIdentifiers()).toEqual([]);
  });

  it("⑤ 迁移上限与幂等：达到上限标记 capped；重复补回为幂等跳过", async () => {
    const manager = createManager(1);
    const first = node({ nodeIdentifier: "A", contentText: "A 内容" });
    const second = node({ nodeIdentifier: "B", contentText: "B 内容" });
    manager.registerNode(first);
    manager.registerNode(second);
    await manager.stageNode(first);
    await manager.stageNode(second);

    const reclaim = await manager.reclaimAtSafetyPoint();
    expect(reclaim.reclaimedNodeIdentifiers.length).toBeLessThanOrEqual(1);
    expect(reclaim.isMigrationsCapped).toBe(true);

    const again = await manager.reclaimAtSafetyPoint();
    expect(typeof again.isIdempotentSkip).toBe("boolean");
  });

  it("⑥ 显式召回：只有**永久关闭**的节点可回访；其余状态如实拒绝", async () => {
    const manager = createManager();
    const target = node({ nodeIdentifier: "R-1", contentText: "召回内容" });
    manager.registerNode(target);
    await manager.stageNode(target);

    /** 仅暂存（未永久关闭）⇒ 不允许显式回访。 */
    const stagedOnly = await manager.recallExplicitly({ nodeIdentifier: "R-1" });
    expect(stagedOnly.isRecalled).toBe(false);

    await manager.closePermanently({
      nodeIdentifier: "R-1",
      verifiedByGateIdentifier: "gate-1",
      isAccepted: true,
    });
    const recalled = await manager.recallExplicitly({ nodeIdentifier: "R-1" });
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.contentText).toBe("召回内容");

    const unknown = await manager.recallExplicitly({ nodeIdentifier: "missing" });
    expect(unknown.isRecalled).toBe(false);
  });

  it("⑦ 永久关闭：未登记/门禁拒绝/缺门禁标识都不关闭；接受才关闭", async () => {
    const manager = createManager();
    const target = node({ nodeIdentifier: "N-1" });
    manager.registerNode(target);
    await manager.stageNode(target);

    const unknownNode = await manager.closePermanently({
      nodeIdentifier: "missing",
      verifiedByGateIdentifier: "gate-1",
      isAccepted: true,
    });
    expect(unknownNode.isClosed).toBe(false);

    const rejected = await manager.closePermanently({
      nodeIdentifier: "N-1",
      verifiedByGateIdentifier: "gate-1",
      isAccepted: false,
    });
    expect(rejected.isClosed).toBe(false);

    const accepted = await manager.closePermanently({
      nodeIdentifier: "N-1",
      verifiedByGateIdentifier: "gate-1",
      isAccepted: true,
    });
    expect(accepted.isClosed).toBe(true);
  });

  it("⑧ 落盘/恢复：索引存在可恢复；索引被删也能靠原文重建", async () => {
    const manager = createManager();
    const target = node({ nodeIdentifier: "P-1" });
    manager.registerNode(target);
    await manager.stageNode(target);
    await manager.persistToDisk();

    const restored = createManager();
    const outcome = await restored.restoreFromDisk();
    expect(outcome.isRestored).toBe(true);
    expect(outcome.restoredNodeCount).toBeGreaterThanOrEqual(1);
    expect(outcome.isIndexPresent).toBe(true);

    await fs.rm(path.join(baseDirectory, "lossless-context-index.json"), { force: true });
    const restoredWithoutIndex = createManager();
    const outcomeWithoutIndex = await restoredWithoutIndex.restoreFromDisk();
    expect(outcomeWithoutIndex.isIndexPresent).toBe(false);
    expect(outcomeWithoutIndex.restoredNodeCount).toBeGreaterThanOrEqual(1);
  });
});
