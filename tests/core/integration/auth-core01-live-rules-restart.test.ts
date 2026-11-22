/**
 * AUTH-CORE-01 第 5 项（2026-11-22）：**生产装配 + 规则热生效 + 重启恢复**。
 *
 * 这里不依赖内部纯函数：从公开设置入口保存规则，再经**真实运行时装配**的
 * 判定侧引擎裁决；同进程下一次调用生效；关闭后重新装配仍读取同一份落盘规则。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AstarrayApplicationFacade } from "../../../packages/core/src/public-sdk.js";

interface PermissionDecidingEngine {
  decide(input: {
    toolName: string;
    action?: string;
    profileReference: unknown;
    argumentsJson: string;
  }): Promise<{ decision: string }>;
}

let temporaryDirectory: string;

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-authcore01-live-"));
});

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function readEngine(application: AstarrayApplicationFacade): PermissionDecidingEngine {
  const engine = (
    application as unknown as {
      runtime: {
        controller: {
          options: { configurablePermissionPolicyEngine?: PermissionDecidingEngine };
        };
      };
    }
  ).runtime.controller.options.configurablePermissionPolicyEngine;
  expect(engine).toBeDefined();
  return engine as PermissionDecidingEngine;
}

async function createApplication(stateDirectory: string): Promise<AstarrayApplicationFacade> {
  const application = await AstarrayApplicationFacade.create({
    stateDirectory,
    mode: "assist",
    runtime: "mock",
    useFeedbackProcess: false,
    statusPollIntervalMilliseconds: 10,
  });
  application.createSession({ sessionId: "session-1", mode: "assist" });
  return application;
}

describe("AUTH-CORE-01：生产装配的规则热生效与重启恢复", () => {
  it("① 保存规则后下一次调用生效；重启后仍生效", async () => {
    const stateDirectory = path.join(temporaryDirectory, ".astarray");
    const firstApplication = await createApplication(stateDirectory);
    try {
      const profileReference = await firstApplication.getCurrentPermissionProfileReference();
      expect(profileReference).not.toBeNull();
      const engine = readEngine(firstApplication);
      const argumentsJson = JSON.stringify({ sequenceId: "seq-1" });
      const decide = () =>
        engine.decide({
          toolName: "taskSequenceStatus",
          action: "state-query",
          profileReference,
          argumentsJson,
        });

      /** 初始无规则：assist 下 task.read 为 allow。 */
      expect((await decide()).decision).toBe("allow");

      /** 从公开设置入口保存一条 ask 规则（窄化，不需要"放宽确认"）。 */
      const saved = await firstApplication.updateParameterAuthorizationRules({
        isParameterAuthorizationEnabled: true,
        isParameterRulesEnabled: true,
        rules: [
          {
            ruleIdentifier: "rule-live-1",
            toolName: "taskSequenceStatus",
            action: "",
            decision: "ask",
            explanation: "生产热生效探针：该工具所有 action 要求确认",
          },
        ],
        expectedRevision: 0,
        isConfirmedByAuthenticatedUser: false,
      });
      expect(saved.status).toBe("saved");

      /** 同一进程、同一引擎：下一次调用即生效（不需要重启）。 */
      expect((await decide()).decision).toBe("ask");
    } finally {
      await firstApplication.shutdown();
    }

    /** 重启：新装配仍读取同一份落盘规则。 */
    const secondApplication = await createApplication(stateDirectory);
    try {
      const profileReference = await secondApplication.getCurrentPermissionProfileReference();
      const engine = readEngine(secondApplication);
      const outcome = await engine.decide({
        toolName: "taskSequenceStatus",
        action: "state-query",
        profileReference,
        argumentsJson: JSON.stringify({ sequenceId: "seq-1" }),
      });
      expect(outcome.decision).toBe("ask");
    } finally {
      await secondApplication.shutdown();
    }
  });
});
