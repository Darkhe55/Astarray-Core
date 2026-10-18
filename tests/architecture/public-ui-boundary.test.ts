/**
 * 公开库 UI 边界守卫（2026-10-19 R29，用户决策：**只有 CLI 落在公开库；TUI 与 GUI 统一放私有库**）。
 *
 * 规则：
 * - 公开源码 = `packages/core/src/**` + `packages/tui/src/**`，**但排除** `packages/tui/src/ui/**`
 *   与 `packages/tui/src/cli/tui.tsx`（终端 UI，属私有库 `astarray-ui`）；
 * - 公开源码**不得**按路径引用 `packages/gui/**`、`.../ui/**`、`public-gui`。
 *
 * 本测试把**当前仍存在的接缝**钉成**显式白名单**（数量与内容都必须精确）：
 * - 新增任何一条 UI 引用 ⇒ 红（防止耦合再长回来）；
 * - 一旦把某条接缝迁到私有库（白名单条目消失）⇒ **也红**，提示同步缩小白名单
 *   （避免"迁走了但白名单还留着"这种假通过）。
 *
 * 关键词匹配用 `(^|[/\\])gui([/\\]|$)` 这类**路径段**判定，避免把 `guidance` 误判成 `gui`。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(__dirname, "..", "..");
const publicSourceDirectories = [
  path.join(repositoryRoot, "packages", "core", "src"),
  path.join(repositoryRoot, "packages", "tui", "src"),
];

/** 公开源码里被排除的私有 UI 路径（相对仓库根，正斜杠）。 */
const privateUiRelativePaths = ["packages/tui/src/ui/", "packages/tui/src/cli/tui.tsx"];

/**
 * **当前**唯一允许的两条 UI 接缝（都必须是**动态、可选**导入）。
 *
 * 迁到私有库后请**删除对应条目**——本测试会因"白名单条目已不存在"而变红，提醒你同步。
 */
/**
 * **当前**允许的 UI 接缝：**为空**。
 *
 * 2026-10-19 R32 已完成收口：`gui serve` 实现迁到私有库 `astarray-ui`（公开侧只留 fail-closed 提示）、
 * TUI 启动桥改为**非字面量**动态导入（缺失即提示 + 非 0 退出），随后删除了公开库内的 UI 本地副本。
 * 若将来确实需要新增接缝，必须在这里显式登记并写明理由。
 */
const pinnedUiSeamAllowlist: Array<{ filePath: string; specifierFragment: string; rationale: string }> = [];

/** 私有 UI 的**绝对**位置（解析后的目标判定，避免把 core 内部的 `gui/` 模块误判）。 */
const privateUiRoots = [
  path.join(repositoryRoot, "packages", "gui"),
  path.join(repositoryRoot, "packages", "tui", "src", "ui"),
];
const privateTuiBridgeBaseNames = new Set([
  path.join(repositoryRoot, "packages", "tui", "src", "cli", "tui.ts"),
  path.join(repositoryRoot, "packages", "tui", "src", "cli", "tui.tsx"),
  path.join(repositoryRoot, "packages", "tui", "src", "cli", "tui.js"),
]);

/**
 * 判定一条模块说明符是否指向**私有 UI**。
 *
 * - 相对说明符 ⇒ 解析成绝对路径，再看是否落在 `packages/gui/**`、`packages/tui/src/ui/**`
 *   或 TUI 启动桥 `cli/tui.*`（因此 core 自己的 `src/gui/**` **不会**被误判）；
 * - 包名说明符 ⇒ 只拦 `public-gui` 与 `astarray-ui`。
 */
function isPrivateUiSpecifier(specifier: string, fromFilePath: string): boolean {
  if (specifier.startsWith(".")) {
    const resolvedPath = path.resolve(path.dirname(fromFilePath), specifier);
    const normalizedResolvedPath = resolvedPath.replaceAll("\\", "/");
    if (privateTuiBridgeBaseNames.has(resolvedPath)) return true;
    return privateUiRoots.some((uiRoot) => {
      const normalizedUiRoot = uiRoot.replaceAll("\\", "/");
      return (
        normalizedResolvedPath === normalizedUiRoot ||
        normalizedResolvedPath.startsWith(`${normalizedUiRoot}/`)
      );
    });
  }
  return specifier === "public-gui" || specifier.startsWith("astarray-ui");
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const filePaths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...(await listTypeScriptFiles(entryPath)));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      filePaths.push(entryPath);
    }
  }
  return filePaths;
}

function isPrivateUiFile(absoluteFilePath: string): boolean {
  const relativePath = path.relative(repositoryRoot, absoluteFilePath).replaceAll("\\", "/");
  return privateUiRelativePaths.some((excludedPath) =>
    excludedPath.endsWith("/")
      ? relativePath.startsWith(excludedPath)
      : relativePath === excludedPath,
  );
}

/** 从源码里抽取导入/动态导入的模块说明符（够用即可，不求完整 AST）。 */
function extractModuleSpecifiers(sourceText: string): string[] {
  const specifiers: string[] = [];
  const staticImportPattern = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g;
  const sideEffectImportPattern = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  const dynamicImportPattern = /import\(\s*["']([^"']+)["']/g;
  for (const pattern of [staticImportPattern, sideEffectImportPattern, dynamicImportPattern]) {
    for (const match of sourceText.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

async function collectPublicUiReferences(): Promise<Array<{ filePath: string; specifier: string }>> {
  const references: Array<{ filePath: string; specifier: string }> = [];
  for (const directory of publicSourceDirectories) {
    for (const filePath of await listTypeScriptFiles(directory)) {
      if (isPrivateUiFile(filePath)) continue;
      const sourceText = await fs.readFile(filePath, "utf8");
      for (const specifier of extractModuleSpecifiers(sourceText)) {
        if (!isPrivateUiSpecifier(specifier, filePath)) continue;
        references.push({
          filePath: path.relative(repositoryRoot, filePath).replaceAll("\\", "/"),
          specifier,
        });
      }
    }
  }
  return references;
}

describe("公开库 UI 边界（用户决策 2026-10-19：只有 CLI 在公开库）", () => {
  it("① 公开源码里的 UI 引用必须精确等于钉住的白名单（新增即红）", async () => {
    const references = await collectPublicUiReferences();
    const unexpected = references.filter(
      (reference) =>
        !pinnedUiSeamAllowlist.some(
          (allowedReference) =>
            allowedReference.filePath === reference.filePath &&
            reference.specifier.includes(allowedReference.specifierFragment),
        ),
    );
    expect(
      unexpected,
      `出现了新的 UI 引用（应迁到私有库 astarray-ui，而不是耦合进公开库）：${JSON.stringify(unexpected)}`,
    ).toEqual([]);
  });

  it("② 白名单条目必须仍然存在（迁走后要删条目，否则本测试变红提醒同步）", async () => {
    const references = await collectPublicUiReferences();
    for (const allowedReference of pinnedUiSeamAllowlist) {
      const isStillPresent = references.some(
        (reference) =>
          reference.filePath === allowedReference.filePath &&
          reference.specifier.includes(allowedReference.specifierFragment),
      );
      expect(
        isStillPresent,
        `白名单条目已不存在，请从 pinnedUiSeamAllowlist 删除：${allowedReference.filePath} → ${allowedReference.specifierFragment}`,
      ).toBe(true);
    }
  });

  it("③ 私有 UI 源码本身不计入公开边界（它们不属于公开库）", async () => {
    const uiDirectoryPath = path.join(repositoryRoot, "packages", "tui", "src", "ui");
    const exists = await fs
      .stat(uiDirectoryPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;
    for (const filePath of await listTypeScriptFiles(uiDirectoryPath)) {
      expect(isPrivateUiFile(filePath)).toBe(true);
    }
  });
});


