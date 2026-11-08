/**
 * ALIGN-02-05 跨进程夹具：用**真实构建产物**在一个独立进程里申请/持有租约，
 * 结果以 JSON 打到 stdout，让测试断言"另一个进程真的拿到了什么"。
 *
 * 为什么用 dist 而不是源码：子进程不能用 Node 自带的类型剥离去解析
 * `.js` 说明符指向 `.ts` 的内部 import；用构建产物才等价于
 * "另一个进程跑的是同一份产品代码"。
 *
 * 用法：node mission-lease-child-fixture.mjs <stateDirectory> <acquire|hold> <processInstanceId>
 * - acquire：申请一次后打印 status 并退出；
 * - hold：申请成功后常驻，等父进程杀掉（模拟"进程 A 崩溃"）。
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateDirectory = process.argv[2];
const action = process.argv[3];
const processInstanceId = process.argv[4];

if (typeof stateDirectory !== "string" || stateDirectory === "") {
  stdout.write(JSON.stringify({ error: "missing-state-directory" }) + "\n");
  process.exit(2);
}
if (typeof processInstanceId !== "string" || processInstanceId === "") {
  stdout.write(JSON.stringify({ error: "missing-process-instance-id" }) + "\n");
  process.exit(2);
}

/** 构建产物的文件名带内容哈希：按前缀发现实际文件，不写死哈希。 */
function resolveBuiltModule(prefix) {
  const moduleDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "dist",
  );
  const candidates = readdirSync(moduleDirectory).filter(
    (fileName) => fileName.startsWith(prefix) && fileName.endsWith(".js"),
  );
  if (candidates.length === 0) {
    throw new Error(`构建产物缺少模块: ${prefix}（请先 npm run build）`);
  }
  return path.join(moduleDirectory, candidates[0]);
}

const leaseModule = await import(
  pathToFileURL(resolveBuiltModule("mission-lease-store-")).href
);
/** TTL 可由父进程指定：让"崩溃后过期"在测试内可发生，不依赖真实 30s。 */
const leaseTtlMilliseconds =
  process.env.ASTARRAY_FIXTURE_LEASE_TTL_MILLISECONDS === undefined
    ? undefined
    : Number(process.env.ASTARRAY_FIXTURE_LEASE_TTL_MILLISECONDS);
const store = new leaseModule.MissionLeaseStore({
  stateDirectory,
  ...(leaseTtlMilliseconds === undefined ? {} : { leaseTtlMilliseconds }),
});

if (action === "acquire") {
  const result = await store.tryAcquire({
    missionId: "mission-x",
    processInstanceId,
    purpose: "run",
    claimantDescription: "fixture-child",
  });
  stdout.write(`${JSON.stringify({ status: result.status })}\n`);
} else if (action === "hold") {
  const result = await store.tryAcquire({
    missionId: "mission-x",
    processInstanceId,
    purpose: "run",
    claimantDescription: "fixture-holder",
  });
  stdout.write(`${JSON.stringify({ status: result.status, pid: process.pid })}\n`);
  setInterval(() => {}, 1_000);
} else {
  stdout.write(JSON.stringify({ error: "unknown-action" }) + "\n");
  process.exit(2);
}
