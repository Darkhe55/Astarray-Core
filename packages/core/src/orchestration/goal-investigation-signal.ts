/**
 * R141（2026-11-03）：**调查组的本地信号（B3）**。
 *
 * 产品定义（本仓库采用，已写入 ADR-0198）：
 * 一个组是 `investigation`，当且仅当它**启动的全部任务**都声明了非空工具列表，
 * 且这些工具在权限能力目录里**只映射到只读能力**（`*.read` / `git.read` / `backup.list` 等）。
 *
 * 保守取向：
 * - 任务没声明工具 ⇒ 不算调查组（无法判断）；
 * - 任一工具未映射或含写能力 ⇒ 不算；
 * - 混合读写工具 ⇒ 不算（不把写操作伪装成调查）。
 */
import { PermissionCapabilityCatalog } from "../tools/permission-capability-catalog.js";

const READ_ONLY_CAPABILITY_IDS = new Set(["backup.list", "git.read", "task.read"]);

const catalog = new PermissionCapabilityCatalog();

/** 单个工具是否只读（未映射 ⇒ false，保守）。 */
export function isReadOnlyToolName(toolName: string): boolean {
  const capabilityIds = catalog.getToolCapabilityIds(toolName);
  if (capabilityIds.length === 0) {
    return false;
  }
  return capabilityIds.every(
    (capabilityId) =>
      capabilityId.endsWith(".read") || READ_ONLY_CAPABILITY_IDS.has(capabilityId),
  );
}

/**
 * 一组任务是否构成调查组（全部只读且都有工具声明）。
 */
export function isInvestigationTaskGroup(input: {
  readonly taskToolNames: readonly (readonly string[])[];
}): boolean {
  if (input.taskToolNames.length === 0) {
    return false;
  }
  return input.taskToolNames.every(
    (toolNames) =>
      toolNames.length > 0 && toolNames.every((toolName) => isReadOnlyToolName(toolName)),
  );
}
