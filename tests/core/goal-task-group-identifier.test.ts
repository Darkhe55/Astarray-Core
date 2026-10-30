/**
 * R64（2026-10-30）：组标识生成的单测。
 *
 * 只测纯函数：时间戳格式、序号与令牌校验、可注入令牌，以及"同秒同序号不同令牌 ⇒ 不同标识"。
 */
import { describe, expect, it } from "vitest";

import {
  buildGoalTaskGroupIdentifier,
  toGoalTaskGroupRunTag,
} from "../../packages/core/src/orchestration/goal-task-group-identifier.js";

describe("toGoalTaskGroupRunTag", () => {
  it("把 ISO 时间转成 14 位 UTC 串", () => {
    expect(toGoalTaskGroupRunTag("2026-10-30T11:22:33.456Z")).toBe("20261030112233");
  });

  it("非法时间抛错（不静默替换为当前时间）", () => {
    expect(() => toGoalTaskGroupRunTag("not-a-date")).toThrow();
  });
});

describe("buildGoalTaskGroupIdentifier", () => {
  it("格式：goal-group-<UTC14>-<序号>-<8 位令牌>", () => {
    expect(
      buildGoalTaskGroupIdentifier({
        startedAtIso: "2026-10-30T11:22:33.000Z",
        sequenceNumber: 3,
        randomToken: "0a1b2c3d",
      }),
    ).toBe("goal-group-20261030112233-3-0a1b2c3d");
  });

  it("同秒同序号、不同令牌 ⇒ 不同标识（避免重启撞名）", () => {
    const first = buildGoalTaskGroupIdentifier({
      startedAtIso: "2026-10-30T11:22:33.000Z",
      sequenceNumber: 1,
      randomToken: "aaaaaaaa",
    });
    const second = buildGoalTaskGroupIdentifier({
      startedAtIso: "2026-10-30T11:22:33.000Z",
      sequenceNumber: 1,
      randomToken: "bbbbbbbb",
    });
    expect(first).not.toBe(second);
  });

  it("缺省随机令牌也是合法格式", () => {
    const identifier = buildGoalTaskGroupIdentifier({
      startedAtIso: "2026-10-30T11:22:33.000Z",
      sequenceNumber: 2,
    });
    expect(identifier).toMatch(/^goal-group-\d{14}-2-[0-9a-f]{8}$/);
  });

  it("序号非法或令牌格式不对 ⇒ 抛错", () => {
    expect(() =>
      buildGoalTaskGroupIdentifier({
        startedAtIso: "2026-10-30T11:22:33.000Z",
        sequenceNumber: 0,
      }),
    ).toThrow();
    expect(() =>
      buildGoalTaskGroupIdentifier({
        startedAtIso: "2026-10-30T11:22:33.000Z",
        sequenceNumber: 1,
        randomToken: "NOT-HEX!",
      }),
    ).toThrow();
  });
});
