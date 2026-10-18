/**
 * FOLDER-01-01 的反例（2026-10-18 R3）：对话式文件夹授权的**纯判定层**。
 *
 * 卡内 §1 的可本地验证缺口逐条钉住：
 *  - 模型只能提候选、不能签字；批准前零新增权限；
 *  - 一张卡只一个文件夹、无默认勾选、权限必须明确（不默认读写/永久）；
 *  - 含糊路径、`..`、其他项目目录、**父目录扩大范围**、尾部同名混淆；
 *  - **逐段**包含判定（`old-project-extra` 不属于 `old-project`）。
 */
import { describe, expect, it } from "vitest";

import {
  assessFolderGrantCandidate,
  buildFolderGrantCard,
  buildFolderGrantCardQueue,
  isPathInsideOrEqual,
  normalizeFolderPathForComparison,
  type FolderGrantCandidateInput,
  type ProjectRootRegistration,
} from "../../../packages/core/src/orchestration/folder-grant-request.js";

const registeredRoots: ReadonlyArray<ProjectRootRegistration> = [
  { projectIdentifier: "project-a", rootPath: "D:/Work/ProjectA" },
  { projectIdentifier: "project-b", rootPath: "D:/Work/ProjectB" },
  { projectIdentifier: "project-a", rootPath: "D:/Assets/ProjectA" },
];

function candidate(
  overrides: Partial<FolderGrantCandidateInput> = {},
): FolderGrantCandidateInput {
  return {
    projectIdentifier: "project-a",
    requestedPath: "D:/Assets/SharedAssets",
    permissionKind: "read-only",
    includesSubdirectories: true,
    durationKind: "session",
    proposedBy: "model",
    ...overrides,
  };
}

function assess(requestedPath: string, overrides: Partial<FolderGrantCandidateInput> = {}) {
  return assessFolderGrantCandidate({
    candidate: candidate({ requestedPath, ...overrides }),
    registeredRoots,
  });
}

describe("FOLDER-01-01：文件夹授权候选与短授权卡", () => {
  it("① 相对路径 ⇒ not-absolute，且不可出现批准动作", () => {
    const assessment = assess("Assets/SharedAssets");
    expect(assessment.classification).toBe("not-absolute");
    expect(assessment.isApprovalActionAvailable).toBe(false);
    expect(assessment.requiredUserAction).toContain("绝对路径");
    const card = buildFolderGrantCard({ candidate: candidate({ requestedPath: "Assets" }), assessment });
    expect(card.operations).not.toContain("approve-one");
  });

  it("② 含 `..` ⇒ contains-parent-traversal（不得按字面纳入）", () => {
    const assessment = assess("D:/Assets/../Secrets");
    expect(assessment.classification).toBe("contains-parent-traversal");
    expect(assessment.requiresRealPathVerification).toBe(true);
  });

  it("③ 非规范写法（反斜杠/`.`/重复分隔符）⇒ ambiguous-path，但比较口径正确", () => {
    expect(assess("D:\\\\Assets\\SharedAssets").classification).toBe("ambiguous-path");
    expect(assess("D:/Assets/./SharedAssets").classification).toBe("ambiguous-path");
    expect(assess("D://Assets//SharedAssets").classification).toBe("ambiguous-path");

    // 规范化后等价：大小写不敏感、分隔符统一
    const first = normalizeFolderPathForComparison("D:\\Assets\\Shared");
    const second = normalizeFolderPathForComparison("d:/assets/shared/");
    expect(first.comparisonPath).toBe(second.comparisonPath);
    expect(first.comparisonPath).toBe("d:/assets/shared");
  });

  it("④ 权限/期限含糊 ⇒ ambiguous-permission（不默认读写、不默认永久）", () => {
    expect(assess("D:/Assets/Shared", { permissionKind: "full-access" }).classification).toBe(
      "ambiguous-permission",
    );
    expect(assess("D:/Assets/Shared", { durationKind: "forever" }).classification).toBe(
      "ambiguous-permission",
    );
  });

  it("⑤ 已在自身项目根内 ⇒ inside-own-project（不制造冗余登记）", () => {
    const assessment = assess("D:/Work/ProjectA/sub/dir");
    expect(assessment.classification).toBe("inside-own-project");
    expect(assessment.isApprovalActionAvailable).toBe(false);
    expect(assessment.requiredUserAction).toContain("无需操作");
  });

  it("⑥ 在其他项目根内 ⇒ inside-other-project，必须走跨项目借阅", () => {
    const assessment = assess("D:/Work/ProjectB/data");
    expect(assessment.classification).toBe("inside-other-project");
    expect(assessment.requiredUserAction).toContain("跨项目借阅");
    expect(assessment.requiredUserAction).toContain("project-b");
  });

  it("⑦ **逐段**判定：`old-project-extra` 不属于 `old-project`（禁止字符串前缀）", () => {
    const roots = [{ projectIdentifier: "project-a", rootPath: "D:/Work/old-project" }];
    const outside = assessFolderGrantCandidate({
      candidate: candidate({ requestedPath: "D:/Work/old-project-extra" }),
      registeredRoots: roots,
    });
    // 既不在根内、也不是根的祖先 ⇒ 可接受（仍需确认）
    expect(outside.classification).toBe("acceptable");

    const inside = assessFolderGrantCandidate({
      candidate: candidate({ requestedPath: "D:/Work/old-project/sub" }),
      registeredRoots: roots,
    });
    expect(inside.classification).toBe("inside-own-project");

    expect(isPathInsideOrEqual("d:/work/old-project-extra", "d:/work/old-project")).toBe(false);
    expect(isPathInsideOrEqual("d:/work/old-project", "d:/work/old-project")).toBe(true);
  });

  it("⑧ 父目录（包含其他项目根）⇒ ancestor-of-project-root，拒绝扩大范围", () => {
    const assessment = assess("D:/Work");
    expect(assessment.classification).toBe("ancestor-of-project-root");
    expect(assessment.isApprovalActionAvailable).toBe(false);
    expect(assessment.requiredUserAction).toContain("具体子目录");
  });

  it("⑨ 可接受候选 ⇒ 短卡固定四项齐全、一张卡一个文件夹、无默认勾选", () => {
    const request = candidate();
    const assessment = assessFolderGrantCandidate({ candidate: request, registeredRoots });
    expect(assessment.classification).toBe("acceptable");
    expect(assessment.isApprovalActionAvailable).toBe(true);
    // 模型提出 ≠ 已授权
    expect(assessment.requiresAuthenticatedUserConfirmation).toBe(true);

    const card = buildFolderGrantCard({ candidate: request, assessment });
    expect(card.cardKind).toBe("folder-grant");
    expect(card.displayAbsolutePath).toBe("D:/Assets/SharedAssets");
    expect(card.permissionSummary).toBe("只读 · 含子目录 · 仅本次会话");
    expect(card.isBatch).toBe(false);
    expect(card.isDefaultApproved).toBe(false);
    expect(card.operations).toEqual(["approve-one", "reject", "view-details"]);
    expect(card.reason.length).toBeGreaterThan(0);
    expect(card.requiredUserAction.length).toBeGreaterThan(0);
  });

  it("⑩ 尾部同名 ⇒ 卡片必须提示混淆风险（展示完整绝对路径）", () => {
    // `D:/Other/ProjectA` 的尾段与已登记根 `D:/Work/ProjectA` 同名
    const assessment = assess("D:/Other/ProjectA");
    expect(assessment.classification).toBe("acceptable");
    expect(assessment.reason).toContain("尾部名称");

    const card = buildFolderGrantCard({
      candidate: candidate({ requestedPath: "D:/Other/ProjectA" }),
      assessment,
    });
    expect(card.displayAbsolutePath).toBe("D:/Other/ProjectA");
  });

  it("⑪ 批量请求 ⇒ 逐项卡片队列（每张 isBatch=false，被拒项无批准动作）", () => {
    const queue = buildFolderGrantCardQueue({
      candidates: [
        candidate({ requestedPath: "D:/Assets/Shared1" }),
        candidate({ requestedPath: "D:/Work" }),
        candidate({ requestedPath: "relative/path" }),
      ],
      registeredRoots,
    });
    expect(queue).toHaveLength(3);
    expect(queue.every((card) => card.isBatch === false)).toBe(true);
    expect(queue[0]?.isApprovalActionAvailable).toBe(true);
    expect(queue[1]?.isApprovalActionAvailable).toBe(false);
    expect(queue[2]?.isApprovalActionAvailable).toBe(false);
    expect(queue[1]?.operations).not.toContain("approve-one");
  });

  it("⑫ 真实路径复核：不一致必须明说；未复核不得假装已验证", () => {
    const mismatched = assess("D:/Assets/Shared", {
      resolvedRealPath: "D:/Elsewhere/Shared",
    });
    expect(mismatched.realPathMismatchNotice).toContain("不一致");
    expect(mismatched.realPathMismatchNotice).toContain("junction");

    const notVerified = assess("D:/Assets/Shared");
    expect(notVerified.realPathMismatchNotice).toBeNull();
    expect(notVerified.requiresRealPathVerification).toBe(true);

    const consistent = assess("D:/Assets/Shared", {
      resolvedRealPath: "d:/assets/shared/",
    });
    expect(consistent.realPathMismatchNotice).toBeNull();
  });

  it("⑬ 网络路径（UNC）仍按绝对路径处理，并保留原样展示", () => {
    const assessment = assess("//server/share/assets");
    expect(assessment.classification).toBe("acceptable");
    expect(assessment.normalizedPath?.isNetworkPath).toBe(true);
    const card = buildFolderGrantCard({
      candidate: candidate({ requestedPath: "//server/share/assets" }),
      assessment,
    });
    expect(card.displayAbsolutePath).toBe("//server/share/assets");
  });
});
