/**
 * 读取侧扫描标注（此前 `tests/` 零引用）：**只标注、不改内容、不阻断**。
 *
 * 关键是三点：结论如实透传（含 incomplete/error）、标注**不含正文**、
 * 且 `isEvaluatedAtReadTime` 恒为 true（这是读取时算的，不是写入时的旧结论）。
 */
import { describe, expect, it } from "vitest";

import { SENSITIVE_SCAN_RULE_SET_VERSION } from "../../../packages/core/src/tools/sensitive-content-scan-contract.js";
import { buildReadSideContentScanLabel } from "../../../packages/core/src/tools/read-side-content-scan.js";

const FAKE_TOKEN = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";

describe("读取侧扫描标注", () => {
  it("① 干净内容 ⇒ clean、isClean=true、读取时求值、时间戳透传", () => {
    const label = buildReadSideContentScanLabel("这是一份普通的项目说明。", "2026-11-13T00:00:00.000Z");
    expect(label.outcome).toBe("clean");
    expect(label.isClean).toBe(true);
    expect(label.isEvaluatedAtReadTime).toBe(true);
    expect(label.evaluatedAtIso).toBe("2026-11-13T00:00:00.000Z");
    expect(label.ruleSetVersion).toBe(SENSITIVE_SCAN_RULE_SET_VERSION);
    expect(label.matchedRuleIdentifiers).toEqual([]);
  });

  it("② 命中凭据 ⇒ sensitive、isClean=false、给出规则标识", () => {
    const label = buildReadSideContentScanLabel(`配置里写着 ${FAKE_TOKEN}`);
    expect(label.outcome).toBe("sensitive");
    expect(label.isClean).toBe(false);
    expect(label.matchedRuleIdentifiers.length).toBeGreaterThan(0);
  });

  it("③ **标注不含正文**：整份标注里搜不到原文与凭据值", () => {
    const content = `机密说明：${FAKE_TOKEN} 请勿外传`;
    const label = buildReadSideContentScanLabel(content);
    const serialized = JSON.stringify(label);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain("机密说明");
    expect(Object.keys(label)).not.toContain("content");
  });

  it("④ 只标注不改内容：同一输入两次调用除时间外一致（无隐藏状态）", () => {
    const content = "同一段内容";
    const first = buildReadSideContentScanLabel(content, "2026-11-13T00:00:00.000Z");
    const second = buildReadSideContentScanLabel(content, "2026-11-13T00:00:00.000Z");
    expect(second).toEqual(first);
  });

  it("⑤ 结论如实透传：超字节上限的标注仍是 incomplete，不冒充 clean", () => {
    /** 直接走默认限额 ⇒ 2 MiB 以内；这里用超长内容触发 incomplete。 */
    const huge = "普通文本".repeat(300_000);
    const label = buildReadSideContentScanLabel(huge);
    expect(label.outcome).toBe("incomplete");
    expect(label.isClean).toBe(false);
    expect(label.limitReason).not.toBeNull();
  });
});
