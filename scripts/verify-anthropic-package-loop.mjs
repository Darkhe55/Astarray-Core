#!/usr/bin/env node
/**
 * AUDIT-REPAIR-01 检查点 05-3（第二条）：**隔离包内的 Anthropic fake-server 闭环**。
 *
 * 为什么单独写：`PublicApplicationOptions` 没有运行时可注入点，mock 运行时不会发出任何真实请求；
 * 唯一能"只经公开入口跑真实运行时"的路径是 `runtime: "provider"` + 本机 fake server。
 *
 * 全程只 import `<package-dir>/node_modules/astarray/...`，不碰仓库源码。
 *
 * 用法：node scripts/verify-anthropic-package-loop.mjs --package-dir .tmp/audit05-install
 */
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

function readArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const packageDirectory = readArgument("--package-dir");
if (packageDirectory === null) {
  console.error("缺少 --package-dir <隔离安装目录>");
  process.exit(2);
}

const entryPath = path.join(packageDirectory, "node_modules", "astarray", "dist", "public-sdk.js");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (entryPath.startsWith(repositoryRoot + path.sep)) {
  console.error("疑似从仓库源码导入：", entryPath);
  process.exit(2);
}

const sdk = await import(pathToFileURL(entryPath).href);
const anthropicRuntimeModule = await import(
  pathToFileURL(
    path.join(packageDirectory, "node_modules", "astarray", "dist", "chunk-ANTHROPIC-MESSAGES.js"),
  ).href
).catch(() => null);

/** fake server：记录收到的请求并按 Anthropic SSE 返回一段纯文本。 */
const receivedRequests = [];
const server = http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    receivedRequests.push({ url: request.url ?? "", body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
    const isProposeGoalMode = process.argv.includes("--propose-goal");
    let parsedRequestBody = null;
    try {
      parsedRequestBody = JSON.parse(body);
    } catch {
      parsedRequestBody = null;
    }
    /** 规划器请求：`tools` 为空且 system 提到"任务分解器"（与 worker 请求可区分）。 */
    const isPlannerRequest =
      parsedRequestBody !== null &&
      Array.isArray(parsedRequestBody.tools) &&
      parsedRequestBody.tools.length === 0 &&
      JSON.stringify(parsedRequestBody.system ?? "").includes("任务分解器");
    if (isPlannerRequest) {
      const decomposition = JSON.stringify({
        nodes: [
          {
            id: "T-001",
            description: "提议目标",
            dependsOn: [],
            acceptanceCriteria: "提案落盘",
            toolNames: ["proposeGoal"],
          },
        ],
      });
      const escapedText = JSON.stringify(decomposition);
      send({ type: "message_start", message: { usage: { input_tokens: 3 } } });
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: decomposition } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } });
      send({ type: "message_stop" });
      response.end();
      return;
    }
    send({ type: "message_start", message: { usage: { input_tokens: 3 } } });
    if (isProposeGoalMode) {
      /** 返回 tool_use：proposeGoal（模拟模型要求写提案）。 */
      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "proposeGoal", input: {} },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify({
            objectiveText: "把只读视图补齐到可验收",
            requirements: [
              {
                requirementIdentifier: "req-1",
                description: "视图能列出任务",
                evidenceRequirement: "artifact",
                weight: 1,
              },
            ],
          }),
        },
      });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } });
    } else {
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    }
    send({ type: "message_stop" });
    response.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = server.address().port;

const stateDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "anthropic-package-loop-"));
let failureCount = 0;
try {
  /** 通过包导出的注册器把 Anthropic 运行时接进注册表（不依赖仓库源码路径）。 */
  const registry = new sdk.ProviderRuntimeRegistry();
  if (typeof sdk.createAnthropicMessagesProviderRegistration !== "function") {
    console.error("包未导出 createAnthropicMessagesProviderRegistration");
    process.exit(2);
  }
  const registration = sdk.createAnthropicMessagesProviderRegistration({
    baseUrl: `http://127.0.0.1:${String(port)}`,
    apiKey: "test-key",
    model: "claude-test",
  });
  registry.register(registration);

  const facade = await sdk.AstarrayApplicationFacade.create({
    mode: "assist",
    stateDirectory,
    authenticatedUserId: "user-1",
    ...(process.argv.includes("--planning") ? { isModelTaskPlanningEnabled: true } : {}),
    runtime: "provider",
    providerRuntimeRegistry: registry,
    provider: {
      providerId: registration.providerId ?? "anthropic-messages",
      modelIdentifier: "claude-test",
      allowedModelIdentifiers: ["claude-test"],
      baseUrl: `http://127.0.0.1:${String(port)}`,
    },
  });

  /** 发起一次真实任务：只有任务才会触发 Provider 请求。 */
  await facade.handleUserMessage("请回复 ok");
  const deadline = Date.now() + 20_000;
  while (receivedRequests.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /** ① 请求真的打到了 fake server（这是"闭环"的唯一硬证据）。 */
  if (receivedRequests.length === 0) {
    console.error("① fake server 未收到任何请求");
    failureCount += 1;
  }
  /**
   * ② 请求体是 Anthropic Messages 形态（而非别家协议）。
   * 检查 body 而不是路径：注册器可能把 baseUrl 当完整端点，路径形态不稳定。
   */
  const firstRequest = receivedRequests[0];
  if (firstRequest !== undefined) {
    let parsedBody = null;
    try {
      parsedBody = JSON.parse(firstRequest.body);
    } catch {
      parsedBody = null;
    }
    if (
      parsedBody === null ||
      !Array.isArray(parsedBody.messages) ||
      typeof parsedBody.model !== "string"
    ) {
      console.error("② 请求体不是 Anthropic Messages 形态：", firstRequest.body.slice(0, 120));
      failureCount += 1;
    }
  }
  /**
   * ③ 目标提案权限（负向）：即使模型要求 proposeGoal，未分配/未激活时**不得落盘**。
   * 这是卡内"激活不是授权""未分配即拒绝"的包级证据。
   */
  if (process.argv.includes("--propose-goal")) {
    const proposalsDirectory = path.join(stateDirectory, "goal-mode", "proposals");
    let proposalFileNames = [];
    try {
      proposalFileNames = (await fs.readdir(proposalsDirectory)).filter((fileName) => fileName.endsWith(".json"));
    } catch {
      proposalFileNames = [];
    }
    if (proposalFileNames.length > 0) {
      console.error("③ 未分配却写入了提案：", proposalFileNames.join(", "));
      failureCount += 1;
    }
  }
  if (process.argv.includes("--dump-bodies")) {
    for (const [index, request] of receivedRequests.entries()) {
      let parsed = null;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        parsed = null;
      }
      const systemText = typeof parsed?.system === "string" ? parsed.system : JSON.stringify(parsed?.system ?? null);
      const toolNames = Array.isArray(parsed?.tools) ? parsed.tools.map((tool) => tool?.name) : [];
      const firstUser = Array.isArray(parsed?.messages)
        ? JSON.stringify(parsed.messages[0]?.content ?? "").slice(0, 120)
        : "";
      console.log(
        `#${String(index)} tools=[${toolNames.join(",")}] system=${String(systemText).slice(0, 100)} first=${firstUser}`,
      );
    }
  }
  await facade.shutdown?.().catch(() => undefined);
  console.log("anthropic-package-loop: " + (failureCount === 0 ? "ok" : "failed"));
  console.log("  entry=" + entryPath);
  console.log("  requests=" + String(receivedRequests.length) + " failures=" + String(failureCount));
} finally {
  server.close();
  await fs.rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
}
process.exit(failureCount === 0 ? 0 : 1);
