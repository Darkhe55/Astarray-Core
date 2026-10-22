/**
 * SECRETARY-01-04 公开入口包级验收（2026-10-23）。
 *
 * 用法：node scripts/verify-secretary-package.mjs --package-dir <已安装包目录>
 *
 * 判据（卡内：公开包入口、预算/工作时段有效、启动不阻塞项目对话；用户口径：不限预算 + 全天）：
 * 1. `astarray secretary status --json` 可执行并输出 `status:"ok"`；
 * 2. 默认值：`sessionTokenLimit: null`、工作时段 `0–1440`；
 * 3. 项目忙碌 ⇒ `startup.kind = "deferred"`（不阻塞对话），且 `--habit secretary-first` 同样 deferred；
 * 4. 默认预算不限 ⇒ 极大 token 用量仍 `within`；显式 `--session-token-limit` 才 exhausted；
 * 5. 默认全天 ⇒ 03:00 与 23:59 都在时段内；显式 `--start-minute/--end-minute` 才 outside；
 * 6. 非法 `--habit` ⇒ 非 0 退出（fail-closed）。
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArguments(argv) {
  const options = { packageDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-dir") {
      options.packageDirectory = argv[index + 1] ?? null;
      index += 1;
    }
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
if (options.packageDirectory === null) {
  process.stderr.write("用法: node scripts/verify-secretary-package.mjs --package-dir <已安装包目录>\n");
  process.exit(2);
}

const packageRoot = path.resolve(options.packageDirectory);
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
const cliPath = path.join(packageRoot, "dist", "cli.js");
try {
  await fs.access(cliPath);
} catch {
  process.stderr.write(`未找到 CLI 入口：${cliPath}\n`);
  process.exit(2);
}

const failures = [];
const observations = {};
const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "astarray-secretary-e2e-"));

function runSecretaryStatus(argumentsList) {
  return spawnSync(process.execPath, [cliPath, "secretary", "status", "--json", ...argumentsList], {
    encoding: "utf8",
    env: { ...process.env, ASTARRAY_STATE_DIRECTORY: stateDirectory },
  });
}

function parseReport(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

try {
  // ① 默认（空闲、默认全部）
  const defaultsRun = runSecretaryStatus(["--minute-of-day", "180"]);
  const defaults = parseReport(defaultsRun);
  observations.defaultsStatus = defaultsRun.status;
  if (defaultsRun.status !== 0 || defaults === null) {
    failures.push(`secretary status 应成功返回 JSON（status=${String(defaultsRun.status)}）`);
  } else {
    if (defaults.effectiveDefaults?.sessionTokenLimit !== null) {
      failures.push("默认预算应为 null（不限）");
    }
    if (defaults.effectiveDefaults?.startMinuteOfDay !== 0 || defaults.effectiveDefaults?.endMinuteOfDay !== 1440) {
      failures.push("默认工作时段应为 00:00–24:00");
    }
    if (defaults.startup?.kind !== "start") failures.push("空闲时秘书应可开始");
    if (defaults.workWindow?.kind !== "inside") failures.push("默认全天：03:00 应在时段内");
  }

  // ② 项目忙碌 ⇒ deferred（两种习惯都不阻塞）
  for (const habit of ["project-first", "secretary-first"]) {
    const busy = parseReport(
      runSecretaryStatus(["--project-busy", "--habit", habit, "--minute-of-day", "600"]),
    );
    observations[`busy-${habit}`] = busy?.startup?.kind ?? null;
    if (busy?.startup?.kind !== "deferred") failures.push(`忙碌时（${habit}）秘书应 deferred`);
  }

  // ③ 默认不限预算 vs 显式上限
  const huge = parseReport(runSecretaryStatus(["--tokens-used", "999999999", "--minute-of-day", "600"]));
  observations.unlimitedBudget = huge?.budget?.kind ?? null;
  if (huge?.budget?.kind !== "within") failures.push("默认不限预算：极大用量仍应 within");
  const limited = parseReport(
    runSecretaryStatus(["--tokens-used", "100", "--session-token-limit", "100", "--minute-of-day", "600"]),
  );
  observations.limitedBudget = limited?.budget?.kind ?? null;
  if (limited?.budget?.kind !== "exhausted") failures.push("显式上限用尽应 exhausted");

  // ④ 23:59 仍在默认全天时段内；显式时段外则 outside
  const lateNight = parseReport(runSecretaryStatus(["--minute-of-day", "1439"]));
  observations.lateNightWindow = lateNight?.workWindow?.kind ?? null;
  if (lateNight?.workWindow?.kind !== "inside") failures.push("默认全天：23:59 应在时段内");
  const explicitWindow = parseReport(
    runSecretaryStatus(["--minute-of-day", "480", "--start-minute", "540", "--end-minute", "1080"]),
  );
  observations.explicitWindow = explicitWindow?.workWindow?.kind ?? null;
  if (explicitWindow?.workWindow?.kind !== "outside") failures.push("显式时段（09:00–18:00）：08:00 应 outside");

  // ⑤ 非法 habit ⇒ 非 0 退出
  const invalid = runSecretaryStatus(["--habit", "no-such-habit"]);
  observations.invalidHabitStatus = invalid.status;
  if (invalid.status === 0) failures.push("非法 --habit 必须 fail-closed（非 0 退出）");

  process.stdout.write(
    `${JSON.stringify(
      {
        packageName: packageJson.name,
        packageVersion: packageJson.version,
        observations,
        failures,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures.length > 0) {
  process.stderr.write(`SECRETARY 包级验收失败：${String(failures.length)} 项\n`);
  process.exit(1);
}
process.stdout.write(
  "SECRETARY 包级验收通过：公开入口可执行、默认不限预算/全天、忙碌不阻塞、显式上限与时段生效、非法输入 fail-closed\n",
);

