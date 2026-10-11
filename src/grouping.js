"use strict";

// One rollout JSONL is one Codex conversation; each user prompt is a distinct turn.
function sessionGroupId(accountId, fileId) {
  return `session-${accountId}-${fileId}`;
}
function turnGroupId(accountId, fileId, index) {
  return `turn-${accountId}-${fileId}-${index}`;
}
module.exports = { sessionGroupId, turnGroupId };
