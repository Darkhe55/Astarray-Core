/**
 * RESUME-02（2026-11-07，用户裁决版）：断点卡与显式续接。
 *
 * 语义：断点由**真实中断**派生（不是设置开关）；不点一直保留；终态留档。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

import {
  ContinuationController,
  ContinuationBreakpointStore,
  continuityBreakpointIdentifier,
  deriveContinuationBreakpoint,
  type ContinuationMissionFacts,
} from "../../../packages/core/src/orchestration/continuation-breakpoint.js";

const directories: string[] = [];
afterEach(async () => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

function facts(overrides: Partial<ContinuationMissionFacts> = {}): ContinuationMissionFacts {
  return {
    missionIdentifier: "mission-1",
    conversationIdentifier: "conversation-1",
    projectIdentifier: "project-1",
    prompt: "实现登录页的错误提示",
    status: "blocked",
    createdAtIso: "2026-11-07T01:00:00.000Z",
    hasTrustedCheckpoint: true,
    ...overrides,
  };
}

describe("断点派生", () => {
  it("运行中/已完成不是断点；阻塞中断是断点且可恢复", () => {
    expect(deriveContinuationBreakpoint(facts({ status: "running" }))).toBeNull();
    expect(deriveContinuationBreakpoint(facts({ status: "done" }))).toBeNull();
    const blocked = deriveContinuationBreakpoint(facts());
    expect(blocked?.status).toBe("open");
    expect(blocked?.canResume).toBe(true);
    expect(blocked?.taskShortName).toBe("实现登录页的错误提示");
    expect(blocked?.breakpointIdentifier).toBe(continuityBreakpointIdentifier("mission-1"));
  });

  it("无稳定会话不生成卡片；无检查点不可恢复；取消不可恢复", () => {
    expect(deriveContinuationBreakpoint(facts({ conversationIdentifier: null }))).toBeNull();
    const noCheckpoint = deriveContinuationBreakpoint(facts({ hasTrustedCheckpoint: false }));
    expect(noCheckpoint?.canResume).toBe(false);
    expect(noCheckpoint?.blockedReason).toContain("可信检查点");
    const cancelled = deriveContinuationBreakpoint(facts({ status: "cancelled" }));
    expect(cancelled?.canResume).toBe(false);
    expect(cancelled?.interruptionReason).toBe("mission-cancelled");
  });

  it("长提示词截断为任务短名（不是模型摘要）", () => {
    const longPrompt = "很长的任务描述".repeat(20);
    const view = deriveContinuationBreakpoint(facts({ prompt: longPrompt }));
    expect(view?.taskShortName.endsWith("…")).toBe(true);
    expect(view?.taskShortName.length).toBeLessThanOrEqual(41);
  });
});

describe("断点存储与续接控制器", () => {
  async function createController(
    resumeMission: (missionIdentifier: string) => Promise<void> = async () => {},
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), "astarray-breakpoint-"));
    directories.push(directory);
    const store = new ContinuationBreakpointStore({ baseDirectory: directory });
    const controller = new ContinuationController({
      store,
      readConversationMissions: async () => ["mission-1", "mission-2"],
      readMission: async (missionIdentifier) =>
        missionIdentifier === "mission-1"
          ? facts()
          : missionIdentifier === "mission-2"
            ? facts({ missionIdentifier: "mission-2", status: "done" })
            : null,
      hasTrustedCheckpoint: async () => true,
      resumeMission,
    });
    return { controller, store, directory };
  }

  it("按会话列出断点：只含真实中断（已完成不出现）", async () => {
    const { controller } = await createController();
    const views = await controller.listForConversation("conversation-1");
    expect(views).toHaveLength(1);
    expect(views[0]?.missionIdentifier).toBe("mission-1");
    expect(await controller.listForConversation("conversation-none")).toEqual([]);
  });

  it("点击恢复：转 resumed 并保留卡片；重复请求幂等", async () => {
    const resumeMission = vi.fn(async () => {});
    const { controller } = await createController(resumeMission);
    const [view] = await controller.listForConversation("conversation-1");
    const first = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-1",
    });
    expect(first.outcome).toBe("resumed");
    expect(first.breakpoint?.status).toBe("resumed");
    expect(resumeMission).toHaveBeenCalledTimes(1);

    const repeated = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-1",
    });
    expect(repeated.outcome).toBe("already-requested");
    expect(resumeMission).toHaveBeenCalledTimes(1);
  });

  it("revision 过期拒绝（不自动给新版本授权）", async () => {
    const { controller } = await createController();
    const [view] = await controller.listForConversation("conversation-1");
    const stale = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision + 5,
      requestIdentifier: "req-stale",
    });
    expect(stale.outcome).toBe("stale-revision");
    expect(stale.reason).toContain("刷新");
  });

  it("恢复被门禁拒绝 ⇒ 回到 open 并写明原因（不假装已恢复）", async () => {
    const { controller } = await createController(async () => {
      throw new Error("恢复被拒（先完成只读对账）");
    });
    const [view] = await controller.listForConversation("conversation-1");
    const result = await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-blocked",
    });
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("只读对账");
    expect(result.breakpoint?.status).toBe("open");
    expect(result.breakpoint?.canResume).toBe(true);
  });

  it("重启后卡片仍在（覆盖层 + 派生一致），不重复", async () => {
    const { controller, directory } = await createController();
    const [view] = await controller.listForConversation("conversation-1");
    await controller.requestContinuation({
      breakpointIdentifier: view!.breakpointIdentifier,
      missionIdentifier: "mission-1",
      expectedRevision: view!.revision,
      requestIdentifier: "req-restart",
    });
    const restartedStore = new ContinuationBreakpointStore({ baseDirectory: directory });
    const restarted = new ContinuationController({
      store: restartedStore,
      readConversationMissions: async () => ["mission-1"],
      readMission: async () => facts(),
      hasTrustedCheckpoint: async () => true,
      resumeMission: async () => {},
    });
    const views = await restarted.listForConversation("conversation-1");
    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe("resumed");
    expect(views[0]?.lastRequestIdentifier).toBe("req-restart");
  });

  it("不可恢复的断点：请求被拒且不调用恢复", async () => {
    const resumeMission = vi.fn(async () => {});
    const noCheckpoint = new ContinuationController({
      store: new ContinuationBreakpointStore({
        baseDirectory: await mkdtemp(path.join(tmpdir(), "astarray-breakpoint2-")),
      }),
      readConversationMissions: async () => ["mission-cancelled"],
      readMission: async () => facts({ missionIdentifier: "mission-cancelled", status: "cancelled" }),
      hasTrustedCheckpoint: async () => true,
      resumeMission,
    });
    const views = await noCheckpoint.listForConversation("conversation-1");
    const result = await noCheckpoint.requestContinuation({
      breakpointIdentifier: views[0]!.breakpointIdentifier,
      missionIdentifier: "mission-cancelled",
      expectedRevision: views[0]!.revision,
      requestIdentifier: "req-cancelled",
    });
    expect(result.outcome).toBe("not-resumable");
    expect(resumeMission).not.toHaveBeenCalled();
  });
});
