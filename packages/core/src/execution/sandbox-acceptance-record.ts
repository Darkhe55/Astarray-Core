/**
 * RELEASE-01-03（2026-11-24）：**受控执行验收记录**（干净设备可复现的诊断面）。
 *
 * B3 要求记录：OS、架构、后端、安装包版本、每项结果；缺对应设备/组件时如实记为待验证。
 * 本模块是**纯装配**（不探测进程、不写盘）：输入全部由调用方注入，便于确定性测试与脱敏。
 */
export type SandboxBackendKind = "sandbox-helper" | "bubblewrap" | null;

export interface SandboxAcceptanceComponent {
  readonly componentIdentifier: string;
  readonly status: "ok" | "missing" | "not-applicable";
  readonly detail: string;
}

export interface SandboxAcceptanceRecord {
  readonly schemaVersion: 1;
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly packageVersion: string | null;
  readonly applicationRootPath: string;
  readonly backendKind: SandboxBackendKind;
  readonly helperExecutablePath: string | null;
  readonly components: readonly SandboxAcceptanceComponent[];
  /** 唯一允许执行的判据：后端可用且组件齐全。 */
  readonly isExecutionAllowed: boolean;
  /** 面向操作者的下一步（缺失时给出构建/授权前置）。 */
  readonly nextActionText: string;
}

export function buildSandboxAcceptanceRecord(input: {
  readonly platform: string;
  readonly architecture: string;
  readonly nodeVersion: string;
  readonly packageVersion: string | null;
  readonly applicationRootPath: string;
  readonly backendKind: SandboxBackendKind;
  readonly helperExecutablePath: string | null;
}): SandboxAcceptanceRecord {
  const components: SandboxAcceptanceComponent[] = [];
  if (input.backendKind === "sandbox-helper") {
    components.push({
      componentIdentifier: "sandbox-helper",
      status: input.helperExecutablePath === null ? "missing" : "ok",
      detail:
        input.helperExecutablePath === null
          ? "未找到随包分发的 sandbox-helper.exe"
          : `已找到 ${input.helperExecutablePath}`,
    });
  } else if (input.backendKind === "bubblewrap") {
    components.push({
      componentIdentifier: "bubblewrap",
      status: "ok",
      detail: "Linux 平台使用系统提供的内存/命名空间隔离后端",
    });
  } else {
    components.push({
      componentIdentifier: "sandbox-backend",
      status: "not-applicable",
      detail: "当前平台/构建没有可用的隔离后端",
    });
  }

  const hasMissingComponent = components.some((component) => component.status === "missing");
  const isExecutionAllowed = input.backendKind !== null && !hasMissingComponent;
  const nextActionText = isExecutionAllowed
    ? "已具备受控执行后端；请按 B3 验收项逐条实测（写越界/网络/子进程/超时/限额/取消残留）。"
    : input.backendKind === "sandbox-helper"
      ? "缺少 sandbox-helper.exe：需安装 Rust/MSVC 工具链并构建（工具链安装按纪律单独授权）。"
      : "当前平台/架构无隔离后端：受控执行会被拒绝（不降级到宿主进程）；该平台记为未验证。";

  return {
    schemaVersion: 1,
    platform: input.platform,
    architecture: input.architecture,
    nodeVersion: input.nodeVersion,
    packageVersion: input.packageVersion,
    applicationRootPath: input.applicationRootPath,
    backendKind: input.backendKind,
    helperExecutablePath: input.helperExecutablePath,
    components,
    isExecutionAllowed,
    nextActionText,
  };
}
