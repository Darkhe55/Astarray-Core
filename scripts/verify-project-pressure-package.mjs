#!/usr/bin/env node
/**
 * PROJECT-01-04 公开入口 + 多项目/多同级个体压力验收（2026-10-20）。
 *
 * 用法：node scripts/verify-project-pressure-package.mjs --package-dir <已安装包目录>
 *
 * 判据（对齐卡内"公开入口、授权列表、包级与多项目压力验收；A/B/C 项目及多个同级个体可追溯、
 * 不串数据；放权规则内无需人等，规则外不放行；**人工能分辨副本与原件**"）：
 * 1. **授权列表按项目/按接收个体过滤**：A→B 给 sib-1、sib-2 各一条 + A→C 一条 ⇒
 *    `filter(source=A)=3`、`filter(target=C)=1`、`filter(receiving=sib-1)=2` 且**互不串**；
 * 2. **规则内导入无需等人**：拿到授权即成功落盘（`imported-copy`），来源零写入（哈希不变）；
 * 3. **并发压力**：同一目标 6 路并发 ⇒ 只有 1 次真正写入，其余 `reused-existing-copy`，
 *    目标的副本回执**只有 1 条**（不重复记账）；
 * 4. **规则外不放行**：无授权导入 ⇒ `authorization-not-found` 且 `didWriteTarget=false`；
 * 5. **副本 ≠ 原件**：回执里来源/目标项目与路径不同，且**目标文件是副本**（内容相同但路径不同）。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-project-pressure-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const entryPath = path.join(packageRoot, "dist", "public-sdk.js");
try {
  await fs.access(entryPath);
} catch {
  process.stderr.write(`未找到公开入口：${entryPath}（需要先构建该包）\n`);
  process.exit(2);
}

const sdk = await import(new URL(`file://${entryPath.replaceAll("\\", "/")}`).href);
if (typeof sdk.AstarrayApplicationFacade !== "function") {
  process.stderr.write("已安装包未导出 AstarrayApplicationFacade\n");
  process.exit(1);
}

const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const failures = [];
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project-pressure-state-"));
const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-project-pressure-roots-"));

const projectA = { identifier: "project-a", root: path.join(projectsRoot, "a") };
const projectB = { identifier: "project-b", root: path.join(projectsRoot, "b") };
const projectC = { identifier: "project-c", root: path.join(projectsRoot, "c") };
for (const project of [projectA, projectB, projectC]) {
  await fs.mkdir(path.join(project.root, "docs"), { recursive: true });
}
const sourceFilePath = path.join(projectA.root, "docs", "spec.md");
const sourceContent = "# 共享规范\n\n这是 A 项目的原件。\n";
await fs.writeFile(sourceFilePath, sourceContent, "utf8");

const facade = await sdk.AstarrayApplicationFacade.create({
  stateDirectory,
  mode: "assist",
  runtime: "mock",
  concurrency: 4,
  failureThreshold: 3,
  maxLoopIterations: 1,
  useFeedbackProcess: false,
  crossProjectResourceIo: {
    readTextFile: (absolutePath) => fs.readFile(absolutePath, "utf8"),
    writeTextFile: (absolutePath, content) => fs.writeFile(absolutePath, content, "utf8"),
    ensureDirectory: async (absoluteDirectory) => {
      await fs.mkdir(absoluteDirectory, { recursive: true });
    },
    fileExists: async (absolutePath) => {
      try {
        await fs.stat(absolutePath);
        return true;
      } catch {
        return false;
      }
    },
  },
});

try {
  facade.createSession?.({ sessionId: "project-pressure", mode: "assist" });

  const grant = async (input) => {
    await facade.grantCrossProjectAuthorizationForAcceptance({
      sourceProjectRevision: 1,
      resourcePathPrefixes: ["docs/"],
      argumentsHash: "project-pressure-args",
      operationKind: "import-copy",
      ...input,
    });
  };

  await grant({
    authorizationIdentifier: "auth-a-b-sib1",
    sourceProjectIdentifier: projectA.identifier,
    targetProjectIdentifier: projectB.identifier,
    receivingAgentInstanceId: "sibling-1",
  });
  await grant({
    authorizationIdentifier: "auth-a-b-sib2",
    sourceProjectIdentifier: projectA.identifier,
    targetProjectIdentifier: projectB.identifier,
    receivingAgentInstanceId: "sibling-2",
  });
  await grant({
    authorizationIdentifier: "auth-a-c-sib1",
    sourceProjectIdentifier: projectA.identifier,
    targetProjectIdentifier: projectC.identifier,
    receivingAgentInstanceId: "sibling-1",
  });

  // ① 授权列表按项目/个体过滤，互不串
  const allAuthorizations = await facade.listCrossProjectAuthorizations();
  const bySourceA = await facade.listCrossProjectAuthorizations({
    sourceProjectIdentifier: projectA.identifier,
  });
  const byTargetC = await facade.listCrossProjectAuthorizations({
    targetProjectIdentifier: projectC.identifier,
  });
  const bySibling1 = await facade.listCrossProjectAuthorizations({
    receivingAgentInstanceId: "sibling-1",
  });
  const bySibling2 = await facade.listCrossProjectAuthorizations({
    receivingAgentInstanceId: "sibling-2",
  });

  if (allAuthorizations.length !== 3) {
    failures.push(`授权总数应为 3，实际 ${String(allAuthorizations.length)}`);
  }
  if (bySourceA.length !== 3) failures.push(`按来源 A 过滤应为 3，实际 ${String(bySourceA.length)}`);
  if (byTargetC.length !== 1) failures.push(`按目标 C 过滤应为 1，实际 ${String(byTargetC.length)}`);
  if (bySibling1.length !== 2) failures.push(`sib-1 应为 2 条，实际 ${String(bySibling1.length)}`);
  if (bySibling2.length !== 1) failures.push(`sib-2 应为 1 条，实际 ${String(bySibling2.length)}`);
  const sib1Ids = bySibling1.map((entry) => entry.authorizationIdentifier).sort();
  if (JSON.stringify(sib1Ids) !== JSON.stringify(["auth-a-b-sib1", "auth-a-c-sib1"])) {
    failures.push(`sib-1 的授权集合串了：${JSON.stringify(sib1Ids)}`);
  }

  // ② + ③ 规则内导入 + 并发压力
  const sourceHashBefore = sha256Text(await fs.readFile(sourceFilePath, "utf8"));
  const targetFilePath = path.join(projectB.root, "docs", "spec-copy.md");
  const importInput = {
    authorizationIdentifier: "auth-a-b-sib1",
    sourceProjectIdentifier: projectA.identifier,
    targetProjectIdentifier: projectB.identifier,
    sourceResourcePath: "docs/spec.md",
    targetResourcePath: "docs/spec-copy.md",
    absoluteSourcePath: sourceFilePath,
    absoluteTargetPath: targetFilePath,
    sourceProjectRootPath: projectA.root,
    targetProjectRootPath: projectB.root,
    sourceRevision: 1,
    argumentsHash: "project-pressure-args",
  };

  const concurrency = 6;
  const concurrentResults = await Promise.all(
    Array.from({ length: concurrency }, () => facade.importCrossProjectResource(importInput)),
  );
  const importedCount = concurrentResults.filter((result) => result.outcome === "imported-copy").length;
  const reusedCount = concurrentResults.filter((result) => result.outcome === "reused-existing-copy").length;
  if (importedCount !== 1) failures.push(`并发导入应只有 1 次真写入，实际 ${String(importedCount)}`);
  if (reusedCount !== concurrency - 1) {
    failures.push(`其余 ${String(concurrency - 1)} 次应为复用，实际 ${String(reusedCount)}`);
  }
  if (sha256Text(await fs.readFile(sourceFilePath, "utf8")) !== sourceHashBefore) {
    failures.push("来源文件被写入（应零写入）");
  }
  if ((await fs.readFile(targetFilePath, "utf8")) !== sourceContent) {
    failures.push("目标副本内容与来源不一致");
  }

  // 5 副本 ≠ 原件：回执可分辨
  const receipts = await facade.listCrossProjectCopyReceipts();
  const targetReceipts = receipts.filter((receipt) => receipt.targetResourcePath === "docs/spec-copy.md");
  if (targetReceipts.length !== 1) {
    failures.push(`目标副本回执应为 1 条（不重复记账），实际 ${String(targetReceipts.length)}`);
  }
  const receipt = targetReceipts[0];
  if (receipt !== undefined) {
    if (!(receipt.sourceResourcePath !== receipt.targetResourcePath)) {
      failures.push("回执未区分来源/目标路径（无法分辨副本与原件）");
    }
    if (receipt.sourceProjectIdentifier !== projectA.identifier || receipt.targetProjectIdentifier !== projectB.identifier) {
      failures.push("回执的项目标识不正确");
    }
  } else {
    failures.push("缺少副本回执");
  }

  // ④ 规则外不放行
  const unauthorized = await facade.importCrossProjectResource({
    ...importInput,
    authorizationIdentifier: "auth-does-not-exist",
    targetResourcePath: "docs/spec-copy-2.md",
    absoluteTargetPath: path.join(projectB.root, "docs", "spec-copy-2.md"),
  });
  if (unauthorized.outcome !== "authorization-not-found" || unauthorized.didWriteTarget !== false) {
    failures.push(
      `无授权导入应被拒绝，实际 outcome=${String(unauthorized.outcome)} didWriteTarget=${String(unauthorized.didWriteTarget)}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        authorizationCounts: {
          all: allAuthorizations.length,
          bySourceA: bySourceA.length,
          byTargetC: byTargetC.length,
          sibling1: bySibling1.length,
          sibling2: bySibling2.length,
        },
        concurrency,
        importedCount,
        reusedCount,
        copyReceiptCount: targetReceipts.length,
        unauthorizedOutcome: unauthorized.outcome,
        failures,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await facade.shutdown();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(projectsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`PROJECT 压力验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write("PROJECT 压力验收通过：授权按项目/个体隔离、并发只写一次、副本可分辨、规则外拒绝\n");
