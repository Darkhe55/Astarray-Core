import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  astarrayDataDirectory,
  astarrayStateDirectory,
} from "../../../packages/core/src/infra/user-data-paths.js";

describe("用户数据路径（CLI/GUI 共用）", () => {
  it("① ASTARRAY_DATA_DIR 覆盖优先", () => {
    const directory = astarrayDataDirectory({ ASTARRAY_DATA_DIR: "./custom-data" });
    expect(directory).toBe(path.resolve("./custom-data"));
  });

  it("② Vitest 及子进程沿用 cwd/.astarray（不污染真实用户数据）", () => {
    expect(astarrayDataDirectory({ VITEST: "true" })).toBe(
      path.join(process.cwd(), ".astarray"),
    );
  });

  it.runIf(process.platform === "win32")(
    "③ Windows 默认 %LOCALAPPDATA%\\Astarray，状态在 state 子目录",
    () => {
      const environment = { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" };
      expect(astarrayDataDirectory(environment)).toBe(
        path.join("C:\\Users\\example\\AppData\\Local", "Astarray"),
      );
      expect(astarrayStateDirectory(environment)).toBe(
        path.join("C:\\Users\\example\\AppData\\Local", "Astarray", "state"),
      );
    },
  );
});

