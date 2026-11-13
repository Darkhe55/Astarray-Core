/**
 * 可信宿主用户上下文（此前 `tests/` 零引用）。
 *
 * 契约只有一句但要紧：**解析不到就返回 null，调用方 fail-closed**；
 * 绝不能退回到某个固定身份（"user"/"anonymous"）或从环境变量猜。
 */
import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveHostUserIdentifier } from "../../../packages/core/src/core/host-user-context.js";

/** 一旦被当作"默认身份"返回，后续所有权限判定都会跟着错。 */
const FORBIDDEN_FALLBACK_IDENTIFIERS = ["user", "anonymous", "local", "unknown", "guest", "default", "me"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("宿主用户上下文", () => {
  it("① 正常环境 ⇒ 返回真实登录用户名（trim 后非空）", () => {
    const resolved = resolveHostUserIdentifier();
    if (resolved !== null) {
      expect(resolved).toBe(os.userInfo().username.trim());
      expect(resolved.length).toBeGreaterThan(0);
    }
  });

  it("② 绝不返回固定伪造身份", () => {
    const resolved = resolveHostUserIdentifier();
    if (resolved !== null) {
      expect(FORBIDDEN_FALLBACK_IDENTIFIERS).not.toContain(resolved.toLowerCase());
    }
  });

  it("③ 读取用户信息抛错 ⇒ null（不抛、不猜）", () => {
    vi.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("userInfo 不可用");
    });
    expect(resolveHostUserIdentifier()).toBeNull();
  });

  it("④ 用户名是空白 ⇒ null（空串不是身份）", () => {
    vi.spyOn(os, "userInfo").mockImplementation(
      () => ({ username: "   " }) as unknown as ReturnType<typeof os.userInfo>,
    );
    expect(resolveHostUserIdentifier()).toBeNull();
  });

  it("⑤ 用户名不是字符串 ⇒ null", () => {
    vi.spyOn(os, "userInfo").mockImplementation(
      () => ({ username: 12345 }) as unknown as ReturnType<typeof os.userInfo>,
    );
    expect(resolveHostUserIdentifier()).toBeNull();
  });

  it("⑥ 不从环境变量猜身份（改 USERNAME 不影响结果）", () => {
    const realResolved = resolveHostUserIdentifier();
    const previous = process.env["USERNAME"];
    process.env["USERNAME"] = "fabricated-from-env";
    try {
      expect(resolveHostUserIdentifier()).toBe(realResolved);
    } finally {
      if (previous === undefined) {
        delete process.env["USERNAME"];
      } else {
        process.env["USERNAME"] = previous;
      }
    }
  });
});
