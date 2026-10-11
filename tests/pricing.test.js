"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolvePrice, priceUsage } = require("../src/pricing");
const { scanRoots, dedupeFiles } = require("../src/session-roots");

test("cost separates uncached, cached and output then multiplies by gateway markup", () => {
  const cost = priceUsage({input_tokens: 125941, cached_input_tokens: 4224, output_tokens: 979},
    "gpt-6-sol", "standard", {}, {modelPrices:{"gpt-6-sol":{input:2,cached:0.2,output:10}},priceMultiplier:1.25});
  assert.equal(cost.known,true);
  assert.ok(Math.abs(cost.total - (121717*2/1e6 + 4224*0.2/1e6 + 979*10/1e6)*1.25)<1e-12);
});
test("longest model match, override and fast price", () => {
  const models={"gpt-6":{input:1,cached:0.1,output:5},"gpt-6.1-sol":{input:2,cached:0.1,output:10}};
  assert.equal(resolvePrice("gpt-6.1-sol",models).modelKey,"gpt-6.1-sol");
  const c=priceUsage({input_tokens:1e6,cached_input_tokens:0,output_tokens:0},"gpt-6.1-sol","fast",models,{modelPrices:{"gpt-6.1-sol":{input:4,cached:0.2,output:12}},priceMultiplier:1.25});
  assert.equal(c.total,12.5);
});
test("unknown models are marked unpriced, not silently charged zero",()=>{
  assert.equal(priceUsage({input_tokens:20}, "unknown-future", "standard", {}, {}).known,false);
});
test("bad overrides cannot silently replace valid builtin prices",()=>{
  assert.equal(resolvePrice("model",{"model":{input:2,cached:1,output:3}},{"model":{input:-1,cached:0,output:0}}).price.input,2);
});
test("archive scanning combines siblings and removes duplicate rollout files",()=>{
  const root=path.join("E:","codexzh","sessions");
  assert.deepEqual(scanRoots(root),[root,path.join("E:","codexzh","archived_sessions")]);
  const files=[{fullPath:path.join(root,"rollout-a.jsonl"),mtimeMs:1},{fullPath:path.join("E:","codexzh","archived_sessions","rollout-a.jsonl"),mtimeMs:2},{fullPath:path.join("E:","codexzh","archived_sessions","rollout-b.jsonl"),mtimeMs:3}];
  assert.deepEqual(dedupeFiles(files).map(x=>path.basename(x.fullPath)),["rollout-b.jsonl","rollout-a.jsonl"]);
  const shared = new Set();
  assert.equal(dedupeFiles([files[0]], shared).length, 1);
  assert.equal(dedupeFiles([files[1]], shared).length, 0);
});

test("input/output cost split retains markup and totals", () => {
  const r = priceUsage({ input_tokens: 1000000, cached_input_tokens: 900000, output_tokens: 20000 },
    "gpt-6-sol", "standard", {}, { modelPrices: {"gpt-6-sol":{input:2,cached:.2,output:10}}, priceMultiplier:1.25 });
  assert.ok(Math.abs(r.inputCost - .475) < 1e-10);
  assert.ok(Math.abs(r.outputCost - .25) < 1e-10);
  assert.ok(Math.abs(r.total - r.inputCost - r.outputCost) < 1e-10);
});

test("same JSONL rollout has one session, while prompts have separate turn IDs", () => {
  const { sessionGroupId, turnGroupId } = require("../src/grouping");
  assert.equal(sessionGroupId("a","file1"),sessionGroupId("a","file1"));
  assert.notEqual(sessionGroupId("a","file1"),sessionGroupId("a","file2"));
  assert.notEqual(turnGroupId("a","file1",1),turnGroupId("a","file1",2));
});
