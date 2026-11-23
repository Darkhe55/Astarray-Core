/**
 * D2（2026-11-23 产品裁决）：派发前已取消的序列节点不得启动。
 *
 * 覆盖纯过滤规则，以及"权威序列快照 + 过滤"的组合：
 * 取消节点被拦下、可派发节点保留、全部取消时整体拒绝。
 */
import { describe, expect, it } from "vitest";

import {
  filterDispatchableSequenceNodes,
  isEveryDispatchableNodeBlocked,
} from "../../../packages/core/src/orchestration/sequence-dispatch-guard.js";

interface Node {
  readonly id: string;
  readonly sourceSequenceTaskIdentifier?: string;
}

describe("D2：序列节点取消的派发过滤", () => {
  it("① 来源已取消的节点被阻止，其它节点保留", () => {
    const result = filterDispatchableSequenceNodes<Node>({
      nodes: [
        { id: "M-1", sourceSequenceTaskIdentifier: "seq-task-cancelled" },
        { id: "M-2", sourceSequenceTaskIdentifier: "seq-task-ok" },
        { id: "M-3" },
      ],
      cancelledSequenceTaskIdentifiers: new Set(["seq-task-cancelled"]),
    });
    expect(result.dispatchableNodes.map((node) => node.id)).toEqual(["M-2", "M-3"]);
    expect(result.blockedSourceSequenceTaskIdentifiers).toEqual(["seq-task-cancelled"]);
    expect(isEveryDispatchableNodeBlocked(result)).toBe(false);
  });

  it("② 全部来自已取消节点 ⇒ 整体拒绝", () => {
    const result = filterDispatchableSequenceNodes<Node>({
      nodes: [{ id: "M-1", sourceSequenceTaskIdentifier: "c1" }],
      cancelledSequenceTaskIdentifiers: new Set(["c1"]),
    });
    expect(result.dispatchableNodes).toEqual([]);
    expect(isEveryDispatchableNodeBlocked(result)).toBe(true);
  });

  it("③ 没有来源声明或无取消 ⇒ 原样派发（不误伤）", () => {
    const noSource = filterDispatchableSequenceNodes<Node>({
      nodes: [{ id: "M-1" }],
      cancelledSequenceTaskIdentifiers: new Set(["c1"]),
    });
    expect(noSource.dispatchableNodes).toHaveLength(1);
    const noneCancelled = filterDispatchableSequenceNodes<Node>({
      nodes: [{ id: "M-1", sourceSequenceTaskIdentifier: "c2" }],
      cancelledSequenceTaskIdentifiers: new Set(),
    });
    expect(noneCancelled.dispatchableNodes).toHaveLength(1);
  });

  it("④ 去重后的阻止清单排序稳定（审计可复跑）", () => {
    const result = filterDispatchableSequenceNodes<Node>({
      nodes: [
        { id: "M-1", sourceSequenceTaskIdentifier: "b" },
        { id: "M-2", sourceSequenceTaskIdentifier: "a" },
        { id: "M-3", sourceSequenceTaskIdentifier: "b" },
      ],
      cancelledSequenceTaskIdentifiers: new Set(["a", "b"]),
    });
    expect(result.blockedSourceSequenceTaskIdentifiers).toEqual(["a", "b"]);
  });
});
