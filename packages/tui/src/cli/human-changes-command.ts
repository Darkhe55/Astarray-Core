import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * REPAIR（17 项分诊 · `HumanWorktreeObserver`）：**只读展示入口**。
 *
 * 观察器此前"写端从未构造 ⇒ journal 恒空"；写端与生产触发已补齐，
 * 本模块让证据**可被查看**（CLI `astarray human-changes`），否则写了没人看等于半截。
 *
 * 只读：不触发观察、不修改 journal。
 */

export interface HumanChangesListEntry {
  readonly observationIdentifier: string;
}

export async function runHumanChangesCommand(input: {
  readonly stateDirectory: string;
  readonly observationIdentifier?: string;
}): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const journalDirectory = path.join(input.stateDirectory, "human-change-journal");
  if (input.observationIdentifier !== undefined) {
    try {
      const raw = await fs.readFile(
        path.join(journalDirectory, `${input.observationIdentifier}.json`),
        "utf8",
      );
      return { exitCode: 0, stdout: raw.trim() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          exitCode: 4,
          stdout: JSON.stringify({
            status: "observation-not-found",
            observationIdentifier: input.observationIdentifier,
          }),
        };
      }
      return {
        exitCode: 5,
        stdout: JSON.stringify({ status: "journal-unavailable" }),
      };
    }
  }

  let fileNames: string[];
  try {
    fileNames = await fs.readdir(journalDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      /** 还没观察过 ⇒ 空列表（不是错误；和"读不出来"区分）。 */
      return { exitCode: 0, stdout: JSON.stringify({ status: "ok", observations: [] }) };
    }
    return { exitCode: 5, stdout: JSON.stringify({ status: "journal-unavailable" }) };
  }

  const observations: HumanChangesListEntry[] = fileNames
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => ({ observationIdentifier: fileName.slice(0, -".json".length) }))
    .sort((left, right) => (left.observationIdentifier < right.observationIdentifier ? -1 : 1));
  return { exitCode: 0, stdout: JSON.stringify({ status: "ok", observations }) };
}
