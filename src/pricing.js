"use strict";

function resolvePrice(model, builtins = {}, overrides = {}) {
  const key = String(model || "").trim().toLowerCase();
  if (!key || key === "unknown") return null;
  const prices = { ...builtins };
  for (const [rawName, raw] of Object.entries(overrides || {})) {
    if (!raw || typeof raw !== "object") continue;
    const fields = ["input", "cached", "output"].map(k => Number(raw[k]));
    if (fields.some(v => !Number.isFinite(v) || v < 0) || ["input", "cached", "output"].some(k => raw[k] == null)) continue;
    prices[rawName.trim().toLowerCase()] = { input: fields[0], cached: fields[1], output: fields[2] };
  }
  const matched = Object.keys(prices).filter(name => name && (key === name || key.startsWith(name + "-"))).sort((a,b) => b.length-a.length)[0];
  return matched ? { modelKey: matched, price: prices[matched] } : null;
}

function priceUsage(usage, model, serviceTier, builtins, options = {}) {
  const resolved = resolvePrice(model, builtins, options.modelPrices);
  if (!resolved) return { known: false, total: 0 };
  const input = Math.max(0, Number(usage.input_tokens) || 0);
  const cached = Math.min(input, Math.max(0, Number(usage.cached_input_tokens) || 0));
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  const chargedMultiplier = Number(options.priceMultiplier);
  const markup = Number.isFinite(chargedMultiplier) && chargedMultiplier > 0 ? chargedMultiplier : 1;
  const tier = String(serviceTier || "").trim().toLowerCase();
  const fast = tier.includes("fast") ? 2.5 : 1;
  const nonCachedCost = (input - cached) * resolved.price.input / 1e6;
  const cachedCost = cached * resolved.price.cached / 1e6;
  const outputCost = output * resolved.price.output / 1e6;
  const total = (nonCachedCost + cachedCost + outputCost) * fast * markup;
  return {
    known: true, modelKey: resolved.modelKey, total,
    detail: `uncached ${input-cached} × $${resolved.price.input}/M + cached ${cached} × $${resolved.price.cached}/M + output ${output} × $${resolved.price.output}/M; fast ×${fast}; markup ×${markup}`
  };
}
module.exports = { resolvePrice, priceUsage };
