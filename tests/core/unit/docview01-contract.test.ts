/**
 * DOCVIEW-01-01 的反例（2026-10-18 R17）：能力矩阵与损失提示。
 *
 * 卡内验收：普通内容任务不读取样式详情；排版任务可显式展开；
 * 过滤视图不可写回；损失如实；扫描件不伪报完整。
 */
import { describe, expect, it } from "vitest";

import {
  buildDocumentViewReceipt,
  canWriteBackFromFilteredView,
  evaluateDocumentViewCapability,
  listDefaultOmittedCategories,
  resolveDocumentPresentationMode,
  shouldReadStyleDetails,
} from "../../../packages/core/src/orchestration/document-view-contract.js";

describe("DOCVIEW-01-01：格式能力矩阵与损失提示", () => {
  it("① 模式枚举：缺省 content；未知值 ⇒ null（不猜）", () => {
    expect(resolveDocumentPresentationMode(undefined)).toBe("content");
    expect(resolveDocumentPresentationMode("structure")).toBe("structure");
    expect(resolveDocumentPresentationMode("layout")).toBe("layout");
    expect(resolveDocumentPresentationMode("all")).toBeNull();
  });

  it("② 能力矩阵：扫描件 PDF ⇒ 不支持且如实说明；DOCX/PDF 的 layout 只补读必要属性", () => {
    expect(
      evaluateDocumentViewCapability({
        format: "pdf",
        presentationMode: "content",
        isPdfReliablyExtractable: false,
      }),
    ).toMatchObject({ isSupported: false });
    expect(
      evaluateDocumentViewCapability({
        format: "pdf",
        presentationMode: "layout",
        isPdfReliablyExtractable: true,
      }).reason,
    ).toContain("不导出完整样式树");
    expect(
      evaluateDocumentViewCapability({ format: "docx", presentationMode: "content" }).isSupported,
    ).toBe(true);
  });

  it("③ 省略类别随模式收窄：content 省略纯展示属性，layout 只省略完整样式树", () => {
    expect(listDefaultOmittedCategories("content")).toContain("font-size");
    expect(listDefaultOmittedCategories("content")).toContain("style-tree");
    expect(listDefaultOmittedCategories("structure")).not.toContain("margins");
    expect(listDefaultOmittedCategories("layout")).toEqual(["style-tree"]);
  });

  it("④ 回执必须带源版本与锚点；缺失 ⇒ 拒绝", () => {
    expect(
      buildDocumentViewReceipt({
        format: "markdown",
        presentationMode: "content",
        sourceRevision: "  ",
        sourceAnchors: ["#intro"],
      }).kind,
    ).toBe("rejected");
    expect(
      buildDocumentViewReceipt({
        format: "markdown",
        presentationMode: "content",
        sourceRevision: "rev-1",
        sourceAnchors: [],
      }).kind,
    ).toBe("rejected");
  });

  it("⑤ 内容优先仍须报告已知损失；语义格式受损 ⇒ 标不确定且可展开", () => {
    const plain = buildDocumentViewReceipt({
      format: "docx",
      presentationMode: "content",
      sourceRevision: "rev-1",
      sourceAnchors: ["p:1"],
    });
    expect(plain.kind).toBe("built");
    if (plain.kind !== "built") throw new Error("应生成");
    expect(plain.receipt.knownLosses.join()).toContain("纯展示属性");
    expect(plain.receipt.mustMarkUncertain).toBe(false);
    expect(plain.receipt.isExpandable).toBe(true);

    const semantic = buildDocumentViewReceipt({
      format: "docx",
      presentationMode: "content",
      sourceRevision: "rev-1",
      sourceAnchors: ["p:1"],
      hasSemanticFormatting: true,
    });
    if (semantic.kind !== "built") throw new Error("应生成");
    expect(semantic.receipt.mustMarkUncertain).toBe(true);
    expect(semantic.receipt.knownLosses.join()).toContain("承担语义");
  });

  it("⑥ 过滤视图**不可**写回；不执行宏/脚本", () => {
    expect(canWriteBackFromFilteredView()).toBe(false);
    const receipt = buildDocumentViewReceipt({
      format: "html",
      presentationMode: "structure",
      sourceRevision: "sha:abc",
      sourceAnchors: ["body"],
    });
    if (receipt.kind !== "built") throw new Error("应生成");
    expect(receipt.receipt.isFullFileWriteBackAllowed).toBe(false);
    expect(receipt.receipt.executesMacrosOrScripts).toBe(false);
  });

  it("⑦ 缓存键按模式/版本/锚点隔离（不同视图不共用缓存）", () => {
    const base = {
      format: "docx" as const,
      sourceRevision: "rev-1",
      sourceAnchors: ["p:1"],
    };
    const contentReceipt = buildDocumentViewReceipt({ ...base, presentationMode: "content" });
    const structureReceipt = buildDocumentViewReceipt({ ...base, presentationMode: "structure" });
    if (contentReceipt.kind !== "built" || structureReceipt.kind !== "built") {
      throw new Error("应生成");
    }
    expect(contentReceipt.receipt.cacheKey).not.toBe(structureReceipt.receipt.cacheKey);

    const sameAgain = buildDocumentViewReceipt({ ...base, presentationMode: "content" });
    if (sameAgain.kind !== "built") throw new Error("应生成");
    expect(sameAgain.receipt.cacheKey).toBe(contentReceipt.receipt.cacheKey);
  });

  it("⑧ 普通内容任务不读样式详情；排版任务 + layout 才显式展开", () => {
    expect(shouldReadStyleDetails({ taskKind: "content", presentationMode: "content" })).toBe(false);
    expect(shouldReadStyleDetails({ taskKind: "content", presentationMode: "layout" })).toBe(false);
    expect(shouldReadStyleDetails({ taskKind: "layout-review", presentationMode: "content" })).toBe(
      false,
    );
    expect(shouldReadStyleDetails({ taskKind: "layout-review", presentationMode: "layout" })).toBe(
      true,
    );
  });
});
