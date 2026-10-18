/**
 * RELOCATE-01：**位置登记的持久化存储**（2026-10-18 第 18 轮）。
 *
 * 这是把前三个检查点的纯模块接到产品的必要构件：
 * - 读写都在 `baseDirectory` 内（不碰项目目录之外的路径）；
 * - 写入**先备份**（`<id>.backup-r<revision>.json`）再原子 rename；
 * - 读取时区分 absent / invalid（JSON 坏）/ legacy / valid —— **不修补、不猜测**。
 */
import { promises as fs } from "node:fs";

import { backupExistingFile, writeAtomicJson } from "../infra/atomic-json.js";
import path from "node:path";

import {
  parseProjectLocationRegistration,
  type ProjectLocationRegistrationV1,
} from "./project-location-registration.js";

/** 读取结论（与 schema 解析结论一致，外加"文件不存在"）。 */
export type ProjectLocationRegistrationReadOutcome =
  | { readonly kind: "absent"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "legacy"; readonly reason: string }
  | { readonly kind: "valid"; readonly registration: ProjectLocationRegistrationV1 };

/** 登记存储（每项目一份文件，独立备份目录）。 */
export class ProjectLocationRegistrationStore {
  private readonly registrationRootDirectory: string;
  private readonly backupRootDirectory: string;

  constructor(options: { readonly baseDirectory: string }) {
    this.registrationRootDirectory = path.join(options.baseDirectory, "project-location");
    this.backupRootDirectory = path.join(options.baseDirectory, "project-location-backups");
  }

  private registrationFilePath(projectIdentifier: string): string {
    return path.join(this.registrationRootDirectory, sanitizePathSegment(projectIdentifier) + ".json");
  }

  private backupFilePath(projectIdentifier: string, locationRevision: number): string {
    return path.join(
      this.backupRootDirectory,
      sanitizePathSegment(projectIdentifier) + ".backup-r" + String(locationRevision) + ".json",
    );
  }

  /** 读取某项目的登记。文件不存在 ⇒ absent；JSON 坏 ⇒ invalid（不当作空）。 */
  async read(projectIdentifier: string): Promise<ProjectLocationRegistrationReadOutcome> {
    const filePath = this.registrationFilePath(projectIdentifier);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "absent", reason: "该项目没有位置登记文件。" };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return { kind: "invalid", reason: "登记文件不是合法 JSON；需按待恢复处理，不伪称验证成功。" };
    }

    return parseProjectLocationRegistration(parsed);
  }

  /**
   * 写入新登记：**先备份旧文件（若存在）→ 写临时文件 → 原子 rename**。
   * 任何一步失败都不留下"半写"的登记文件。
   */
  async writeWithBackup(nextRegistration: ProjectLocationRegistrationV1): Promise<void> {
    await fs.mkdir(this.registrationRootDirectory, { recursive: true });
    const filePath = this.registrationFilePath(nextRegistration.projectIdentifier);

    // ① 备份现有登记（若存在）——由白名单原子写模块完成（架构守卫 T12-05）
    try {
      const existing = await fs.readFile(filePath, "utf8");
      const parsedExisting = JSON.parse(existing) as { locationRevision?: number };
      const existingRevision =
        typeof parsedExisting.locationRevision === "number" ? parsedExisting.locationRevision : 0;
      await fs.mkdir(this.backupRootDirectory, { recursive: true });
      await backupExistingFile(
        filePath,
        this.backupFilePath(nextRegistration.projectIdentifier, existingRevision),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 首次写入：没有旧文件可备份
    }

    // ② 原子写（临时文件 → fsync → rename），复用已被白名单的模块
    await writeAtomicJson(filePath, nextRegistration);
  }
}

/** 把标识压成安全文件名（与仓库既有做法一致：替换非法字符）。 */
function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 96);
  return sanitized === "" ? "unnamed" : sanitized;
}
