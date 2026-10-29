#!/usr/bin/env node
/**
 * R13（2026-10-29）：**严格完成门禁的手工验收演练脚本**。
 *
 * ⚠️ 本脚本**从未运行**（窗口口径：不运行测试/验收）。提交它是为了让"授权后怎么验"
 * 有明确、可重复的步骤，而不是一句"应该能行"。
 *
 * 覆盖范围（**明确边界**）：
 * - 覆盖：完成收据与独立裁决的**存储层语义** —— 写入、幂等、拒绝覆盖、缺失判定，
 *   以及 `evaluateCompletionReceipt` 的"缺失即不足"。
 * - **不覆盖**：`MainController.projectMissionCompletionGate` 的完整 mission 上下文
 *   （需要真实运行时、任务链与调度器）。那一步仍需人工在本机跑一次 assist mission。
 *
 * 用法（在 `astarray/` 下，**先 `npm run build`**）：
 *   node scripts/manual/strict-completion-drill.mjs
 * 退出码：0 全过；1 有断言失败（会打印具体哪一条）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CompletionReceiptStore,
  CompletionVerdictStore,
  evaluateCompletionReceipt,
} from "../../dist/public-sdk.js";

const missionIdentifier = "drill-mission";
const taskIdentifiers = ["drill-task-1", "drill-task-2"];

const failures = [];
function check(description, condition) {
  if (!condition) {
    failures.push(description);
    process.stdout.write(`FAIL  ${description}\n`);
  } else {
    process.stdout.write(`ok    ${description}\n`);
  }
}

const stateDirectory = await mkdtemp(path.join(tmpdir(), "astarray-drill-"));
process.stdout.write(`state: ${stateDirectory}\n`);

try {
  const receiptStore = new CompletionReceiptStore({ baseDirectory: stateDirectory });
  const verdictStore = new CompletionVerdictStore({ baseDirectory: stateDirectory });

  // 场景 1：正常通过（两个任务都有收据 + accepted 裁决）
  for (const taskIdentifier of taskIdentifiers) {
    await receiptStore.save({
      missionIdentifier,
      taskIdentifier,
      hasVerifiedCompletionControlEvent: true,
      toolCallCount: 2,
      artifactPaths: [`artifacts/${taskIdentifier}.txt`],
      recordedAtIso: new Date().toISOString(),
    });
    await verdictStore.save({
      missionIdentifier,
      taskIdentifier,
      verdict: "accepted",
      reasons: ["独立验收通过"],
      deciderAgentInstanceIdentifier: "agent-acceptor-1",
      decidedAtIso: new Date().toISOString(),
    });
  }
  for (const taskIdentifier of taskIdentifiers) {
    const receipt = await receiptStore.read(missionIdentifier, taskIdentifier);
    const evaluation = evaluateCompletionReceipt({
      receipt,
      requiresCompletionControlEvent: true,
    });
    check(`收据齐备且足够: ${taskIdentifier}`, evaluation.isSufficient);
    const verdict = await verdictStore.read(missionIdentifier, taskIdentifier);
    check(`裁决为 accepted: ${taskIdentifier}`, verdict?.verdict === "accepted");
  }

  // 场景 2：缺收据 ⇒ 不足（不补默认收据）
  const missingReceiptEvaluation = evaluateCompletionReceipt({
    receipt: await receiptStore.read(missionIdentifier, "drill-task-missing"),
    requiresCompletionControlEvent: true,
  });
  check("缺收据 ⇒ 判定不足", missingReceiptEvaluation.isSufficient === false);

  // 场景 3：缺裁决 ⇒ read 返回 null（门禁按缺裁决阻断）
  const missingVerdict = await verdictStore.read(missionIdentifier, "drill-task-missing");
  check("缺裁决 ⇒ read 为 null", missingVerdict === null);

  // 场景 4：拒绝裁决可读回且理由非空（rejected 必须带理由已被 store 强制）
  await verdictStore.save({
    missionIdentifier,
    taskIdentifier: "drill-task-1",
    verdict: "rejected",
    reasons: ["verdict:rework", "缺少集成测试"],
    deciderAgentInstanceIdentifier: "agent-acceptor-1",
    decidedAtIso: new Date().toISOString(),
  }).then(
    () => {
      // 若这条不抛错，说明"不同内容拒绝覆盖"没有生效 —— 这是反例
      failures.push("同任务不同内容应拒绝覆盖，但写入成功了");
      process.stdout.write("FAIL  同任务不同内容应拒绝覆盖\n");
    },
    (error) => {
      check(
        "同任务不同内容拒绝覆盖",
        String(error?.message ?? "").includes("拒绝覆盖"),
      );
    },
  );
} finally {
  await rm(stateDirectory, { recursive: true, force: true });
}

process.stdout.write(
  failures.length === 0
    ? "\nALL CHECKS PASSED（仅覆盖存储层；完整门禁仍需人工 mission 验收）\n"
    : `\n${failures.length} CHECK(S) FAILED\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
