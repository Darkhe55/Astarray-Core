/**
 * 反馈子进程引导（此前 `tests/` 零引用）：**只在被 fork 的反馈子进程里**启动入口。
 *
 * 三条闸门必须同时满足才启动，任一不满足都**什么都别做**——
 * 否则主进程或普通 CLI 会意外跑起反馈循环。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runFeedbackProcessEntry = vi.fn();
const isNodeJsProcess = vi.fn(() => true);

vi.mock("../../../packages/core/src/feedback-process/entrypoint.js", () => ({
  isNodeJsProcess,
  runFeedbackProcessEntry,
}));

const originalFeedbackChildFlag = process.env["ASTARRAY_FEEDBACK_CHILD"];
const originalStateDirectory = process.env["ASTARRAY_STATE_DIRECTORY"];
const originalSend = (process as unknown as { send?: unknown }).send;

async function importBootstrap(): Promise<void> {
  vi.resetModules();
  await import("../../../packages/core/src/feedback-process/child-bootstrap.js");
}

beforeEach(() => {
  runFeedbackProcessEntry.mockReset();
  isNodeJsProcess.mockReset();
  isNodeJsProcess.mockReturnValue(true);
  (process as unknown as { send: unknown }).send = () => undefined;
  process.env["ASTARRAY_FEEDBACK_CHILD"] = "1";
  delete process.env["ASTARRAY_STATE_DIRECTORY"];
});

afterEach(() => {
  if (originalFeedbackChildFlag === undefined) delete process.env["ASTARRAY_FEEDBACK_CHILD"];
  else process.env["ASTARRAY_FEEDBACK_CHILD"] = originalFeedbackChildFlag;
  if (originalStateDirectory === undefined) delete process.env["ASTARRAY_STATE_DIRECTORY"];
  else process.env["ASTARRAY_STATE_DIRECTORY"] = originalStateDirectory;
  (process as unknown as { send?: unknown }).send = originalSend;
});

describe("反馈子进程引导", () => {
  it("① 三条闸门都满足 ⇒ 启动入口，默认状态目录为 .astarray", async () => {
    await importBootstrap();
    expect(runFeedbackProcessEntry).toHaveBeenCalledTimes(1);
    expect(runFeedbackProcessEntry.mock.calls[0]?.[1]).toEqual({
      defaultBaseDirectory: ".astarray",
    });
  });

  it("② 状态目录由 ASTARRAY_STATE_DIRECTORY 给出", async () => {
    process.env["ASTARRAY_STATE_DIRECTORY"] = "/tmp/astarray-state";
    await importBootstrap();
    expect(runFeedbackProcessEntry.mock.calls[0]?.[1]).toEqual({
      defaultBaseDirectory: "/tmp/astarray-state",
    });
  });

  it("③ 缺 ASTARRAY_FEEDBACK_CHILD=1 ⇒ 不启动", async () => {
    delete process.env["ASTARRAY_FEEDBACK_CHILD"];
    await importBootstrap();
    expect(runFeedbackProcessEntry).not.toHaveBeenCalled();
  });

  it("④ 标志不是 1 ⇒ 不启动", async () => {
    process.env["ASTARRAY_FEEDBACK_CHILD"] = "true";
    await importBootstrap();
    expect(runFeedbackProcessEntry).not.toHaveBeenCalled();
  });

  it("⑤ 没有 process.send（不是被 fork 的子进程）⇒ 不启动", async () => {
    delete (process as unknown as { send?: unknown }).send;
    await importBootstrap();
    expect(runFeedbackProcessEntry).not.toHaveBeenCalled();
  });

  it("⑥ 不是 Node 进程（跨运行时）⇒ 不启动", async () => {
    isNodeJsProcess.mockReturnValue(false);
    await importBootstrap();
    expect(runFeedbackProcessEntry).not.toHaveBeenCalled();
  });
});
