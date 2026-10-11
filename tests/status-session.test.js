"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const extensionFile = path.resolve(__dirname, "../src/extension.js");
const contents = fs.readFileSync(extensionFile, "utf8");
const extensionRequire = createRequire(extensionFile);
class MarkdownString {
  constructor() { this.value = ""; }
  appendMarkdown(value) { this.value += value; }
}
const moduleMock = { exports: {} };
vm.runInNewContext(
  contents + "\nmodule.exports.__tests = { buildAccountUsage, findLatestAccountUsage, CodexTokenMonitor };",
  {
    module: moduleMock,
    require: name => name === "vscode" ? { MarkdownString } : extensionRequire(name),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval
  },
  { filename: extensionFile }
);
const { buildAccountUsage, findLatestAccountUsage, CodexTokenMonitor } = moduleMock.exports.__tests;

test("status bar, tooltip and Recent Sessions use the same full rollout despite an effort switch", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-status-rollout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "sessions");
  fs.mkdirSync(folder);
  const time = offset => new Date(Date.now() + offset).toISOString();
  const events = [
    { timestamp: time(-40000), type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "first request" }] } },
    { timestamp: time(-30000), type: "event_msg",
      payload: { type: "token_count", info: { model: "gpt-6.1-sol", reasoning_effort: "high",
        total_token_usage: { input_tokens: 4100000, cached_input_tokens: 3900000,
          output_tokens: 19200, total_tokens: 4119200 } } } },
    { timestamp: time(-20000), type: "response_item",
      payload: { type: "message", role: "user", content: [{ text: "second request" }] } },
    { timestamp: time(-10000), type: "event_msg",
      payload: { type: "token_count", info: { model: "gpt-6.1-sol", reasoning_effort: "max",
        total_token_usage: { input_tokens: 5007800, cached_input_tokens: 4616500,
          output_tokens: 26600, total_tokens: 5034400 } } } }
  ];
  const file = path.join(folder, "rollout-two-efforts.jsonl");
  fs.writeFileSync(file, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const account = await buildAccountUsage(
    { id: "account1", label: "CodexZH", root: folder },
    { monthStart: start - 29 * 86400000, sevenStart: start - 6 * 86400000,
      todayStart: start, todayEnd: start + 86400000 },
    { modelPrices: { "gpt-6.1-sol": { input: 2, cached: .1, output: 10 } } },
    new Set()
  );
  assert.equal(account.sessions, 1);
  assert.equal(account.recentSessions[0].total, 5034400);
  assert.equal(account.recentSessions[0].modelBreakdown.length, 2);
  assert.equal(account.latestTurnGroup.total, 915200);

  const latest = findLatestAccountUsage([account]);
  assert.equal(latest.usage.total, 5034400);
  assert.equal(latest.usage.input, 5007800);
  assert.equal(latest.usage.cached, 4616500);
  assert.equal(latest.turnUsage.total, 915200);
  assert.ok(Math.abs(latest.usage.cost - account.recentSessions[0].cost) < 1e-10);
  assert.ok(latest.usage.cost > latest.turnUsage.cost);

  // No actual VS Code installation is needed: exercise the real render() and tooltip code.
  const monitor = Object.create(CodexTokenMonitor.prototype);
  monitor.dashboardData = { files: 1 };
  monitor.status = {};
  monitor.latestUsage = latest.usage;
  monitor.latestTurnUsage = latest.turnUsage;
  monitor.latestSession = latest.session;
  monitor.lastError = undefined;
  monitor.render();
  assert.match(monitor.status.text, /Session 5m/);
  assert.match(monitor.status.text, /in 5m, cache 4\.6m/);
  assert.match(monitor.status.text, /\$1\.51/);
  const tooltip = monitor.status.tooltip.value;
  assert.match(tooltip, /Session total.*5m/);
  assert.match(tooltip, /2 model\/effort combinations/);
  assert.match(tooltip, /Session cost:\*\*? \$1\.51/);
  assert.match(tooltip, /Latest turn \(separate from session total\): 915\.2k tokens/);
  assert.match(tooltip, /\$0\.53/);
});

test("most recently active session wins across accounts and preserves missing-price N/A", () => {
  const now = new Date().toISOString(), earlier = new Date(Date.now()-50000).toISOString();
  const a = {id:"a",latestSessionGroup:{file:"session-a.jsonl",lastAt:earlier,
    input:3000000,cached:2000000,total:3100000,output:100000,cost:3,unpriced:0,modelBreakdown:[]}};
  const b = {id:"b",latestSessionGroup:{file:"session-b.jsonl",lastAt:now,
    input:600000,cached:590000,total:610000,output:10000,cost:0,unpriced:1,modelBreakdown:[]},
    latestTurnGroup:{file:"session-b.jsonl",lastAt:now,input:10000,total:10000,cost:0,unpriced:1}};
  const latest = findLatestAccountUsage([a,b]);
  assert.equal(latest.session.fullPath,"session-b.jsonl");
  assert.equal(latest.usage.total,610000);
  const monitor = Object.create(CodexTokenMonitor.prototype);
  monitor.dashboardData={files:2};
  monitor.status={};
  monitor.latestSession=latest.session;
  monitor.latestUsage=latest.usage;
  monitor.latestTurnUsage=latest.turnUsage;
  monitor.render();
  assert.match(monitor.status.text,/Session 610k/);
  assert.match(monitor.status.text,/N\/A/);
  assert.match(monitor.status.tooltip.value,/Session cost:\*\*? N\/A/);
});
