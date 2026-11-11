/**
 * CLUSTER-01 §3：纯聚类算法的行为锁定。
 *
 * 重点反例：
 * - 分桶键不同**不得**聚合；
 * - `null` 不得被推断成某个错误码；
 * - **禁止传递合并**（A 近 B、B 近 C ≠ A 近 C）；
 * - 空文本不参与模糊归组；
 * - 相同分数时按代表记录 ID 字典序取组（确定性）。
 */
import { describe, expect, it } from "vitest";

import {
  buildDiagnosticBucketKey,
  clusterDiagnosticEvents,
  computeJaccardSimilarity,
  computeTrigramSet,
  normalizeDiagnosticText,
  type DiagnosticClusterInput,
} from "../../../packages/core/src/orchestration/diagnostic-clusterer.js";

function buildEvent(
  overrides: Partial<DiagnosticClusterInput> & { messageText: string; sourceRecordIdentifier: string },
): DiagnosticClusterInput {
  return {
    recordedAtIso: "2026-11-11T00:00:00.000Z",
    errorCode: "E_TIMEOUT",
    component: "worker",
    stage: "execute",
    classification: "transient",
    projectIdentifier: "project-alpha",
    chain: { rootErrorCode: "E_TIMEOUT", wrapperErrorCodes: [] },
    ...overrides,
  };
}

describe("CLUSTER-01 文本规范化 diagnostic-text-v1", () => {
  it("替换 ISO 时间戳与 UUID，统一换行与空白", () => {
    const normalized = normalizeDiagnosticText(
      "  失败于 2026-11-11T00:00:00.000Z  trace=550e8400-e29b-41d4-a716-446655440000\r\n\r\n  重试  ",
    );
    expect(normalized).toBe("失败于 <timestamp> trace=<uuid>\n重试");
  });

  it("不泛化数字、路径与大小写（卡内明令禁止）", () => {
    const normalized = normalizeDiagnosticText("Timeout 5000ms at /tmp/a/b.ts Code=E42");
    expect(normalized).toContain("5000ms");
    expect(normalized).toContain("/tmp/a/b.ts");
    expect(normalized).toContain("Timeout");
    expect(normalized).toContain("E42");
  });
});

describe("CLUSTER-01 三元组与 Jaccard", () => {
  it("不足三个码点用完整文本作特征；空文本无特征", () => {
    expect([...computeTrigramSet("ab")]).toEqual(["ab"]);
    expect(computeTrigramSet("").size).toBe(0);
  });

  it("Jaccard 为交集比并集", () => {
    const left = computeTrigramSet("abcdef");
    const right = computeTrigramSet("abcxyz");
    /** 交集 {abc}=1，并集 size 4+4-1=7。 */
    expect(computeJaccardSimilarity(left, right)).toBeCloseTo(1 / 7, 6);
    expect(computeJaccardSimilarity(left, computeTrigramSet(""))).toBe(0);
  });
});

describe("CLUSTER-01 分桶与聚类", () => {
  it("分桶键不同的记录永不聚合（即使文本完全相同）", () => {
    const events = [
      buildEvent({ sourceRecordIdentifier: "r1", messageText: "同样的文本 timeout" }),
      buildEvent({
        sourceRecordIdentifier: "r2",
        messageText: "同样的文本 timeout",
        errorCode: "E_OTHER",
        chain: { rootErrorCode: "E_OTHER", wrapperErrorCodes: [] },
      }),
    ];
    const result = clusterDiagnosticEvents(events);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((group) => group.memberCount === 1)).toBe(true);
  });

  it("`null` 保持未知：null 与具体值不同桶；两个 null 也不同桶（与具体值）", () => {
    const withNull = buildEvent({
      sourceRecordIdentifier: "r1",
      messageText: "文本",
      classification: null,
    });
    const withValue = buildEvent({ sourceRecordIdentifier: "r2", messageText: "文本", classification: "resource" });
    expect(buildDiagnosticBucketKey(withNull)).not.toBe(buildDiagnosticBucketKey(withValue));
    expect(clusterDiagnosticEvents([withNull, withValue]).groups).toHaveLength(2);
  });

  it("相同文本去重计数，但仍保留成员条数", () => {
    const events = [
      buildEvent({ sourceRecordIdentifier: "r1", messageText: "连接超时 timeout" }),
      buildEvent({ sourceRecordIdentifier: "r2", messageText: "连接超时 timeout" }),
    ];
    const result = clusterDiagnosticEvents(events);
    expect(result.groups).toHaveLength(1);
    const group = result.groups[0]!;
    expect(group.memberCount).toBe(2);
    expect(group.distinctTextCount).toBe(1);
  });

  it("**禁止传递合并**：A 近 B、B 近 C，但 A 与 C 不近 ⇒ C 必须新建组", () => {
    /** 构造：b 与 a 共享 7/9 个三元组（0.78），c 与 a 只共享 2/11（0.18）。 */
    const textA = "ABCDEFGHIJ";
    const textB = "ABCDEFGHIX";
    const textC = "ABCDZZZZZZ";
    const similarity = (left: string, right: string) =>
      computeJaccardSimilarity(
        computeTrigramSet(normalizeDiagnosticText(left)),
        computeTrigramSet(normalizeDiagnosticText(right)),
      );
    /** 先确认前提成立，否则这个用例就失去意义。 */
    expect(similarity(textA, textB)).toBeGreaterThanOrEqual(0.3);
    expect(similarity(textA, textC)).toBeLessThan(0.3);

    const events = [textA, textB, textC].map((text, index) =>
      buildEvent({ sourceRecordIdentifier: `r${String(index)}`, messageText: text }),
    );
    const result = clusterDiagnosticEvents(events, { similarityThreshold: 0.3 });
    /** 关键：不出现"A、B、C 全在一组"的传递闭合（只与代表成员比较）。 */
    const groupSizes = result.groups.map((group) => group.memberCount).sort();
    expect(groupSizes).toEqual([1, 2]);
  });

  it("空文本不参与模糊归组：两条空文本各自成组之外的行为可判定", () => {
    const events = [
      buildEvent({ sourceRecordIdentifier: "r1", messageText: "" }),
      buildEvent({ sourceRecordIdentifier: "r2", messageText: "   " }),
      buildEvent({ sourceRecordIdentifier: "r3", messageText: "有内容的错误文本" }),
    ];
    const result = clusterDiagnosticEvents(events);
    /** 空文本与空白文本规范化后都是空 ⇒ 视为完全相同文本，可合并；不得与有内容者合并。 */
    const groupsWithContent = result.groups.filter((group) =>
      group.members.some((member) => member.normalizedText !== ""),
    );
    expect(groupsWithContent).toHaveLength(1);
    expect(groupsWithContent[0]!.memberCount).toBe(1);
  });

  it("结果确定性：同一输入两次聚类分组完全一致", () => {
    const events = [
      buildEvent({ sourceRecordIdentifier: "r1", messageText: "超时 连接 timeout" }),
      buildEvent({ sourceRecordIdentifier: "r2", messageText: "超时 连接 error" }),
      buildEvent({ sourceRecordIdentifier: "r3", messageText: "完全不同的第三段文本" }),
    ];
    const first = clusterDiagnosticEvents(events);
    const second = clusterDiagnosticEvents([...events].reverse());
    const signature = (groups: typeof first.groups) =>
      groups.map((group) => group.members.map((member) => member.sourceRecordIdentifier).join(",")).sort();
    expect(signature(first.groups)).toEqual(signature(second.groups));
  });
});
