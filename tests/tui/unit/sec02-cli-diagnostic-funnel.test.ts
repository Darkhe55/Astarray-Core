/**
 * SEC-02 通道 14（2026-11-09）：**诊断输出唯一漏斗**。
 *
 * 真实缺陷：`logToStderr` 把拼好的文本**原样**写到 stderr。
 * CLI 的报错文本里会拼进异常消息、子进程 stderr、工具输出 —— 其中可能含
 * 换行（可伪造额外日志行）与凭据（直接落到终端/日志文件）。
 */
import { describe, expect, it, vi } from "vitest";

import { logToStderr } from "../../../packages/tui/src/cli/json-output.js";

vi.setConfig({ testTimeout: 30_000 });

/** 捕获 stderr 实际写出的内容。 */
function captureStderr(action: () => void): string {
  const chunks: string[] = [];
  const writeSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  try {
    action();
  } finally {
    writeSpy.mockRestore();
  }
  return chunks.join("");
}

describe("SEC-02 CLI 诊断输出漏斗", () => {
  it("凭据不得原样落到 stderr", () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const written = captureStderr(() => {
      logToStderr("请求失败 token=" + secret);
    });
    expect(written).not.toContain(secret);
    expect(written).toContain("[REDACTED]");
  });

  it("换行被转义 ⇒ 不能伪造额外日志行", () => {
    const written = captureStderr(() => {
      logToStderr("第一行\nastarray: 伪造的第二行");
    });
    /** 只允许漏斗自己那一个换行结尾。 */
    expect(written.trimEnd().split("\n")).toHaveLength(1);
    expect(written).toContain("\\n");
  });

  it("超长文本被有界截断", () => {
    const written = captureStderr(() => {
      logToStderr("x".repeat(5_000));
    });
    expect(written.length).toBeLessThan(2_200);
  });

  it("ANSI 转义被剥离 ⇒ 不能覆盖已显示的报错", () => {
    /** 清屏 + 光标回原点：可让"失败"看起来像"成功"。 */
    const written = captureStderr(() => {
      logToStderr("\u001B[2J\u001B[H全部通过");
    });
    expect(written).not.toContain("\u001B");
    expect(written).toContain("全部通过");
  });

  it("普通文本保持可读（不误伤）", () => {
    const written = captureStderr(() => {
      logToStderr("跨项目只读失败: 授权已过期");
    });
    expect(written).toBe("astarray: 跨项目只读失败: 授权已过期\n");
  });
});
