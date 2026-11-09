/**
 * ALIGN-04-03（2026-11-10）：**已产出任务的产物校验**（只读，不改状态）。
 *
 * 背景：任务链里"有 `resultLocation`"只证明**记了一路径**，不证明产物真的在。
 * 恢复前把"记了路径"当成"已产出"会导致两种谎报：
 *  - 路径写错/产物被删 ⇒ 误以为有产出而跳过重跑；
 *  - 路径指向仓库外 ⇒ 校验到错误的位置。
 *
 * 本模块只回答"这个产物是否真的存在且非空"，**不做**任何状态变更。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

export type OutputArtifactCheck =
  | { readonly kind: "present"; readonly byteSize: number; readonly resolvedPath: string }
  | { readonly kind: "missing"; readonly detail: string }
  | { readonly kind: "empty"; readonly detail: string }
  /** 路径越界（不在项目根内）—— 不校验、也不当成已产出。 */
  | { readonly kind: "outside-project-root"; readonly detail: string };

/**
 * 校验产物：必须位于**项目根内**、存在、且非空。
 *
 * 越界一律拒绝：`resultLocation` 来自任务链（可能被模型写入），
 * 不允许用它去读项目外的东西。
 */
export async function checkOutputArtifact(input: {
  readonly projectRootPath: string;
  readonly resultLocation: string;
}): Promise<OutputArtifactCheck> {
  const resultLocation = input.resultLocation.trim();
  if (resultLocation === "") {
    return { kind: "missing", detail: "resultLocation 为空" };
  }
  const projectRootPath = path.resolve(input.projectRootPath);
  const resolvedPath = path.resolve(projectRootPath, resultLocation);
  const relativePath = path.relative(projectRootPath, resolvedPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return {
      kind: "outside-project-root",
      detail: `产物路径不在项目根内：${resultLocation}`,
    };
  }
  let fileStatistics;
  try {
    fileStatistics = await fs.stat(resolvedPath);
  } catch {
    return { kind: "missing", detail: `产物不存在：${resultLocation}` };
  }
  if (!fileStatistics.isFile()) {
    return { kind: "missing", detail: `产物不是普通文件：${resultLocation}` };
  }
  if (fileStatistics.size === 0) {
    return { kind: "empty", detail: `产物为空文件：${resultLocation}` };
  }
  return { kind: "present", byteSize: fileStatistics.size, resolvedPath };
}

/** 只有 `present` 才足以支持"已产出"的结论。 */
export function isOutputArtifactConfirmed(check: OutputArtifactCheck): boolean {
  return check.kind === "present";
}
