import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliveryEngine } from "../src/engine.ts";
import { ForegroundSupervisor, nextBackoff } from "../src/foreground.ts";
import { GitHubTransport } from "../src/github.ts";
import { FileStateStore } from "../src/store.ts";
import { policy } from "./helpers.ts";

test("foreground polling reads each HTTP snapshot and resets pacing after transient reads", async () => {
  const responses = [
    { code: 503, state: "unavailable" },
    { code: 503, state: "unavailable" },
    { code: 429, state: "rate_limited", retry: "600" },
    { code: 200, state: "pending" },
    { code: 200, state: "failure" },
    { code: 200, state: "success" },
  ];
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const item = responses[requests.length - 1];
    assert.ok(item, "poller must not read beyond the explicit sequence");
    response.statusCode = item.code;
    if (item.retry) response.setHeader("retry-after", item.retry);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: item.state }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "delivery-poll-contract-"));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const transport = new GitHubTransport({ repo: "owner/repo", token: "fixture", baseUrl: `http://127.0.0.1:${address.port}`, testOnly: true });
    const engine = new DeliveryEngine({ store: new FileStateStore(root) }), p = policy();
    const original = engine.start({ repo: "owner/repo", issue: 1, policy: p });
    const observed: string[] = [], statuses: string[] = [], delays: number[] = [];
    // This is the supervisor/read-port seam, not publication or check acceptance.
    // A failed/pending/success read must never manufacture an engine transition.
    engine.dispatch = async () => {
      const snapshot = await transport.object("GET", "/repos/owner/repo");
      observed.push(String(snapshot.state));
      return engine.store.read(original.repo, original.delivery_id);
    };
    const supervisor = new ForegroundSupervisor({
      engine, repo: original.repo, policy: p,
      policyConfig: { schema_version: 1, repository: original.repo, repository_id: 10, auto_schedule: false, pr_publication: "off", issue_publication: "off" },
      onStatus: (status) => statuses.push(status),
      sleep: async (delay) => { delays.push(delay); if (delays.length === responses.length) supervisor.stop(); },
    });
    await supervisor.run();
    assert.deepEqual(delays, [15_000, 30_000, 600_000, 15_000, 15_000, 15_000]);
    assert.deepEqual(observed, ["pending", "failure", "success"]);
    assert.deepEqual(statuses.slice(0, 3), ["operator_hold", "operator_hold", "operator_hold"]);
    assert.deepEqual(requests, Array(6).fill("GET /repos/owner/repo"));
    const after = engine.store.read(original.repo, original.delivery_id);
    assert.equal(after.revision, original.revision);
    assert.equal(after.status, original.status);
    assert.deepEqual(after.executions, []);
    assert.deepEqual(after.publication, original.publication);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary exponential read backoff reaches and retains the five-minute cap", () => {
  const sequence: number[] = []; let previous = 0;
  for (let count = 0; count < 8; count += 1) { previous = nextBackoff(previous); sequence.push(previous); }
  assert.deepEqual(sequence, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});
