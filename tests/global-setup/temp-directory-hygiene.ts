/**
 * 测试临时目录卫生（TEMP hygiene）。
 *
 * 背景：`npm run check:low-parallel` 的用例大量使用
 * `fs.mkdtemp(path.join(os.tmpdir(), "astarray-…-"))`。部分用例没有清理，
 * 或者在断言失败/超时/子进程被 SIGKILL 时来不及跑 `afterEach`，
 * 于是每次全量都会在系统 TEMP 留下几十个目录（实测约 70 个/次，几天累积到 7000+）。
 *
 * 本模块在**测试主进程**里按"开跑前清扫 + 跑完回收"两段处理，
 * 不依赖每个用例是否写了 `afterEach`：
 *
 * - `beginRun()`：删除**早于 staleAge** 的历史目录（覆盖"上次运行被杀"留下的残骸），
 *   并快照当前目录名集合；
 * - `endRun()`：删除**本次运行新出现**的目录（覆盖"用例没写清理"与"worker 被杀"），
 *   基线内的目录一律不动（不误删别人的数据）。
 *
 * 只处理 `baseDirectory` 下**文件名匹配给定前缀**的目录；其它目录一概不碰。
 */
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

export interface TempDirectoryHygieneOptions {
  /** 扫描目录（通常是 `os.tmpdir()`）。 */
  readonly baseDirectory: string;
  /** 需要处理的目录名前缀（如 `astarray-`）。 */
  readonly directoryNamePrefixes: readonly string[];
  /** 视为"陈旧历史残骸"的最小年龄（毫秒）。 */
  readonly staleAgeMilliseconds: number;
  /** 时钟注入（测试用）。 */
  readonly nowMilliseconds?: () => number;
}

export interface TempDirectoryHygieneRunResult {
  readonly removedStaleDirectoryCount: number;
  readonly baselineDirectoryCount: number;
}

export interface TempDirectoryHygieneEndResult {
  readonly removedCreatedDirectoryCount: number;
  readonly remainingDirectoryCount: number;
}

export interface TempDirectoryHygiene {
  readonly beginRun: () => Promise<TempDirectoryHygieneRunResult>;
  readonly endRun: () => Promise<TempDirectoryHygieneEndResult>;
}

function isTargetDirectoryName(
  directoryName: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some((prefix) => directoryName.startsWith(prefix));
}

async function listTargetDirectories(
  options: TempDirectoryHygieneOptions,
): Promise<Array<{ name: string; path: string; modifiedAtMilliseconds: number }>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(options.baseDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: Array<{ name: string; path: string; modifiedAtMilliseconds: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!isTargetDirectoryName(entry.name, options.directoryNamePrefixes)) {
      continue;
    }
    const entryPath = path.join(options.baseDirectory, entry.name);
    let modifiedAtMilliseconds: number;
    try {
      const stats = await fs.stat(entryPath);
      modifiedAtMilliseconds = stats.mtimeMs;
    } catch {
      continue;
    }
    targets.push({ name: entry.name, path: entryPath, modifiedAtMilliseconds });
  }
  return targets;
}

async function removeDirectoryQuietly(directoryPath: string): Promise<boolean> {
  try {
    await fs.rm(directoryPath, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    /** 残留目录删不掉（被占用/权限）不应让整轮测试失败。 */
    return false;
  }
}

export function createTempDirectoryHygiene(
  options: TempDirectoryHygieneOptions,
): TempDirectoryHygiene {
  const nowMilliseconds = options.nowMilliseconds ?? (() => Date.now());
  let baselineDirectoryNames: ReadonlySet<string> | null = null;

  return {
    beginRun: async () => {
      const now = nowMilliseconds();
      const directories = await listTargetDirectories(options);
      let removedStaleDirectoryCount = 0;
      for (const directory of directories) {
        const ageMilliseconds = now - directory.modifiedAtMilliseconds;
        if (ageMilliseconds < options.staleAgeMilliseconds) {
          continue;
        }
        if (await removeDirectoryQuietly(directory.path)) {
          removedStaleDirectoryCount += 1;
        }
      }
      /** 清理后重新快照：被删掉的陈旧目录不应被算作"本次基线"。 */
      const remainingDirectories = await listTargetDirectories(options);
      baselineDirectoryNames = new Set(remainingDirectories.map((directory) => directory.name));
      return {
        removedStaleDirectoryCount,
        baselineDirectoryCount: baselineDirectoryNames.size,
      };
    },

    endRun: async () => {
      const directories = await listTargetDirectories(options);
      const baseline = baselineDirectoryNames ?? new Set<string>();
      let removedCreatedDirectoryCount = 0;
      for (const directory of directories) {
        if (baseline.has(directory.name)) {
          continue;
        }
        if (await removeDirectoryQuietly(directory.path)) {
          removedCreatedDirectoryCount += 1;
        }
      }
      const remainingDirectories = await listTargetDirectories(options);
      return {
        removedCreatedDirectoryCount,
        remainingDirectoryCount: remainingDirectories.length,
      };
    },
  };
}
