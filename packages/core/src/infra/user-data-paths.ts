/**
 * Windows/跨平台标准用户数据目录（2026-10-25）。
 *
 * 口径：
 * - 默认 `${LOCALAPPDATA}\Astarray`（Windows；macOS/Linux 用对应标准目录）；
 * - 状态 `state/`（任务链、历史、凭据引用、设置等），CLI 与 GUI 共用同一份；
 * - 允许 `ASTARRAY_DATA_DIR` 覆盖（测试/便携模式）。
 *
 * 测试兼容：Vitest 及其子进程（`VITEST=true`）沿用 `cwd/.astarray`，
 * 避免测试污染真实用户数据；这是**仅测试**的兼容分支。
 */
import os from "node:os";
import path from "node:path";

export function astarrayDataDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const override = environment["ASTARRAY_DATA_DIR"]?.trim();
  if (override !== undefined && override !== "") {
    return path.resolve(override);
  }
  if (environment["VITEST"] === "true" || environment["VITEST"] === "1") {
    return path.join(process.cwd(), ".astarray");
  }
  if (process.platform === "win32") {
    const localAppData =
      environment["LOCALAPPDATA"]?.trim() ||
      path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Astarray");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Astarray");
  }
  const xdgDataHome =
    environment["XDG_DATA_HOME"]?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(xdgDataHome, "astarray");
}

/** CLI 与 GUI 共用的状态目录（任务链、历史、设置、凭据引用）。 */
export function astarrayStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  // 测试兼容：历史原因测试把状态直接放在 `cwd/.astarray`（不是 `cwd/.astarray/state`）。
  if (
    (environment["VITEST"] === "true" || environment["VITEST"] === "1") &&
    (environment["ASTARRAY_DATA_DIR"] === undefined ||
      environment["ASTARRAY_DATA_DIR"].trim() === "")
  ) {
    return astarrayDataDirectory(environment);
  }
  return path.join(astarrayDataDirectory(environment), "state");
}

