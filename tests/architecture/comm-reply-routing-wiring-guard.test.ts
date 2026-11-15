/**
 * COMM-01 回复路由**装配守卫**（2026-11-15）。
 *
 * 判定层与守卫实现都已存在，但如果装配层忘了注入，回复就会退回"没有任何校验"的状态——
 * 具体表现是带 `replyToMessageIdentifier` 的消息被 fail-closed 拒绝（安全但不可用），
 * 或者更糟：有人为了"让它能用"而把守卫删掉。本守卫钉住"必须注入"。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

const RUNTIME_FILE_PATH = path.join(
  process.cwd(),
  "packages",
  "core",
  "src",
  "application",
  "application-runtime.ts",
);

describe("COMM-01 回复路由装配守卫", () => {
  it("① 运行时装配 inbox 时必须注入回复路由守卫", async () => {
    const content = await fs.readFile(RUNTIME_FILE_PATH, "utf8");
    const codeLines = content
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    const code = codeLines.join("\n");

    expect(code).toContain("new MailboxJournal(stateDirectory, {");
    expect(code).toContain("replyRoutingGuard: createInProjectReplyRoutingGuard({");
    /** 解析任务必须走任务链存储（按 mission 读），不得扫描全库或按默认对象推断。 */
    expect(code).toContain("readTaskChain(missionIdentifier)");
    /** 回退信箱按 mission 计算，与既有约定一致。 */
    expect(code).toContain("scheduler:${missionIdentifier}");
  }, 30_000);

  it("② 守卫自身仍在（防止守卫因改名胜空转）", async () => {
    const guardFilePath = path.join(
      process.cwd(),
      "packages",
      "core",
      "src",
      "orchestration",
      "in-project-reply-routing-guard.ts",
    );
    const content = await fs.readFile(guardFilePath, "utf8");
    expect(content).toContain("export function createInProjectReplyRoutingGuard");
    expect(content).toContain("evaluateInProjectReplyRouting(");
    expect(content).toContain("resolveFeedbackRecipient(");
  }, 30_000);
});

describe("COMM-01 回复路由：反馈子进程同样必须注入", () => {
  it("③ 子进程邮箱构造也必须带守卫（否则消息从这条路径绕过校验）", async () => {
    const entrypointFilePath = path.join(
      process.cwd(),
      "packages",
      "core",
      "src",
      "feedback-process",
      "entrypoint.ts",
    );
    const content = await fs.readFile(entrypointFilePath, "utf8");
    const codeLines = content
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    const code = codeLines.join("\n");

    expect(code).toContain("new MailboxJournal(baseDirectory, {");
    expect(code).toContain("replyRoutingGuard: createInProjectReplyRoutingGuard({");
    expect(code).toContain("readTaskChain(missionIdentifier)");
  }, 30_000);
});
