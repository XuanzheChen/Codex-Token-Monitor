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
vm.runInNewContext(original + "\nmodule.exports.__testing = { buildAccountUsage, buildDashboardData, getDashboardHtml };",
  { module: mod, require: name => name === "vscode" ? {} : localRequire(name),
    process, console, Buffer, setTimeout, clearTimeout, setInterval, clearInterval },
  { filename: file });
const { buildAccountUsage, buildDashboardData, getDashboardHtml } = mod.exports.__testing;

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
  const usage={total_tokens:1005,input_tokens:1000,output_tokens:5,cached_input_tokens:800,cost_usd:1.2,unpriced_events:0};
  message({data:{command:"data",data:{display:{rate:1,symbol:"$"},accounts:[],files:1,sessions:1,
    sessionCounts:{today:1,seven:2,month:3,total:4},
    totals:{today:usage,seven:usage,month:usage,todayPoints:[],todaySessionGroups:[],
    sevenDays:[day],monthDays:[monthDay]}}}});
  const chart=getElementById("usageChart");
  assert.match(chart.innerHTML,/Input max 100k/);
  assert.match(chart.innerHTML,/Output max 50/);
  assert.match(chart.innerHTML,/Input cost: \$1\.00/);
  assert.match(chart.innerHTML,/Output cost: \$0\.20/);
  assert.match(chart.innerHTML,/class="y-axis-ticks"/);
  assert.match(chart.innerHTML,/25k<\/text>/); // 25% tick on the input axis
  const overview=getElementById("summary").innerHTML;
  assert.match(overview,/Cached 800/);
  assert.match(overview,/Cache hit 80%/);
  assert.match(overview,/Output \/ input 0\.50%/);
  assert.match(overview,/session-stats/);
  assert.match(overview,/30 Days/);
  getElementById("usageRangeSelect").listeners.change({target:{value:"30"}});
  assert.match(chart.innerHTML,/10\/1/);
  assert.match(chart.innerHTML,/Output max 25/);
});

test("session counts distinguish 1/7/30-day activity and all-time unique files, including archives", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"codex-session-counts-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const active=path.join(root,"sessions"), archive=path.join(root,"archived_sessions");
  fs.mkdirSync(active);fs.mkdirSync(archive);
  const stamp=daysAgo=>{const d=new Date();d.setDate(d.getDate()-daysAgo);d.setHours(12,0,0,0);return d.toISOString();};
  function add(dir,filename,daysAgo) {
    const event={timestamp:stamp(daysAgo),type:"event_msg",
      payload:{type:"token_count",info:{total_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:1,total_tokens:101}}}};
    fs.writeFileSync(path.join(dir,filename),JSON.stringify(event)+"\n");
  }
  add(active,"rollout-today.jsonl",0);
  add(active,"rollout-three-days.jsonl",3);
  add(archive,"rollout-twenty-days.jsonl",20);
  add(archive,"rollout-forty-days.jsonl",40);
  const today=new Date();today.setHours(0,0,0,0);
  const start=today.getTime();
  const period={todayStart:start,todayEnd:start+86400000,
    sevenStart:new Date(today.getFullYear(),today.getMonth(),today.getDate()-6).getTime(),
    monthStart:new Date(today.getFullYear(),today.getMonth(),today.getDate()-29).getTime()};
  const account={id:"a",label:"one",root:active};
  const data=await buildAccountUsage(account,period,{},new Set());
  assert.equal(data.sessionCounts.today,1);
  assert.equal(data.sessionCounts.seven,2);
  assert.equal(data.sessionCounts.month,3);
  assert.equal(data.sessionCounts.total,4);
  assert.equal(data.files,4);
  // Old two-account config must not double-count the sibling archive.
  const summary=await buildDashboardData([account,{id:"b",label:"old archive config",root:archive}],{}, {symbol:"$",rate:1});
  assert.equal(summary.sessions,4);
  assert.equal(summary.sessionCounts.today,1);
  assert.equal(summary.sessionCounts.seven,2);
  assert.equal(summary.sessionCounts.month,3);
  assert.equal(summary.sessionCounts.total,4);
});
