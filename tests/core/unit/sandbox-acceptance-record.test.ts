/**
 * RELEASE-01-03（2026-11-24）：受控执行验收记录的反例。
 *
 * 记录必须如实反映"后端是否可用"：缺 helper/Missing 组件 ⇒ 不可执行，并给出可执行下一步；
 * 不允许"平台无后端但显示可执行"。
 */
import { describe, expect, it } from "vitest";

import {
  buildSandboxAcceptanceRecord,
} from "../../../packages/core/src/execution/sandbox-acceptance-record.js";

const base = {
  platform: "win32",
  architecture: "x64",
  nodeVersion: "v26.13.1",
  packageVersion: "0.1.0",
  applicationRootPath: "C:/install/astarray",
  helperExecutablePath: "C:/install/astarray/native/sandbox-helper/sandbox-helper.exe",
  backendKind: "sandbox-helper" as const,
};

describe("RELEASE-01-03：验收记录", () => {
  it("① helper 存在 ⇒ 可执行，并记录 OS/架构/版本/后端", () => {
    const record = buildSandboxAcceptanceRecord(base);
    expect(record).toMatchObject({
      platform: "win32",
      architecture: "x64",
      packageVersion: "0.1.0",
      backendKind: "sandbox-helper",
      isExecutionAllowed: true,
    });
    expect(record.components[0]).toMatchObject({ status: "ok" });
  });

  it("② 缺 helper ⇒ 不可执行，下一步指明需要工具链构建", () => {
    const record = buildSandboxAcceptanceRecord({ ...base, backendKind: null, helperExecutablePath: null });
    expect(record.isExecutionAllowed).toBe(false);
    expect(record.components[0]?.status).toBe("not-applicable");
    expect(record.nextActionText).toContain("拒绝");
  });

  it("③ backend 声明为 helper 但路径为空 ⇒ missing 组件且不可执行", () => {
    const record = buildSandboxAcceptanceRecord({ ...base, helperExecutablePath: null });
    expect(record.isExecutionAllowed).toBe(false);
    expect(record.components[0]).toMatchObject({ status: "missing" });
    expect(record.nextActionText).toContain("Rust/MSVC");
  });

  it("④ linux ⇒ bubblewrap 组件；无版本号也能记录（null）", () => {
    const record = buildSandboxAcceptanceRecord({
      ...base,
      platform: "linux",
      backendKind: "bubblewrap",
      helperExecutablePath: null,
      packageVersion: null,
    });
    expect(record.backendKind).toBe("bubblewrap");
    expect(record.packageVersion).toBeNull();
    expect(record.isExecutionAllowed).toBe(true);
    expect(record.components[0]?.componentIdentifier).toBe("bubblewrap");
  });
});
