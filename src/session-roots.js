"use strict";
const path = require("path");

function scanRoots(root) {
  const result = [root];
  if (path.basename(path.normalize(root)).toLowerCase() === "sessions") {
    result.push(path.join(path.dirname(root), "archived_sessions"));
  }
  return result;
}
function dedupeFiles(files) {
  const found = new Set();
  const result = [];
  for (const file of files) {
    const base = path.basename(file.fullPath);
    const key = /^rollout-.*\.jsonl$/i.test(base) ? base.toLowerCase() : path.resolve(file.fullPath).toLowerCase();
    if (found.has(key)) continue;
    found.add(key);
    result.push(file);
  }
  return result.sort((a,b) => b.mtimeMs-a.mtimeMs);
}
module.exports = { scanRoots, dedupeFiles };
