"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const file = path.resolve(__dirname, "../src/extension.js");
const original = fs.readFileSync(file, "utf8");
const localRequire = createRequire(file);
const mod = { exports: {} };
vm.runInNewContext(original + "\nmodule.exports.__testing = { buildAccountUsage, getDashboardHtml };",
  { module: mod, require: name => name === "vscode" ? {} : localRequire(name),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval },
  { filename: file });
const { buildAccountUsage, getDashboardHtml } = mod.exports.__testing;

test("two prompts in the same rollout are exactly one Recent Session and two timeline turns", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-usage-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sessions = path.join(base, "sessions");
  fs.mkdirSync(sessions);
  const now = Date.now(), stamp = offset => new Date(now + offset).toISOString();
  const lines = [
    {timestamp:stamp(-30000),type:"response_item",payload:{type:"message",role:"user",content:[{text:"first prompt"}]}},
    {timestamp:stamp(-20000),type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:1000,cached_input_tokens:500,output_tokens:100,total_tokens:1100}}}},
    {timestamp:stamp(-10000),type:"response_item",payload:{type:"message",role:"user",content:[{text:"second prompt"}]}},
    {timestamp:stamp(-5000),type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:2000,cached_input_tokens:1500,output_tokens:200,total_tokens:2200}}}}
  ];
  fs.writeFileSync(path.join(sessions,"rollout-test.jsonl"),lines.map(x=>JSON.stringify(x)).join("\n")+"\n");
  const start = new Date(); start.setHours(0,0,0,0);
  const day = start.getTime();
  const data = await buildAccountUsage({id:"account1",label:"Test",root:sessions},
    {monthStart:day - 30 * 86400000, sevenStart:day - 6 * 86400000, todayStart:day, todayEnd:day + 86400000},
    {modelPrices:{"test-model":{input:1,cached:.1,output:10}}},new Set());
  assert.equal(data.files, 1);
  assert.equal(data.sessions, 1);
  assert.equal(data.recentSessions.length, 1);
  assert.equal(data.recentSessions[0].turnCount, 2);
  assert.equal(data.recentSessions[0].total, 2200);
  assert.equal(data.todaySessionGroups.length, 2);
  assert.notEqual(data.todaySessionGroups[0].id, data.todaySessionGroups[1].id);
});

test("generated webview has one selectable history chart and shows split cost tooltip", () => {
  const html = getDashboardHtml();
  assert.equal((html.match(/id="usageChart"/g) || []).length, 1);
  assert.equal((html.match(/id="usageRangeSelect"/g) || []).length, 1);
  assert.equal((html.match(/id="weekChart"/g) || []).length, 0);
  assert.equal((html.match(/id="monthChart"/g) || []).length, 0);
  const match = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(match, "webview JavaScript found");
  const js = new vm.Script(match[1], { filename:"dashboard-webview.js" });
  const elements = new Map();
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id,{
      innerHTML:"", value:"", listeners:{},
      addEventListener(type,cb){ this.listeners[type]=cb; },
      querySelectorAll(){return[];}
    });
    return elements.get(id);
  };
  let message;
  js.runInNewContext({
    acquireVsCodeApi: () => ({postMessage(){}}),
    document:{getElementById, querySelectorAll:()=>[]},
    window:{addEventListener(type,cb){ if(type==="message")message=cb; }},
    Date, Math, Number, String, Array, Map
  });
  assert.equal(typeof message, "function");
  const day={key:"2026-10-10",label:"10/10",input:100000,output:50,cached:80000,total:100050,cost:1.2,inputCost:1,outputCost:.2,unpriced:0};
  const monthDay={...day,key:"2026-10-01",label:"10/1",input:5000,output:25};
  const empty={total_tokens:0,input_tokens:0,output_tokens:0,cached_input_tokens:0,cost_usd:0};
  message({data:{command:"data",data:{display:{rate:1,symbol:"$"},accounts:[],files:1,sessions:1,
    totals:{today:empty,seven:empty,month:empty,todayPoints:[],todaySessionGroups:[],
    sevenDays:[day],monthDays:[monthDay]}}}});
  const chart=getElementById("usageChart");
  assert.match(chart.innerHTML,/Input max 100k/);
  assert.match(chart.innerHTML,/Output max 50/);
  assert.match(chart.innerHTML,/Input cost: \$1\.00/);
  assert.match(chart.innerHTML,/Output cost: \$0\.20/);
  getElementById("usageRangeSelect").listeners.change({target:{value:"30"}});
  assert.match(chart.innerHTML,/10\/1/);
  assert.match(chart.innerHTML,/Output max 25/);
});
