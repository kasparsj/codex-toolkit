import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const lines = createInterface({ input: process.stdin });
let last = JSON.stringify({ schema_version: 1, kind: "plan", delivery_id: "d1", repo: "github.com/o/r", result: { ok: true } });
let timer;
let releaseWatch;
let abortSettlementReleaseWatch;
let abortExitReleaseWatch;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const waitForMarker = (path, action) => {
  let finished = false;
  let markerWatch;
  const complete = () => {
    if (finished || !existsSync(path)) return;
    finished = true;
    markerWatch?.close();
    action();
  };
  markerWatch = watch(dirname(path), complete);
  complete();
  return markerWatch;
};
const sessionDirIndex = process.argv.indexOf("--session-dir");
const sessionIndex = process.argv.indexOf("--session");
const sessionFile = process.env.FAKE_PI_SESSION_FILE ?? (sessionIndex >= 0 ? process.argv[sessionIndex + 1] : sessionDirIndex >= 0 ? join(process.argv[sessionDirIndex + 1], "fake-session.jsonl") : undefined);
if (sessionFile && !process.env.FAKE_PI_SESSION_FILE && sessionDirIndex >= 0) {
  mkdirSync(process.argv[sessionDirIndex + 1], { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile, "", process.env.FAKE_PI_DEFAULT_SESSION_MODE ? undefined : { mode: 0o600 });
}
if (process.env.FAKE_PI_START_MARKER) appendFileSync(process.env.FAKE_PI_START_MARKER, "start\n");
if (process.env.FAKE_PI_PROCESS_MARKER) {
  const pgid = Number(execFileSync("ps", ["-p", String(process.pid), "-o", "pgid="], { encoding: "utf8" }).trim());
  writeFileSync(process.env.FAKE_PI_PROCESS_MARKER, `${JSON.stringify({ pid: process.pid, pgid })}\n`, { mode: 0o600 });
}
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") return send({ id: command.id, type: "response", command: "get_state", success: true, data: { sessionId: "fake", sessionFile, isStreaming: false, isCompacting: false } });
  if (command.type === "get_available_models") return send({ id: command.id, type: "response", command: "get_available_models", success: true, data: { models: process.env.FAKE_PI_MODELS_EMPTY ? [] : [{ provider: "openai", id: "gpt-6.1-sol" }] } });
  if (command.type === "prompt") {
    if (process.env.FAKE_PI_PROMPT_MARKER) appendFileSync(process.env.FAKE_PI_PROMPT_MARKER, "prompt\n");
    if (command.message.includes('"scenario":"reject"')) return send({ id: command.id, type: "response", command: "prompt", success: false, error: "synthetic rejection" });
    if (command.message.includes('"scenario":"early-settle"') || command.message.includes('"scenario":"early-handled"') || command.message.includes('"scenario":"early-reject"')) {
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: "stop" } });
      send({ type: "agent_settled", aborted: false });
      if (command.message.includes('"scenario":"early-handled"')) return setTimeout(() => send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } }), 20);
      if (command.message.includes('"scenario":"early-reject"')) return setTimeout(() => send({ id: command.id, type: "response", command: "prompt", success: false, error: "synthetic rejection after hook" }), 20);
      return setTimeout(() => send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } }), 20);
    }
    if (command.message.includes('"handled":true')) return send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } });
    send({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
    const scenario = JSON.parse(command.message).scenario;
    if (scenario === "hold") return;
    if (scenario === "process-group-release") {
      const ready = process.env.FAKE_PI_GROUP_READY, release = process.env.FAKE_PI_GROUP_RELEASE;
      if (!ready || !release) throw new Error("process-group-release requires ready and release markers");
      writeFileSync(ready, "ready\n", { mode: 0o600 });
      let settled = false;
      const complete = () => {
        if (settled || !existsSync(release)) return;
        settled = true; releaseWatch?.close();
        send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: "stop" } });
        send({ type: "agent_end", messages: [], willRetry: false });
        send({ type: "agent_settled", aborted: false });
      };
      releaseWatch = watch(dirname(release), complete); complete(); return;
    }
    if (["terminal-error", "terminal-length", "retry-failure", "retry-success", "abort-error"].includes(scenario)) {
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: scenario === "terminal-length" ? "length" : "error", ...(scenario === "terminal-length" ? {} : { errorMessage: "synthetic attempt failed" }) } });
      send({ type: "agent_end", messages: [], willRetry: scenario.startsWith("retry") || scenario === "abort-error" });
      if (scenario === "terminal-error" || scenario === "terminal-length") return setTimeout(() => send({ type: "agent_settled", aborted: false }), 40);
      send({ type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 40, error: "synthetic provider error" });
      if (scenario === "abort-error") {
        if (process.env.FAKE_PI_ABORT_READY) appendFileSync(process.env.FAKE_PI_ABORT_READY, "ready\n");
        return;
      }
      timer = setTimeout(() => {
        if (scenario === "retry-success") send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: "stop" } });
        send({ type: "auto_retry_end", success: scenario === "retry-success", attempt: 1, ...(scenario === "retry-failure" ? { finalError: "synthetic retries exhausted" } : {}) });
        send({ type: "agent_settled", aborted: false });
      }, 80);
      return;
    }
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: last }], stopReason: "stop" } });
    send({ type: "agent_end", messages: [], willRetry: false });
    return setTimeout(() => send({ type: "agent_settled", aborted: false }), 40);
  }
  if (command.type === "get_last_assistant_text") return send({ id: command.id, type: "response", command: command.type, success: true, data: { text: last } });
  if (command.type === "compact") return send({ id: command.id, type: "response", command: "compact", success: true, data: { summary: "small" } });
  if (command.type === "abort") {
    if (process.env.FAKE_PI_ABORT_MARKER) appendFileSync(process.env.FAKE_PI_ABORT_MARKER, "abort\n");
    clearTimeout(timer);
    releaseWatch?.close();
    if (process.env.FAKE_PI_ABORT_EXIT_RELEASE) abortExitReleaseWatch = waitForMarker(process.env.FAKE_PI_ABORT_EXIT_RELEASE, () => process.exit(0));
    if (process.env.FAKE_PI_ABORT_EXIT_DELAY_MS) setTimeout(() => process.exit(0), Number(process.env.FAKE_PI_ABORT_EXIT_DELAY_MS));
    const markResponse = () => { if (process.env.FAKE_PI_ABORT_RESPONSE_MARKER) appendFileSync(process.env.FAKE_PI_ABORT_RESPONSE_MARKER, "response\n"); };
    if (process.env.FAKE_PI_ABORT_MODE === "reject") { markResponse(); return send({ id: command.id, type: "response", command: "abort", success: false, error: "synthetic abort rejection" }); }
    if (process.env.FAKE_PI_ABORT_MODE === "timeout") return;
    const settle = () => { if (process.env.FAKE_PI_CHANGE_TITLE) process.title = process.env.FAKE_PI_CHANGE_TITLE; send({ type: "agent_settled", aborted: true }); if (process.env.FAKE_PI_ABORT_SETTLED_MARKER) appendFileSync(process.env.FAKE_PI_ABORT_SETTLED_MARKER, "settled\n"); };
    const acknowledge = () => { markResponse(); send({ id: command.id, type: "response", command: "abort", success: true }); };
    const settleDelay = Number(process.env.FAKE_PI_ABORT_SETTLE_DELAY_MS ?? 0), ackDelay = Number(process.env.FAKE_PI_ABORT_ACK_DELAY_MS ?? 0);
    if (process.env.FAKE_PI_ABORT_SETTLE_RELEASE) abortSettlementReleaseWatch = waitForMarker(process.env.FAKE_PI_ABORT_SETTLE_RELEASE, settle);
    else if (settleDelay > 0) setTimeout(settle, settleDelay);
    else settle();
    if (ackDelay > 0) return setTimeout(acknowledge, ackDelay);
    return acknowledge();
  }
});
lines.on("close", () => { releaseWatch?.close(); abortSettlementReleaseWatch?.close(); abortExitReleaseWatch?.close(); });
