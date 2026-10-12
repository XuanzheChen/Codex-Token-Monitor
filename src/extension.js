"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const vscode = require("vscode");
const { resolvePrice, priceUsage } = require("./pricing");
const { scanRoots, dedupeFiles } = require("./session-roots");
const { sessionGroupId, turnGroupId } = require("./grouping");

const EXTENSION_ID = "codexTokenMonitor";
const TOKEN_EVENT = '"type":"token_count"';
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_TABLE = {
  "gpt-5.5": { input: 5, cached: 0.5, output: 30 },
  "gpt-5-codex": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-5.2-codex": { input: 1.75, cached: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cached: 0.175, output: 14 }
};

let monitor;
let currencyDisplay = { symbol: "$", rate: 1 };

function activate(context) {
  monitor = new CodexTokenMonitor(context);
  monitor.start();

  context.subscriptions.push(
    vscode.commands.registerCommand(`${EXTENSION_ID}.refresh`, () => monitor.refresh(true)),
    vscode.commands.registerCommand(`${EXTENSION_ID}.openLatestSession`, () => monitor.openLatestSession()),
    vscode.commands.registerCommand(`${EXTENSION_ID}.chooseSessionsRoot`, () => monitor.chooseSessionsRoot()),
    vscode.commands.registerCommand(`${EXTENSION_ID}.showDetails`, () => monitor.showDashboard()),
    monitor
  );
}

function deactivate() {
  if (monitor) {
    monitor.dispose();
  }
}

class CodexTokenMonitor {
  constructor(context) {
    this.context = context;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = `${EXTENSION_ID}.showDetails`;
    this.status.name = "Codex Token Monitor";
    this.watcher = undefined;
    this.interval = undefined;
    this.debounce = undefined;
    this.panel = undefined;
    this.disposed = false;
    this.refreshing = false;
    this.latestSession = undefined;
    this.latestUsage = undefined;
    this.latestTurnUsage = undefined;
    this.todayTotal = 0;
    this.lastError = undefined;
    this.dashboardData = undefined;
  }

  start() {
    this.status.text = "$(sync~spin) Codex tokens";
    this.status.tooltip = "Starting Codex token monitor...";
    this.status.show();

    this.configureWatchers();
    this.refresh(false);

    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`${EXTENSION_ID}.sessionsRoot`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.accounts`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.refreshIntervalMs`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.modelPrices`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.priceMultiplier`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.currencySymbol`) ||
          event.affectsConfiguration(`${EXTENSION_ID}.currencyRate`)
        ) {
          this.configureWatchers();
          this.refresh(true);
        }
      })
    );
  }

  dispose() {
    this.disposed = true;
    this.clearWatchers();
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    if (this.panel) {
      this.panel.dispose();
    }
    this.status.dispose();
  }

  get config() {
    return vscode.workspace.getConfiguration(EXTENSION_ID);
  }

  get sessionsRoot() {
    const configured = this.config.get("sessionsRoot", "").trim();
    return configured || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  }

  get refreshIntervalMs() {
    const value = this.config.get("refreshIntervalMs", 1000);
    return Math.max(250, Number(value) || 1000);
  }

  get accounts() {
    const configured = this.config.get("accounts", []);
    const valid = Array.isArray(configured)
      ? configured
        .map((account, index) => normalizeAccountConfig(account, index))
        .filter((account) => account && account.root)
      : [];

    if (valid.length > 0) {
      return valid;
    }

    const root = this.sessionsRoot;
    return [{
      id: stableAccountId(root),
      label: readAccountLabel(root) || "Default account",
      root
    }];
  }

  configureWatchers() {
    this.clearWatchers();

    for (const account of this.accounts) {
      for (const root of scanRoots(account.root)) {
        if (!fs.existsSync(root)) continue;
        try {
          const watcher = fs.watch(root, { recursive: true }, () => this.scheduleRefresh());
          if (!this.watcher) this.watcher = [];
          this.watcher.push(watcher);
        } catch (error) {
          this.lastError = readableError(error);
        }
      }
    }

    this.interval = setInterval(() => this.refresh(false), this.refreshIntervalMs);
  }

  clearWatchers() {
    if (Array.isArray(this.watcher)) {
      for (const watcher of this.watcher) {
        watcher.close();
      }
    }
    this.watcher = undefined;

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  scheduleRefresh() {
    if (this.debounce) {
      clearTimeout(this.debounce);
    }
    this.debounce = setTimeout(() => this.refresh(false), 150);
  }

  async refresh(manual) {
    if (this.disposed || this.refreshing) {
      return;
    }

    this.refreshing = true;
    try {
      const priceOptions = {
        modelPrices: this.config.get("modelPrices", {}),
        priceMultiplier: this.config.get("priceMultiplier", 1)
      };
      currencyDisplay = {
        symbol: this.config.get("currencySymbol", "$"),
        rate: this.config.get("currencyRate", 1)
      };
      const dashboardData = await buildDashboardData(this.accounts, priceOptions, currencyDisplay);
      const latest = findLatestAccountUsage(dashboardData.accounts);

      this.dashboardData = dashboardData;
      this.latestSession = latest && latest.session;
      this.latestUsage = latest && latest.usage;
      this.latestTurnUsage = latest && latest.turnUsage;
      this.todayTotal = dashboardData.totals.today.total_tokens;
      this.lastError = undefined;
      this.render();
      this.postDashboardData();

      if (manual) {
        vscode.window.setStatusBarMessage("Codex Token Monitor refreshed", 1500);
      }
    } catch (error) {
      this.lastError = readableError(error);
      this.status.text = "$(warning) Codex tokens";
      this.status.tooltip = `Codex Token Monitor error: ${this.lastError}`;
      if (manual) {
        vscode.window.showWarningMessage(`Codex Token Monitor refresh failed: ${this.lastError}`);
      }
    } finally {
      this.refreshing = false;
    }
  }

  render() {
    if (!this.dashboardData || this.dashboardData.files === 0) {
      this.status.text = "$(circle-slash) Codex tokens: no sessions";
      this.status.tooltip = this.accounts.map((account) => `No .jsonl files found in ${account.root}`).join("\n");
      return;
    }

    if (!this.latestUsage) {
      this.status.text = `$(pulse) Codex today ${formatCount(this.todayTotal)}`;
      this.status.tooltip = `Today: ${formatCount(this.todayTotal)} tokens`;
      return;
    }

    const usage = sessionGroupToUsage(this.latestUsage);
    const time = formatLocalTime(this.latestUsage.lastAt || this.latestUsage.timestamp);
    const input = numberOrZero(usage.input_tokens);
    const cached = numberOrZero(usage.cached_input_tokens);
    const total = numberOrZero(usage.total_tokens);
    const cachePercent = percentOf(cached, input);
    const cost = numberOrZero(this.latestUsage.cost);
    const missing = numberOrZero(this.latestUsage.unpriced);

    this.status.text = `$(pulse) ${time} Session ${formatCount(total)}(in ${formatCount(input)}, cache ${formatCount(cached)}${formatPercent(cachePercent)})  ${formatMoney(cost, missing)}`;
    this.status.tooltip = this.buildTooltip();
  }

  buildTooltip() {
    const usage = sessionGroupToUsage(this.latestUsage);
    const account = this.latestUsage.accountLabel || "Account";
    const cached = numberOrZero(usage.cached_input_tokens);
    const input = numberOrZero(usage.input_tokens);
    const modelSummary = summarizeModelBreakdown(this.latestUsage.modelBreakdown);
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;
    markdown.supportThemeIcons = true;
    markdown.appendMarkdown("### Codex Token Monitor\n\n");
    markdown.appendMarkdown("| Field | Value |\n|---|---|\n");
    markdown.appendMarkdown(`| Account | ${escapeMarkdown(account)} |\n`);
    markdown.appendMarkdown(`| Latest session | ${escapeMarkdown(this.latestSession.fullPath)} |\n`);
    markdown.appendMarkdown(`| Last update | ${escapeMarkdown(formatDateTime(this.latestUsage.lastAt || this.latestUsage.timestamp))} |\n\n`);
    markdown.appendMarkdown("| Usage | Detail |\n|---|---|\n");
    markdown.appendMarkdown(`| Session total | **${formatCount(numberOrZero(usage.total_tokens))}** · ${escapeMarkdown(modelSummary)} |\n`);
    markdown.appendMarkdown(`| Input | ${formatCount(input)} · Cache hit **${formatCount(cached)} / ${formatPercent(percentOf(cached, input))}** |\n`);
    markdown.appendMarkdown(`| Output | ${formatCount(numberOrZero(usage.output_tokens))} · Reasoning ${formatCount(numberOrZero(usage.reasoning_output_tokens))} |\n\n`);
    markdown.appendMarkdown(`**Session cost:** ${formatMoney(this.latestUsage.cost, this.latestUsage.unpriced)}\n\n`);
    if (this.latestTurnUsage) {
      markdown.appendMarkdown(`Latest turn (separate from session total): ${formatCount(this.latestTurnUsage.total)} tokens · ${formatMoney(this.latestTurnUsage.cost, this.latestTurnUsage.unpriced)}\n\n`);
    }
    // markdown.appendMarkdown("```text\n" + buildCostCalculation(this.latestUsage.modelBreakdown) + "\n```\n");
    if (this.lastError) {
      markdown.appendMarkdown(`\nLast watcher error: ${escapeMarkdown(this.lastError)}\n`);
    }
    markdown.appendMarkdown("\nClick to open dashboard.");
    return markdown;
  }

  async openLatestSession() {
    await this.refresh(false);
    if (!this.latestSession) {
      vscode.window.showInformationMessage("No Codex session file found.");
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.latestSession.fullPath);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  async chooseSessionsRoot() {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(this.sessionsRoot),
      openLabel: "Use this sessions folder",
      title: "Choose Codex sessions folder"
    });

    if (!selected || selected.length === 0) {
      return;
    }

    await this.config.update("sessionsRoot", selected[0].fsPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Codex sessions folder set to ${selected[0].fsPath}`);
  }

  showDashboard() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "codexTokenDashboard",
        "Codex Token Usage",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true
        }
      );
      this.panel.webview.html = getDashboardHtml(this.panel.webview, this.context.extensionUri);
      this.panel.webview.onDidReceiveMessage((message) => {
        if (!message || !message.command) {
          return;
        }
        if (message.command === "refresh") {
          this.refresh(true);
        } else if (message.command === "openLatestSession") {
          this.openLatestSession();
        } else if (message.command === "chooseSessionsRoot") {
          this.chooseSessionsRoot();
        }
      }, undefined, this.context.subscriptions);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      }, undefined, this.context.subscriptions);
    } else {
      this.panel.reveal(vscode.ViewColumn.One);
    }

    this.postDashboardData();
    this.refresh(false);
  }

  postDashboardData() {
    if (!this.panel) {
      return;
    }
    this.panel.webview.postMessage({
      command: "data",
      data: this.dashboardData || emptyDashboardData(this.accounts)
    });
  }
}

async function buildDashboardData(accounts, priceOptions, display) {
  const now = new Date();
  const todayStart = startOfLocalDay(now);
  const sevenStart = startOfLocalDay(addDays(now, -6));
  const monthStart = startOfLocalDay(addDays(now, -29));
  const todayEnd = todayStart + DAY_MS;
  const accountsData = [];
  let fileCount = 0;
  let sessionCount = 0;
  const seenRolloutFiles = new Set();

  for (const account of accounts) {
    const data = await buildAccountUsage(account, {
      todayStart,
      todayEnd,
      sevenStart,
      monthStart
    }, priceOptions, seenRolloutFiles);
    fileCount += data.files;
    sessionCount += data.sessionCounts.total;
    accountsData.push(data);
  }

  const totals = summarizeAccounts(accountsData, todayStart, sevenStart, monthStart);

  return {
    generatedAt: new Date().toISOString(),
    display,
    files: fileCount,
    sessions: sessionCount,
    sessionCounts: totals.sessionCounts,
    totals,
    accounts: accountsData
  };
}

async function buildAccountUsage(account, ranges, priceOptions, seenRolloutFiles) {
  const files = dedupeFiles((await Promise.all(scanRoots(account.root).filter(root => fs.existsSync(root)).map(root => findJsonlFiles(root)))).flat(), seenRolloutFiles);
  const candidates = files.filter((file) => file.mtimeMs >= ranges.monthStart - DAY_MS);
  const todayPoints = [];
  const todaySessionGroups = [];
  const dailyMap = new Map();
  const sessionMap = new Map();
  const turnMap = new Map();
  const todaySessionMap = new Map();
  const todaySessionIds = new Set();
  const sevenSessionIds = new Set();
  let latestDelta = undefined;
  let monthTotal = emptyUsage();
  let sevenTotal = emptyUsage();
  let todayTotal = emptyUsage();

  for (const file of candidates) {
    const stats = await readSessionStats(file.fullPath, ranges.monthStart, priceOptions);
    if (stats.events.length === 0) {
      continue;
    }

    for (const event of stats.events) {
      const time = new Date(event.timestamp).getTime();
      if (!Number.isFinite(time) || time < ranges.monthStart) {
        continue;
      }

      const fileId = stableAccountId(file.fullPath);
      const groupId = sessionGroupId(account.id, fileId);
      if (time >= ranges.sevenStart) sevenSessionIds.add(groupId);
      if (time >= ranges.todayStart && time < ranges.todayEnd) todaySessionIds.add(groupId);
      const turnId = turnGroupId(account.id, fileId, event.groupIndex);
      const group = getSessionGroup(sessionMap, groupId, account, file, event);
      addEventToSessionGroup(group, event);
      const turnGroup = getSessionGroup(turnMap, turnId, account, file, event);
      addEventToSessionGroup(turnGroup, event);

      monthTotal = addUsage(monthTotal, event.delta);
      addUsageToMap(dailyMap, localDateKey(event.timestamp), event.delta);

      if (time >= ranges.sevenStart) {
        sevenTotal = addUsage(sevenTotal, event.delta);
      }
      if (time >= ranges.todayStart && time < ranges.todayEnd) {
        const eventId = `event-${account.id}-${fileId}-${event.index}`;
        const todayGroup = getSessionGroup(todaySessionMap, turnId, account, file, event);
        addEventToSessionGroup(todayGroup, event);

        todayTotal = addUsage(todayTotal, event.delta);
        todayPoints.push({
          id: eventId,
          sessionId: turnId,
          timestamp: event.timestamp,
          time: formatLocalTime(event.timestamp),
          total: event.delta.total_tokens,
          input: event.delta.input_tokens,
          output: event.delta.output_tokens,
          cached: event.delta.cached_input_tokens,
          reasoning: event.delta.reasoning_output_tokens,
          cost: event.delta.cost_usd,
          inputCost: event.delta.input_cost_usd,
          outputCost: event.delta.output_cost_usd,
          unpriced: event.delta.unpriced_events,
          costCalculation: event.costCalculation,
          model: event.model,
          reasoningEffort: event.reasoningEffort,
          serviceTier: event.serviceTier,
          session: path.basename(file.fullPath),
          snippet: event.snippet
        });
      }

      if (!latestDelta || new Date(event.timestamp).getTime() > new Date(latestDelta.timestamp).getTime()) {
        latestDelta = {
          ...event,
          accountId: account.id,
          accountLabel: account.label,
          sessionId: groupId,
          session: { fullPath: file.fullPath }
        };
      }
    }
  }

  todayPoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const sessions = Array.from(sessionMap.values()).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime());
  const latestSessionGroup = sessions[0];
  const latestTurnGroup = Array.from(turnMap.values()).sort((a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime())[0];
  for (const group of todaySessionMap.values()) {
    if (group.eventCount > 0) {
      todaySessionGroups.push(group);
    }
  }
  todaySessionGroups.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());

  return {
    id: account.id,
    label: account.label,
    root: account.root,
    files: files.length,
    sessions: sessions.length,
    sessionCounts: {
      today: todaySessionIds.size,
      seven: sevenSessionIds.size,
      month: sessions.length,
      total: files.length
    },
    totals: {
      today: todayTotal,
      seven: sevenTotal,
      month: monthTotal
    },
    todayPoints,
    todaySessionGroups,
    sevenDays: buildDaySeries(ranges.sevenStart, 7, dailyMap),
    monthDays: buildDaySeries(ranges.monthStart, 30, dailyMap),
    recentSessions: sessions.slice(0, 20),
    latestSessionGroup,
    latestTurnGroup,
    latestDelta
  };
}

async function findJsonlFiles(root) {
  const files = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        return;
      }

      try {
        const stat = await fs.promises.stat(fullPath);
        files.push({ fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Codex may be writing or rotating the file while we scan it.
      }
    }));
  }

  await walk(root);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

function getSessionGroup(map, id, account, file, event) {
  if (!map.has(id)) {
    map.set(id, {
      id,
      accountId: account.id,
      account: account.label,
      file: file.fullPath,
      name: path.basename(file.fullPath),
      startedAt: event.timestamp,
      lastAt: event.timestamp,
      input: 0,
      output: 0,
      total: 0,
      cached: 0,
      reasoning: 0,
      cost: 0,
      inputCost: 0,
      outputCost: 0,
      unpriced: 0,
      eventCount: 0,
      turnCount: 0,
      eventIds: [],
      modelUsage: {},
      modelBreakdown: [],
      snippet: event.snippet
    });
  }
  return map.get(id);
}

function addEventToSessionGroup(group, event) {
  group.lastAt = event.timestamp;
  group.input += event.delta.input_tokens;
  group.output += event.delta.output_tokens;
  group.total += event.delta.total_tokens;
  group.cached += event.delta.cached_input_tokens;
  group.reasoning += event.delta.reasoning_output_tokens;
  group.cost += event.delta.cost_usd;
  group.inputCost += event.delta.input_cost_usd || 0;
  group.outputCost += event.delta.output_cost_usd || 0;
  group.unpriced += event.delta.unpriced_events || 0;
  group.eventCount += 1;
  group.turnCount = Math.max(group.turnCount, event.groupIndex || 1);
  group.eventIds.push(event.index);
  addModelUsage(group.modelUsage, event);
  group.modelBreakdown = modelUsageToBreakdown(group.modelUsage);
  if (event.snippet && event.snippet !== "(no prompt)") {
    group.snippet = event.snippet;
  }
}

async function readSessionStats(file, minTimestamp, priceOptions) {
  let previous = emptyUsage();
  let total = emptyUsage();
  let firstTimestamp = undefined;
  let lastTimestamp = undefined;
  let latestEvent = undefined;
  let currentSnippet = "";
  let currentModel = "unknown";
  let currentReasoningEffort = "unknown";
  let currentServiceTier = "standard";
  let eventIndex = 0;
  let groupIndex = 0;
  const events = [];

  try {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const meta = parseSessionMeta(line);
      if (meta && meta.timestamp && !firstTimestamp) {
        firstTimestamp = meta.timestamp;
      }

      const snippet = parseConversationSnippet(line);
      if (snippet) {
        currentSnippet = snippet;
        groupIndex += 1;
      }

      const context = parseRunContext(line);
      if (context.model) {
        currentModel = context.model;
      }
      if (context.reasoningEffort) {
        currentReasoningEffort = context.reasoningEffort;
      }
      if (context.serviceTier) {
        currentServiceTier = context.serviceTier;
      }

      const event = parseTokenEvent(line);
      if (!event || !event.total) {
        continue;
      }

      const current = normalizeUsage(event.total);
      const delta = subtractUsage(current, previous);
      const model = event.model || currentModel;
      const reasoningEffort = event.reasoningEffort || currentReasoningEffort;
      const serviceTier = event.serviceTier || currentServiceTier;
      const cost = calculateUsageCost(delta, model, serviceTier, priceOptions);
      delta.cost_usd = cost.total;
      delta.input_cost_usd = cost.inputCost;
      delta.output_cost_usd = cost.outputCost;
      delta.unpriced_events = cost.known ? 0 : 1;
      previous = current;

      if (!hasUsage(delta)) {
        continue;
      }

      total = addUsage(total, delta);
      lastTimestamp = event.timestamp;
      if (!firstTimestamp) {
        firstTimestamp = event.timestamp;
      }

      const item = {
        index: eventIndex,
        groupIndex,
        timestamp: event.timestamp,
        delta,
        cumulative: current,
        contextWindow: event.contextWindow,
        model,
        reasoningEffort,
        serviceTier,
        cost: cost.total,
        costCalculation: cost.calculation,
        snippet: truncateSnippet(currentSnippet, 20)
      };
      latestEvent = item;
      eventIndex += 1;

      if (!minTimestamp || new Date(event.timestamp).getTime() >= minTimestamp) {
        events.push(item);
      }
    }
  } catch {
    return { events, total, latestEvent, firstTimestamp, lastTimestamp };
  }

  return { events, total, latestEvent, firstTimestamp, lastTimestamp };
}

function parseSessionMeta(line) {
  if (!line || !line.includes('"type":"session_meta"')) {
    return undefined;
  }
  try {
    const json = JSON.parse(line);
    return json && json.payload;
  } catch {
    return undefined;
  }
}

function parseTokenEvent(line) {
  if (!line || !line.includes(TOKEN_EVENT)) {
    return undefined;
  }

  try {
    const json = JSON.parse(line);
    const payload = json && json.payload;
    if (!payload || payload.type !== "token_count" || !payload.info) {
      return undefined;
    }

    const info = payload.info || payload;
    const total = info.total_token_usage || extractInlineTokenUsage(info);
    if (!total) {
      return undefined;
    }

    return {
      timestamp: json.timestamp,
      total,
      contextWindow: info.model_context_window,
      model: normalizeModelName(findFirstValue(info, ["model", "model_id", "modelId"])),
      reasoningEffort: normalizeLabel(findFirstValue(info, ["reasoning_effort", "reasoningEffort", "effort"])),
      serviceTier: normalizeServiceTier(findFirstValue(info, ["service_tier", "serviceTier", "mode", "tier"]))
    };
  } catch {
    return undefined;
  }
}

function parseRunContext(line) {
  if (!line || (!line.includes("model") && !line.includes("reasoning") && !line.includes("service") && !line.includes("tier"))) {
    return {};
  }

  try {
    const json = JSON.parse(line);
    return {
      model: normalizeModelName(findFirstValue(json, ["model", "model_id", "modelId"])),
      reasoningEffort: normalizeLabel(findFirstValue(json, ["reasoning_effort", "reasoningEffort", "effort"])),
      serviceTier: normalizeServiceTier(findFirstValue(json, ["service_tier", "serviceTier", "mode", "tier"]))
    };
  } catch {
    return {};
  }
}

function findFirstValue(value, keys) {
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== "object" || seen.has(node)) {
      return undefined;
    }
    seen.add(node);

    for (const key of keys) {
      if (typeof node[key] === "string" || typeof node[key] === "number") {
        return node[key];
      }
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const result = visit(item);
        if (result !== undefined) {
          return result;
        }
      }
      return undefined;
    }

    for (const item of Object.values(node)) {
      const result = visit(item);
      if (result !== undefined) {
        return result;
      }
    }
    return undefined;
  }

  return visit(value);
}

function parseConversationSnippet(line) {
  if (!line || !line.includes('"role":"user"')) {
    return "";
  }

  try {
    const json = JSON.parse(line);
    const payload = json && json.payload;
    if (!payload || payload.type !== "message" || payload.role !== "user") {
      return "";
    }

    return extractText(payload.content);
  } catch {
    return "";
  }
}

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      return item && (item.text || item.input_text || item.content || "");
    }).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return value.text || value.input_text || value.content || "";
  }
  return "";
}

function truncateSnippet(value, length) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return "(no prompt)";
  }
  return normalized.length > length ? `${normalized.slice(0, length)}...` : normalized;
}

function extractInlineTokenUsage(value) {
  if (value && (
    value.input_tokens !== undefined ||
    value.cached_input_tokens !== undefined ||
    value.output_tokens !== undefined ||
    value.reasoning_output_tokens !== undefined ||
    value.total_tokens !== undefined
  )) {
    return value;
  }
  return undefined;
}

function normalizeAccountConfig(account, index) {
  if (!account || typeof account !== "object") {
    return undefined;
  }
  const root = String(account.sessionsRoot || account.root || "").trim();
  if (!root) {
    return undefined;
  }
  const label = String(account.label || account.name || readAccountLabel(root) || `Account ${index + 1}`).trim();
  return {
    id: String(account.id || stableAccountId(root)).trim(),
    label,
    root: expandHome(root)
  };
}

function readAccountLabel(sessionsRoot) {
  const authPath = path.join(path.dirname(sessionsRoot), "auth.json");
  try {
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const id = auth.account_id ||
      auth.openai_account_id ||
      auth.accountId ||
      (auth.tokens && (auth.tokens.account_id || auth.tokens.accountId || auth.tokens.openai_account_id));
    if (id) {
      return `Account ${String(id).slice(0, 8)}`;
    }
  } catch {
    // auth.json is optional and may not exist for custom session folders.
  }
  return undefined;
}

function stableAccountId(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `acct-${(hash >>> 0).toString(16)}`;
}

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function summarizeAccounts(accounts, todayStart, sevenStart, monthStart) {
  const allTodayPoints = [];
  const allTodaySessionGroups = [];
  const dailyMap = new Map();
  let today = emptyUsage();
  let seven = emptyUsage();
  let month = emptyUsage();
  const sessionCounts = { today: 0, seven: 0, month: 0, total: 0 };

  for (const account of accounts) {
    for (const key of Object.keys(sessionCounts)) {
      sessionCounts[key] += numberOrZero(account.sessionCounts && account.sessionCounts[key]);
    }
    today = addUsage(today, account.totals.today);
    seven = addUsage(seven, account.totals.seven);
    month = addUsage(month, account.totals.month);
    for (const point of account.todayPoints) {
      allTodayPoints.push({ ...point, account: account.label });
    }
    for (const group of account.todaySessionGroups) {
      allTodaySessionGroups.push({ ...group, account: account.label });
    }
    for (const day of account.monthDays) {
      addUsageToMap(dailyMap, day.key, {
        total_tokens: day.total,
        input_tokens: day.input,
        output_tokens: day.output,
        cached_input_tokens: day.cached,
        reasoning_output_tokens: day.reasoning,
        cost_usd: day.cost,
        input_cost_usd: day.inputCost,
        output_cost_usd: day.outputCost,
        unpriced_events: day.unpriced
      });
    }
  }

  allTodayPoints.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    today,
    seven,
    month,
    sessionCounts,
    todayPoints: allTodayPoints,
    todaySessionGroups: allTodaySessionGroups,
    sevenDays: buildDaySeries(sevenStart, 7, dailyMap),
    monthDays: buildDaySeries(monthStart, 30, dailyMap),
    todayStart
  };
}

function findLatestAccountUsage(accounts) {
  let latest = undefined;
  for (const account of accounts) {
    const group = account.latestSessionGroup;
    if (!group) continue;

    // Status bar and "Session cost" refer to the entire rollout, not its
    // most recent prompt turn (which can cover only one model/effort).
    const sessionUsage = {
      ...group,
      accountId: account.id,
      accountLabel: account.label
    };
    if (!latest || new Date(sessionUsage.lastAt).getTime() > new Date(latest.usage.lastAt).getTime()) {
      latest = {
        session: { fullPath: group.file },
        usage: sessionUsage,
        turnUsage: account.latestTurnGroup && account.latestTurnGroup.file === group.file
          ? account.latestTurnGroup
          : undefined
      };
    }
  }
  return latest;
}

function buildDaySeries(startMs, count, dailyMap) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(startMs + index * DAY_MS);
    const key = localDateKey(date.toISOString());
    const usage = dailyMap.get(key) || emptyUsage();
    return {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      total: usage.total_tokens,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cached: usage.cached_input_tokens,
      reasoning: usage.reasoning_output_tokens,
      cost: usage.cost_usd,
      inputCost: usage.input_cost_usd,
      outputCost: usage.output_cost_usd,
      unpriced: usage.unpriced_events
    };
  });
}

function addUsageToMap(map, key, usage) {
  map.set(key, addUsage(map.get(key) || emptyUsage(), usage));
}

function emptyDashboardData(accounts) {
  return {
    generatedAt: new Date().toISOString(),
    files: 0,
    sessions: 0,
    sessionCounts: { today: 0, seven: 0, month: 0, total: 0 },
    totals: {
      today: emptyUsage(),
      seven: emptyUsage(),
      month: emptyUsage(),
      todayPoints: [],
      todaySessionGroups: [],
      sevenDays: [],
      monthDays: []
    },
    accounts: accounts.map((account) => ({
      id: account.id,
      label: account.label,
      root: account.root,
      files: 0,
      sessions: 0,
      sessionCounts: { today: 0, seven: 0, month: 0, total: 0 },
      totals: { today: emptyUsage(), seven: emptyUsage(), month: emptyUsage() },
      todayPoints: [],
      todaySessionGroups: [],
      sevenDays: [],
      monthDays: [],
      recentSessions: []
    }))
  };
}

function emptyUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    input_cost_usd: 0,
    output_cost_usd: 0,
    unpriced_events: 0
  };
}

function normalizeUsage(usage) {
  const normalized = {
    input_tokens: numberOrZero(usage.input_tokens),
    cached_input_tokens: numberOrZero(usage.cached_input_tokens),
    output_tokens: numberOrZero(usage.output_tokens),
    reasoning_output_tokens: numberOrZero(usage.reasoning_output_tokens ?? usage.reasoning_tokens),
    total_tokens: numberOrZero(usage.total_tokens)
  };

  if (normalized.total_tokens === 0) {
    normalized.total_tokens = normalized.input_tokens + normalized.output_tokens;
  }

  return normalized;
}

function subtractUsage(current, previous) {
  return {
    input_tokens: positiveDelta(current.input_tokens, previous.input_tokens),
    cached_input_tokens: positiveDelta(current.cached_input_tokens, previous.cached_input_tokens),
    output_tokens: positiveDelta(current.output_tokens, previous.output_tokens),
    reasoning_output_tokens: positiveDelta(current.reasoning_output_tokens, previous.reasoning_output_tokens),
    total_tokens: positiveDelta(current.total_tokens, previous.total_tokens)
  };
}

function addUsage(left, right) {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    reasoning_output_tokens: left.reasoning_output_tokens + right.reasoning_output_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
    cost_usd: numberOrZero(left.cost_usd) + numberOrZero(right.cost_usd),
    input_cost_usd: numberOrZero(left.input_cost_usd) + numberOrZero(right.input_cost_usd),
    output_cost_usd: numberOrZero(left.output_cost_usd) + numberOrZero(right.output_cost_usd),
    unpriced_events: numberOrZero(left.unpriced_events) + numberOrZero(right.unpriced_events)
  };
}

function positiveDelta(current, previous) {
  return Math.max(numberOrZero(current) - numberOrZero(previous), 0);
}

function hasUsage(usage) {
  return numberOrZero(usage.total_tokens) > 0 ||
    numberOrZero(usage.input_tokens) > 0 ||
    numberOrZero(usage.output_tokens) > 0 ||
    numberOrZero(usage.cached_input_tokens) > 0 ||
    numberOrZero(usage.reasoning_output_tokens) > 0;
}

function sessionGroupToUsage(group) {
  return {
    input_tokens: numberOrZero(group && group.input),
    cached_input_tokens: numberOrZero(group && group.cached),
    output_tokens: numberOrZero(group && group.output),
    reasoning_output_tokens: numberOrZero(group && group.reasoning),
    total_tokens: numberOrZero(group && group.total),
    cost_usd: numberOrZero(group && group.cost),
    input_cost_usd: numberOrZero(group && group.inputCost),
    output_cost_usd: numberOrZero(group && group.outputCost),
    unpriced_events: numberOrZero(group && group.unpriced)
  };
}

function addModelUsage(modelUsage, event) {
  const model = normalizeModelName(event.model) || "unknown";
  const reasoningEffort = normalizeLabel(event.reasoningEffort) || "unknown";
  const serviceTier = normalizeServiceTier(event.serviceTier) || "standard";
  const key = `${model}|${reasoningEffort}|${serviceTier}`;
  if (!modelUsage[key]) {
    modelUsage[key] = {
      model,
      reasoningEffort,
      serviceTier,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      cost: 0,
      unpriced: 0,
      calculations: []
    };
  }
  const item = modelUsage[key];
  item.input += event.delta.input_tokens;
  item.cached += event.delta.cached_input_tokens;
  item.output += event.delta.output_tokens;
  item.reasoning += event.delta.reasoning_output_tokens;
  item.total += event.delta.total_tokens;
  item.cost += event.delta.cost_usd;
  item.unpriced += event.delta.unpriced_events || 0;
  if (event.costCalculation && !item.calculations.includes(event.costCalculation)) {
    item.calculations.push(event.costCalculation);
  }
}

function modelUsageToBreakdown(modelUsage) {
  return Object.values(modelUsage || {})
    .sort((a, b) => b.cost - a.cost)
    .map((item) => ({
      ...item,
      cachePercent: percentOf(item.cached, item.input),
      calculation: item.calculations.join("\n")
    }));
}

function calculateUsageCost(usage, model, serviceTier, options = {}) {
  const result = priceUsage(usage, model, serviceTier, PRICE_TABLE, options);
  const description = result.known
    ? `${result.modelKey} / ${serviceTier || "standard"}: ${result.detail}; USD ${result.total.toFixed(6)}`
    : `${model || "unknown"}: price unavailable; configure codexTokenMonitor.modelPrices`;
  return { total: result.total, inputCost: result.inputCost || 0, outputCost: result.outputCost || 0, known: result.known, calculation: description };
}

function normalizeModelName(value) {
  const normalized = normalizeLabel(value);
  return normalized && normalized !== "unknown" ? normalized : undefined;
}

function normalizeLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  return label || undefined;
}

function normalizeServiceTier(value) {
  const tier = normalizeLabel(value);
  if (!tier) {
    return undefined;
  }
  if (tier.includes("fast")) {
    return "fast";
  }
  if (tier.includes("standard")) {
    return "standard";
  }
  return tier;
}

function isFastMode(value) {
  return normalizeServiceTier(value) === "fast";
}

function percentOf(part, whole) {
  const denominator = numberOrZero(whole);
  return denominator > 0 ? (numberOrZero(part) / denominator) * 100 : 0;
}

function formatPercent(value) {
  return `${trimFixed(numberOrZero(value))}%`;
}

function formatMoney(value, unpriced = 0) {
  if (unpriced > 0) return "N/A";
  const rate = Number(currencyDisplay.rate);
  const amount = numberOrZero(value) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  const symbol = String(currencyDisplay.symbol || "$");
  return symbol + amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2);
}

function summarizeModelBreakdown(breakdown) {
  const models = Array.isArray(breakdown) ? breakdown : [];
  if (models.length === 0) {
    return "unknown model";
  }
  if (models.length === 1) {
    const item = models[0];
    return `${item.model} / ${item.reasoningEffort || "unknown"} / ${item.serviceTier || "standard"}`;
  }
  return `${models.length} model/effort combinations`;
}

function buildCostCalculation(breakdown) {
  const models = Array.isArray(breakdown) ? breakdown : [];
  if (models.length === 0) {
    return "No priced model data for this session.";
  }
  return models.map((item) => item.calculation || `${item.model}: price unavailable`).join("\n");
}

function escapeMarkdown(value) {
  return String(value == null ? "" : value).replace(/[\\|*_`[\]]/g, "\\$&");
}

function startOfLocalDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

function addDays(date, days) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatDateTime(timestamp) {
  const date = timestamp ? new Date(timestamp) : new Date();
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatCount(value) {
  const number = numberOrZero(value);
  if (number >= 1000000) {
    return `${trimFixed(number / 1000000)}m`;
  }
  if (number >= 1000) {
    return `${trimFixed(number / 1000)}k`;
  }
  return String(number);
}

function trimFixed(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function readableError(error) {
  return error && error.message ? error.message : String(error);
}

function getDashboardHtml() {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Codex Token Usage</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --panel: var(--vscode-sideBar-background);
      --line: var(--vscode-panel-border);
      --accent: var(--vscode-charts-blue);
      --accent2: var(--vscode-charts-green);
      --accent3: var(--vscode-charts-orange);
      --danger: var(--vscode-charts-red);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    main { padding: 18px 20px 28px; max-width: 1280px; margin: 0 auto; }
    header { display: flex; gap: 14px; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
    h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    .subtle { color: var(--muted); font-size: 12px; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    select, button {
      color: var(--fg);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      min-height: 28px;
      padding: 3px 8px;
      font: inherit;
    }
    button { cursor: pointer; background: var(--vscode-button-secondaryBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .summary { display: grid; grid-template-columns: repeat(2, minmax(220px, 1fr)); gap: 10px; margin: 12px 0 16px; }
    .metric, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .metric { padding: 12px; min-height: 76px; }
    .metric .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .metric .value { font-size: 24px; font-weight: 700; line-height: 1.1; }
    .metric .detail { color: var(--muted); font-size: 11px; margin-top: 5px; }
    .metric .primary-line { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .metric .cached-stat { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
    .metric .cached-label { color: var(--muted); font-size: 12px; font-weight: 400; }
    .metric .cached-total { color: var(--fg); font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .metric .value { font-variant-numeric: tabular-nums; }
    .session-stats { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 8px; margin-top: 9px; }
    .session-stats .stat-label { color: var(--muted); font-size: 11px; }
    .session-stats .stat-value { font-weight: 650; font-size: 19px; }
    @media (max-width: 660px) {
      .summary { grid-template-columns: minmax(0,1fr); }
      .session-stats { grid-template-columns: repeat(2,minmax(0,1fr)); }
    }
    .grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 12px; }
    .panel { padding: 14px; min-width: 0; }
    .panel h2 { margin: 0 0 10px; font-size: 14px; font-weight: 650; }
    .model-panel { margin-bottom: 12px; }
    .chart { height: 220px; width: 100%; border-top: 1px solid var(--line); padding-top: 10px; }
    .chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
    .axis { stroke: var(--line); stroke-width: 1; }
    .bar { fill: var(--accent); }
    .bar-output { fill: var(--accent2); }
    .point { cursor: pointer; transition: transform 120ms ease, r 120ms ease, stroke-width 120ms ease; transform-box: fill-box; transform-origin: center; }
    .point.active { transform: scale(1.55); stroke: var(--vscode-editor-foreground); stroke-width: 1.5; }
    .line-segment { fill: none; stroke-width: 1.2; stroke-linecap: round; opacity: .82; }
    .session-ring { fill: none; stroke-width: 2.4; opacity: .9; cursor: pointer; transition: stroke-width 120ms ease, opacity 120ms ease; pointer-events: stroke; }
    .session-ring.active { stroke-width: 4.2; opacity: 1; }
    .hover-line { opacity: .55; stroke-width: 3.4; }
    .tick { fill: var(--muted); font-size: 10px; }
    .legend { display: flex; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 11px; margin-bottom: 8px; }
    .key { display: inline-flex; align-items: center; gap: 5px; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; background: var(--accent); }
    .swatch.output { background: var(--accent2); }
    .swatch.point { background: var(--accent3); }
    .range-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .range-select { font-size: 14px; font-weight: 650; padding: 0 20px 0 0; min-height: 27px; color: var(--fg); background-color: transparent; border: 0; cursor: pointer; }
    .range-select:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
    .range-note { font-size: 10px; color: var(--muted); }
    .bar-group { cursor: pointer; }
    .chart-tip {
      position: fixed;
      display: none;
      z-index: 20;
      pointer-events: none;
      padding: 6px 8px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      box-shadow: 0 4px 12px rgba(0,0,0,.18);
      font-size: 12px;
      max-width: 330px;
      white-space: pre-line;
    }
    table { width: 100%; border-collapse: separate; border-spacing: 0 5px; font-size: 12px; }
    th, td { text-align: left; padding: 7px 6px; white-space: nowrap; }
    th { color: var(--muted); font-weight: 500; }
    tbody tr { cursor: pointer; transition: outline 120ms ease, filter 120ms ease; }
    tbody tr.active { outline: 1px solid var(--vscode-focusBorder); filter: brightness(1.1) saturate(1.08); }
    tbody td:first-child { border-radius: 4px 0 0 4px; }
    tbody td:last-child { border-radius: 0 4px 4px 0; }
    td.dialog { max-width: 190px; overflow: hidden; text-overflow: ellipsis; }
    .money { color: var(--accent2); font-weight: 650; }
    #eventsTable, #sessionsTable { max-height: 520px; overflow: auto; }
    .empty { color: var(--muted); padding: 24px; text-align: center; border: 1px dashed var(--line); border-radius: 6px; }
    .empty.compact { padding: 10px; }
    .stack { display: grid; gap: 12px; }
    @media (max-width: 840px) {
      header { display: block; }
      .toolbar { justify-content: flex-start; margin-top: 12px; }
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Codex Token Usage</h1>
        <div id="subtitle" class="subtle">Loading usage data...</div>
      </div>
      <div class="toolbar">
        <select id="accountSelect" title="Account filter"></select>
        <button id="refreshButton" class="primary" title="Refresh">Refresh</button>
        <button id="openButton" title="Open latest session">Open Latest</button>
        <button id="folderButton" title="Choose sessions folder">Folder</button>
      </div>
    </header>
    <section class="panel model-panel">
      <h2>Models Used This Session</h2>
      <div id="modelTable"></div>
    </section>
    <section class="summary" id="summary"></section>
    <section class="grid">
      <div class="stack">
        <section class="panel">
          <h2>Today Timeline</h2>
          <div class="legend">
            <span class="key"><span class="swatch point"></span>Total delta per event</span>
          </div>
          <div class="chart" id="todayChart"></div>
        </section>
        <section class="panel">
          <div class="range-heading">
            <select id="usageRangeSelect" class="range-select" aria-label="Select history range" title="Switch between 7 and 30 days">
              <option value="7">Last 7 Days</option>
              <option value="30">Last 30 Days</option>
            </select>
          </div>
          <div class="legend">
            <span class="key"><span class="swatch"></span>Input (left scale)</span>
            <span class="key"><span class="swatch output"></span>Output (right scale)</span>
            <span class="range-note">Independent scales make small output totals visible</span>
          </div>
          <div class="chart" id="usageChart"></div>
        </section>
      </div>
      <div class="stack">
        <section class="panel">
          <h2>Today Events</h2>
          <div id="eventsTable"></div>
        </section>
        <section class="panel">
          <h2>Recent Sessions</h2>
          <div id="sessionsTable"></div>
        </section>
      </div>
    </section>
    <div id="chartTip" class="chart-tip"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { data: null, accountId: "all", rangeDays: 7 };

    document.getElementById("refreshButton").addEventListener("click", () => vscode.postMessage({ command: "refresh" }));
    document.getElementById("openButton").addEventListener("click", () => vscode.postMessage({ command: "openLatestSession" }));
    document.getElementById("folderButton").addEventListener("click", () => vscode.postMessage({ command: "chooseSessionsRoot" }));
    document.getElementById("usageRangeSelect").addEventListener("change", event => {
      state.rangeDays = Number(event.target.value) === 30 ? 30 : 7;
      render();
    });
    document.getElementById("accountSelect").addEventListener("change", (event) => {
      state.accountId = event.target.value;
      render();
    });

    window.addEventListener("message", (event) => {
      if (event.data.command === "data") {
        state.data = event.data.data;
        renderAccounts();
        render();
      }
    });

    function renderAccounts() {
      const select = document.getElementById("accountSelect");
      const current = select.value || state.accountId;
      const accounts = state.data ? state.data.accounts : [];
      select.innerHTML = '<option value="all">All accounts</option>' + accounts.map((account) =>
        '<option value="' + escapeHtml(account.id) + '">' + escapeHtml(account.label) + '</option>'
      ).join("");
      state.accountId = accounts.some((account) => account.id === current) ? current : "all";
      select.value = state.accountId;
    }

    function activeData() {
      if (!state.data) return null;
      if (state.accountId === "all") {
        return {
          label: "All accounts",
          root: state.data.accounts.map((account) => account.root).join("; "),
          files: state.data.files,
          sessions: state.data.sessions,
          sessionCounts: state.data.sessionCounts || state.data.totals.sessionCounts || { today: 0, seven: 0, month: 0, total: 0 },
          totals: state.data.totals,
          todayPoints: state.data.totals.todayPoints,
          todaySessionGroups: state.data.totals.todaySessionGroups,
          sevenDays: state.data.totals.sevenDays,
          monthDays: state.data.totals.monthDays,
          latestSessionGroup: state.data.accounts.flatMap((account) => account.latestSessionGroup ? [{ ...account.latestSessionGroup, account: account.label }] : []).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt))[0],
          recentSessions: state.data.accounts.flatMap((account) => account.recentSessions.map((session) => ({ ...session, account: account.label }))).sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt)).slice(0, 20)
        };
      }
      return state.data.accounts.find((account) => account.id === state.accountId) || state.data.accounts[0];
    }

    function render() {
      const data = activeData();
      if (!data) return;
      document.getElementById("subtitle").textContent = data.root || "No sessions folder";
      renderModelTable(data.latestSessionGroup);
      renderSummary(data);
      renderTimeline("todayChart", data.todayPoints || [], data.todaySessionGroups || []);
      document.getElementById("usageRangeSelect").value = String(state.rangeDays);
      renderBars("usageChart", state.rangeDays === 30 ? (data.monthDays || []) : (data.sevenDays || []));
      renderSessions(data.recentSessions || []);
      renderEvents(data.todayPoints || []);
    }

    function renderSummary(data) {
      const today = data.totals.today || {};
      const seven = data.totals.seven || {};
      const month = data.totals.month || {};
      document.getElementById("summary").innerHTML = [
        periodMetric("Today", today),
        periodMetric("7 Days", seven),
        periodMetric("30 Days", month),
        sessionsMetric(data.sessionCounts || {})
      ].join("");
    }

    function periodMetric(label, usage) {
      return '<div class="metric">' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="primary-line"><div class="value">' + fmt(usage.total_tokens) + '</div>' +
        '<div class="cached-stat"><span class="cached-label">Cached</span><strong class="cached-total">' +
        fmt(usage.cached_input_tokens) + '</strong></div></div>' +
        '<div class="detail">' + escapeHtml(money(usage.cost_usd, usage.unpriced_events)) +
        ' · input ' + fmt(usage.input_tokens) + ' / output ' + fmt(usage.output_tokens) + '</div>' +
        '<div class="detail">Cache hit ' + pct(usage.cached_input_tokens, usage.input_tokens) +
        ' · Output / input ' + ratioPct(usage.output_tokens, usage.input_tokens) + '</div>' +
        '</div>';
    }

    function sessionsMetric(counts) {
      const entries = [
        ["Today", counts.today], ["7 Days", counts.seven],
        ["30 Days", counts.month], ["Total", counts.total]
      ];
      return '<div class="metric sessions-metric">' +
        '<div class="label">Sessions</div><div class="session-stats">' +
        entries.map(([label, count]) => '<div><div class="stat-label">' + label +
          '</div><div class="stat-value">' + fmt(count) + '</div></div>').join("") +
        '</div><div class="detail">Unique rollout files; a session is active when a token event occurs in the period.</div></div>';
    }

    function ratioPct(part, whole) {
      const total = Number(whole) || 0;
      if (total <= 0) return "0%";
      const ratio = (Number(part) || 0) / total * 100;
      return (ratio < 1 ? ratio.toFixed(2) : trim(ratio)) + "%";
    }

    function renderModelTable(session) {
      const host = document.getElementById("modelTable");
      const models = session && Array.isArray(session.modelBreakdown) ? session.modelBreakdown : [];
      if (!models.length) {
        host.innerHTML = '<div class="empty compact">No priced model data for the latest session.</div>';
        return;
      }
      host.innerHTML = '<table><thead><tr><th>Model</th><th>Reasoning</th><th>Mode</th><th>Input</th><th>Cache</th><th>Output</th><th>Total</th><th>Cost</th></tr></thead><tbody>' +
        models.map((item) => '<tr title="' + escapeHtml(item.calculation || "") + '"><td>' + escapeHtml(item.model) + '</td><td>' + escapeHtml(item.reasoningEffort || "unknown") + '</td><td>' + escapeHtml(item.serviceTier || "standard") + '</td><td>' + fmt(item.input) + '</td><td>' + fmt(item.cached) + ' / ' + pct(item.cached, item.input) + '</td><td>' + fmt(item.output) + '</td><td>' + fmt(item.total) + '</td><td class="money">' + money(item.cost, item.unpriced) + '</td></tr>').join("") +
        '</tbody></table>';
    }

    function renderTimeline(id, points, sessionGroups) {
      const host = document.getElementById(id);
      if (!points.length) {
        host.innerHTML = '<div class="empty">No token events today.</div>';
        return;
      }
      const width = 760;
      const height = 210;
      const pad = 34;
      const times = points.map((point) => new Date(point.timestamp).getTime());
      const minTime = Math.min(...times);
      const maxTime = Math.max(...times);
      const maxValue = Math.max(...points.map((point) => point.total), 1);
      const maxSessionValue = Math.max(maxValue, ...(sessionGroups || []).map((group) => group.total || 0), 1);
      const span = Math.max(maxTime - minTime, 1);
      const coords = points.map((point) => {
        const x = pad + ((new Date(point.timestamp).getTime() - minTime) / span) * (width - pad * 2);
        const y = height - pad - (point.total / maxValue) * (height - pad * 2);
        return { x, y, point };
      });
      const coordById = new Map(coords.map((item) => [item.point.id, item]));
      const sessionRings = buildSessionRings(sessionGroups || [], points, coordById, maxSessionValue);
      const gradients = coords.slice(0, -1).map((item, index) => {
        const next = coords[index + 1];
        return '<linearGradient id="tl-grad-' + index + '" gradientUnits="userSpaceOnUse" x1="' + item.x.toFixed(1) + '" y1="' + item.y.toFixed(1) + '" x2="' + next.x.toFixed(1) + '" y2="' + next.y.toFixed(1) + '">' +
          '<stop offset="0%" stop-color="' + tokenColor(item.point.total, maxValue) + '"></stop>' +
          '<stop offset="100%" stop-color="' + tokenColor(next.point.total, maxValue) + '"></stop>' +
          '</linearGradient>';
      }).join("");
      const segments = coords.slice(0, -1).map((item, index) => {
        const next = coords[index + 1];
        return '<line class="line-segment" x1="' + item.x.toFixed(1) + '" y1="' + item.y.toFixed(1) + '" x2="' + next.x.toFixed(1) + '" y2="' + next.y.toFixed(1) + '" stroke="url(#tl-grad-' + index + ')"></line>';
      }).join("");
      const ticks = buildTimeTicks(minTime, maxTime, width, pad).map((tick) =>
        '<text class="tick" text-anchor="' + tick.anchor + '" x="' + tick.x.toFixed(1) + '" y="' + (height - 8) + '">' + escapeHtml(tick.label) + '</text>'
      ).join("");
      host.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img">' +
        '<defs>' + gradients + '</defs>' +
        '<line class="axis" x1="' + pad + '" y1="' + (height - pad) + '" x2="' + (width - pad) + '" y2="' + (height - pad) + '"></line>' +
        segments +
        sessionRings.map((ring) => '<circle class="session-ring" data-session-id="' + escapeHtml(ring.id) + '" cx="' + ring.x.toFixed(1) + '" cy="' + ring.y.toFixed(1) + '" r="' + ring.r.toFixed(1) + '" stroke="' + ring.color + '"><title>' + escapeHtml(ring.title) + '</title></circle>').join("") +
        coords.map((item) => '<circle class="point" data-event-id="' + escapeHtml(item.point.id) + '" cx="' + item.x.toFixed(1) + '" cy="' + item.y.toFixed(1) + '" r="' + pointRadius(item.point.total, maxValue) + '" fill="' + tokenColor(item.point.total, maxValue) + '"><title>' + escapeHtml(item.point.time + " +" + fmt(item.point.total) + " cache " + fmt(item.point.cached) + " / " + pct(item.point.cached, item.point.input) + " " + money(item.point.cost, item.point.unpriced) + " " + item.point.snippet) + '</title></circle>').join("") +
        ticks +
        '<text class="tick" x="' + pad + '" y="14">max ' + fmt(maxValue) + '</text>' +
        '</svg>';
      wireTimelineHover(host);
    }

    function buildSessionRings(groups, points, coordById, maxValue) {
      const pointsBySession = new Map();
      for (const point of points) {
        if (!pointsBySession.has(point.sessionId)) {
          pointsBySession.set(point.sessionId, []);
        }
        const coord = coordById.get(point.id);
        if (coord) {
          pointsBySession.get(point.sessionId).push(coord);
        }
      }

      return groups.map((group) => {
        const coords = pointsBySession.get(group.id) || [];
        if (!coords.length) {
          return null;
        }
        const minX = Math.min(...coords.map((item) => item.x));
        const maxX = Math.max(...coords.map((item) => item.x));
        const minY = Math.min(...coords.map((item) => item.y));
        const maxY = Math.max(...coords.map((item) => item.y));
        const x = (minX + maxX) / 2;
        const y = (minY + maxY) / 2;
        const rawRadius = Math.max(...coords.map((item) => Math.hypot(item.x - x, item.y - y)));
        const r = Math.max(7, rawRadius + 4.5);
        return {
          id: group.id,
          x,
          y,
          r,
          color: tokenColor(group.total, maxValue),
          title: group.snippet + " total " + fmt(group.total) + " tokens"
        };
      }).filter(Boolean);
    }

    function renderBars(id, days) {
      const host = document.getElementById(id);
      if (!days.length || days.every(day => !day.input && !day.output)) {
        host.innerHTML = '<div class="empty">No usage in this range.</div>';
        return;
      }
      const width = 760;
      const height = 210;
      const pad = 42;
      const innerHeight = height - pad * 2;
      const inputMax = Math.max(...days.map(day => day.input || 0), 1);
      const outputMax = Math.max(...days.map(day => day.output || 0), 1);
      const slotWidth = (width - pad * 2) / days.length;
      const pairWidth = Math.min(slotWidth * .78, days.length > 14 ? 17 : 48);
      const gap = Math.max(1, pairWidth * .08);
      const barWidth = (pairWidth - gap) / 2;
      const bottom = height - pad;
      host.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Daily input and output tokens on separate scales">' +
        '<line class="axis" x1="' + pad + '" y1="' + bottom + '" x2="' + (width-pad) + '" y2="' + bottom + '"></line>' +
        days.map((day, index) => {
          const center = pad + slotWidth * (index + .5);
          const x = center - pairWidth / 2;
          const inputHeight = Math.max(0, day.input || 0) / inputMax * innerHeight;
          const outputHeight = Math.max(0, day.output || 0) / outputMax * innerHeight;
          const title = escapeHtml([
            day.label + ' · ' + fmt(day.total) + ' total tokens',
            'Input: ' + fmt(day.input) + ' (cached ' + fmt(day.cached) + ')',
            'Input cost: ' + money(day.inputCost, day.unpriced),
            'Output: ' + fmt(day.output),
            'Output cost: ' + money(day.outputCost, day.unpriced),
            'Total cost: ' + money(day.cost, day.unpriced)
          ].join(String.fromCharCode(10)));
          return '<g class="bar-group" data-bar-title="' + title + '">' +
            '<rect class="bar" x="' + x.toFixed(2) + '" y="' + (bottom-inputHeight).toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + Math.max(inputHeight,day.input?1:0).toFixed(2) + '"></rect>' +
            '<rect class="bar-output" x="' + (x+barWidth+gap).toFixed(2) + '" y="' + (bottom-outputHeight).toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + Math.max(outputHeight,day.output?1:0).toFixed(2) + '"></rect>' +
            labelForBar(day, center, height, days.length) +
            '<rect x="' + (center-slotWidth/2).toFixed(2) + '" y="0" width="' + slotWidth.toFixed(2) + '" height="' + bottom + '" fill="transparent"></rect>' +
            '</g>';
        }).join("") +
        '<text class="tick" text-anchor="start" x="' + pad + '" y="14">Input max ' + fmt(inputMax) + '</text>' +
        '<text class="tick" text-anchor="end" x="' + (width-pad) + '" y="14">Output max ' + fmt(outputMax) + '</text>' +
        '<g class="y-axis-ticks">' + Array.from({length:5}, (_, idx) => {
          const fraction = idx / 4;
          const y = bottom - fraction * innerHeight;
          const left = fmt(inputMax * fraction);
          const right = fmt(outputMax * fraction);
          return '<line class="axis" x1="' + pad + '" y1="' + y.toFixed(2) +
            '" x2="' + (width-pad) + '" y2="' + y.toFixed(2) + '" stroke-dasharray="2 5" opacity=".35"></line>' +
            '<text class="tick" text-anchor="end" x="' + (pad-7) + '" y="' + (y+3).toFixed(2) +
            '">' + left + '</text><text class="tick" text-anchor="start" x="' + (width-pad+7) +
            '" y="' + (y+3).toFixed(2) + '">' + right + '</text>';
        }).join("") + '</g></svg>';
      wireBarHover(host);
    }

    function labelForBar(day, x, height, count) {
      if (count > 14 && !day.key.endsWith("-01") && !day.label.endsWith("/1")) return "";
      return '<text class="tick" text-anchor="middle" x="' + x.toFixed(2) + '" y="' + (height - 8) + '">' + escapeHtml(day.label) + '</text>';
    }

    function renderSessions(sessions) {
      const host = document.getElementById("sessionsTable");
      if (!sessions.length) {
        host.innerHTML = '<div class="empty">No recent sessions.</div>';
        return;
      }
      const max = Math.max(...sessions.map((session) => session.total), 1);
      host.innerHTML = '<table><thead><tr><th>Cost</th><th>Time</th><th>Input</th><th>Cache</th><th>Output</th><th>Total</th><th>Turns</th><th>Dialog</th></tr></thead><tbody>' +
        sessions.map((session) => '<tr data-session-row="' + escapeHtml(session.id) + '" style="background:' + rowColor(session.total, max) + '"><td class="money" title="' + escapeHtml(costTitle(session.modelBreakdown)) + '">' + money(session.cost, session.unpriced) + '</td><td>' + escapeHtml(shortDate(session.lastAt)) + '</td><td>' + fmt(session.input) + '</td><td>' + fmt(session.cached) + ' / ' + pct(session.cached, session.input) + '</td><td>' + fmt(session.output) + '</td><td>' + fmt(session.total) + '</td><td>' + fmt(session.turnCount) + '</td><td class="dialog" title="' + escapeHtml(session.file) + '">' + escapeHtml((session.account ? session.account + " / " : "") + session.snippet) + '</td></tr>').join("") +
        '</tbody></table>';
      wireSessionRowHover(host);
    }

    function renderEvents(points) {
      const host = document.getElementById("eventsTable");
      const recent = points.slice().reverse();
      if (!recent.length) {
        host.innerHTML = '<div class="empty">No events today.</div>';
        return;
      }
      const max = Math.max(...recent.map((point) => point.total), 1);
      host.innerHTML = '<table><thead><tr><th>Cost</th><th>Time</th><th>Input</th><th>Cache</th><th>Output</th><th>Total</th><th>Session</th></tr></thead><tbody>' +
        recent.map((point) => '<tr data-event-row="' + escapeHtml(point.id) + '" style="background:' + rowColor(point.total, max) + '"><td class="money" title="' + escapeHtml(point.costCalculation || "") + '">' + money(point.cost, point.unpriced) + '</td><td>' + escapeHtml(point.time) + '</td><td>' + fmt(point.input) + '</td><td>' + fmt(point.cached) + ' / ' + pct(point.cached, point.input) + '</td><td>' + fmt(point.output) + '</td><td>' + fmt(point.total) + '</td><td class="dialog" title="' + escapeHtml(point.session) + '">' + escapeHtml(point.snippet) + '</td></tr>').join("") +
        '</tbody></table>';
      wireEventRowHover(host);
    }

    function buildTimeTicks(minTime, maxTime, width, pad) {
      if (minTime === maxTime) {
        return [{ x: pad, label: formatTick(minTime), anchor: "start" }];
      }
      const inner = width - pad * 2;
      const count = Math.max(2, Math.floor(inner / 120) + 1);
      return Array.from({ length: count }, (_, index) => {
        const ratio = count === 1 ? 0 : index / (count - 1);
        const time = minTime + (maxTime - minTime) * ratio;
        return {
          x: pad + inner * ratio,
          label: formatTick(time),
          anchor: index === 0 ? "start" : (index === count - 1 ? "end" : "middle")
        };
      });
    }

    function formatTick(time) {
      return new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    }

    function tokenColor(value, max) {
      const ratio = Math.max(0, Math.min(1, (Number(value) || 0) / Math.max(max, 1)));
      const stops = [
        [126, 178, 163],
        [111, 160, 199],
        [211, 169, 109],
        [205, 126, 118]
      ];
      const scaled = ratio * (stops.length - 1);
      const index = Math.min(stops.length - 2, Math.floor(scaled));
      const local = scaled - index;
      const from = stops[index];
      const to = stops[index + 1];
      const rgb = from.map((channel, channelIndex) => Math.round(channel + (to[channelIndex] - channel) * local));
      return "rgb(" + rgb.join(",") + ")";
    }

    function rowColor(value, max) {
      const ratio = Math.max(0, Math.min(1, (Number(value) || 0) / Math.max(max, 1)));
      const color = tokenColor(value, max).match(/\\d+/g).map(Number);
      const alpha = 0.12 + ratio * 0.24;
      return "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + alpha.toFixed(3) + ")";
    }

    function pointRadius(value, max) {
      const ratio = Math.max(0, Math.min(1, (Number(value) || 0) / Math.max(max, 1)));
      return Math.max(1.4, 1.4 + ratio * 3.8).toFixed(1);
    }

    function wireTimelineHover(host) {
      host.querySelectorAll(".point").forEach((point) => {
        point.addEventListener("mouseenter", (event) => {
          const eventId = point.getAttribute("data-event-id");
          point.classList.add("active");
          highlightEventRow(eventId, true);
          showTip(point.querySelector("title") ? point.querySelector("title").textContent : "", event);
        });
        point.addEventListener("mousemove", showTipAtEvent);
        point.addEventListener("mouseleave", () => {
          const eventId = point.getAttribute("data-event-id");
          point.classList.remove("active");
          highlightEventRow(eventId, false);
          hideTip();
        });
      });
      host.querySelectorAll(".session-ring").forEach((ring) => {
        ring.addEventListener("mouseenter", (event) => {
          const sessionId = ring.getAttribute("data-session-id");
          ring.classList.add("active");
          highlightSessionRow(sessionId, true);
          showTip(ring.querySelector("title") ? ring.querySelector("title").textContent : "", event);
        });
        ring.addEventListener("mousemove", showTipAtEvent);
        ring.addEventListener("mouseleave", () => {
          const sessionId = ring.getAttribute("data-session-id");
          ring.classList.remove("active");
          highlightSessionRow(sessionId, false);
          hideTip();
        });
      });
    }

    function wireEventRowHover(host) {
      host.querySelectorAll("[data-event-row]").forEach((row) => {
        row.addEventListener("mouseenter", () => {
          const eventId = row.getAttribute("data-event-row");
          row.classList.add("active");
          highlightTimelineEvent(eventId, true);
        });
        row.addEventListener("mouseleave", () => {
          const eventId = row.getAttribute("data-event-row");
          row.classList.remove("active");
          highlightTimelineEvent(eventId, false);
        });
      });
    }

    function wireSessionRowHover(host) {
      host.querySelectorAll("[data-session-row]").forEach((row) => {
        row.addEventListener("mouseenter", () => {
          const sessionId = row.getAttribute("data-session-row");
          row.classList.add("active");
          highlightTimelineSession(sessionId, true);
        });
        row.addEventListener("mouseleave", () => {
          const sessionId = row.getAttribute("data-session-row");
          row.classList.remove("active");
          highlightTimelineSession(sessionId, false);
        });
      });
    }

    function highlightEventRow(eventId, active) {
      if (!eventId) return;
      document.querySelectorAll('[data-event-row="' + eventId + '"]').forEach((row) => {
        row.classList.toggle("active", active);
        if (active) {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    }

    function highlightTimelineEvent(eventId, active) {
      if (!eventId) return;
      document.querySelectorAll(".point").forEach((point) => {
        if (point.getAttribute("data-event-id") === eventId) {
          point.classList.toggle("active", active);
        }
      });
    }

    function highlightTimelineSession(sessionId, active) {
      if (!sessionId) return;
      document.querySelectorAll(".session-ring").forEach((ring) => {
        if (ring.getAttribute("data-session-id") === sessionId) {
          ring.classList.toggle("active", active);
        }
      });
    }

    function highlightSessionRow(sessionId, active) {
      if (!sessionId) return;
      document.querySelectorAll('[data-session-row="' + sessionId + '"]').forEach((row) => {
        row.classList.toggle("active", active);
        if (active) {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    }

    function wireBarHover(host) {
      host.querySelectorAll(".bar-group").forEach((group) => {
        group.addEventListener("mouseenter", (event) => {
          group.classList.add("hover-line");
          showTip(group.getAttribute("data-bar-title"), event);
        });
        group.addEventListener("mousemove", showTipAtEvent);
        group.addEventListener("mouseleave", () => {
          group.classList.remove("hover-line");
          hideTip();
        });
      });
    }

    function showTip(text, event) {
      const tip = document.getElementById("chartTip");
      tip.textContent = text || "";
      tip.style.display = "block";
      showTipAtEvent(event);
    }

    function showTipAtEvent(event) {
      const tip = document.getElementById("chartTip");
      tip.style.left = (event.clientX + 12) + "px";
      tip.style.top = (event.clientY + 12) + "px";
    }

    function hideTip() {
      document.getElementById("chartTip").style.display = "none";
    }

    function fmt(value) {
      const number = Number(value) || 0;
      if (number >= 1000000) return trim(number / 1000000) + "m";
      if (number >= 1000) return trim(number / 1000) + "k";
      return String(number);
    }

    function pct(part, whole) {
      const total = Number(whole) || 0;
      return total > 0 ? trim(((Number(part) || 0) / total) * 100) + "%" : "0%";
    }

    function money(value, unpriced) {
      if (Number(unpriced) > 0) return "N/A";
      const display = state.data && state.data.display || {};
      const rate = Number(display.rate);
      const amount = (Number(value) || 0) * (Number.isFinite(rate) && rate > 0 ? rate : 1);
      const symbol = String(display.symbol || "$");
      return symbol + amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2);
    }

    function costTitle(breakdown) {
      const models = Array.isArray(breakdown) ? breakdown : [];
      if (!models.length) return "No priced model data.";
      return models.map((item) => item.calculation || item.model + ": price unavailable").join("\\n");
    }

    function trim(value) {
      return value.toFixed(1).replace(/\\.0$/, "");
    }

    function shortDate(timestamp) {
      if (!timestamp) return "";
      return new Date(timestamp).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    }

    function escapeHtml(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate
};
