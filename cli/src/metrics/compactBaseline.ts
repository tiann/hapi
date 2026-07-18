import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type JsonRecord = Record<string, unknown>;

export type CodexSessionKind = 'hapi-codex' | 'cli-codex' | string;

export type CodexSessionRow = {
  kind: CodexSessionKind;
  file?: string;
  sessionId: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  tokenEvents?: number;
  toolCalls?: number;
  lineCount?: number;
  contextCompacted: number;
  compactedRecords?: number;
  manualCompactRequests?: number;
  finalTotal?: number;
  finalInput?: number;
  finalCached?: number;
  finalUncached?: number;
  lastInput?: number;
  lastUncached?: number;
};

export type CodexCompactionRow = {
  kind: CodexSessionKind;
  file?: string;
  sessionId: string;
  line?: number;
  manualInferred?: boolean;
  hasCompactedRecord?: boolean;
  preLastInput?: number;
  postLastInput?: number;
  preLastTotal?: number;
  postLastTotal?: number;
  contextWindow?: number;
  preContextPct?: number;
  postContextPct?: number;
  postOverPre?: number;
};

export type ClaudeSessionRow = {
  file?: string;
  sessionId: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  lineCount?: number;
  assistantMessages: number;
  userMessages?: number;
  toolUses: number;
  compactBoundaries: number;
  lastUsageInput?: number;
  medianUsageInput?: number;
  maxUsageInput?: number;
  lastUsageTotal?: number;
  maxUsageTotal?: number;
};

export type ClaudeCompactionRow = {
  file?: string;
  line?: number;
  sessionId: string;
  entrypoint?: string;
  cwd?: string;
  version?: string;
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  tokensSaved?: number;
  durationMs?: number;
  precomputed?: boolean;
  tools?: number;
};

type TokenEvent = {
  line: number;
  totalInput?: number;
  totalCached?: number;
  totalOutput?: number;
  totalTokens?: number;
  lastInput?: number;
  lastCached?: number;
  lastTotal?: number;
  contextWindow?: number;
};

export type CompactBaselineInput = {
  generatedAt?: string;
  codexSessions: CodexSessionRow[];
  codexCompactions: CodexCompactionRow[];
  claudeSessions: ClaudeSessionRow[];
  claudeCompactions: ClaudeCompactionRow[];
};

export type CompactBaselineSummary = {
  generatedAt: string;
  codex: {
    byKind: Record<string, {
      sessions: number;
      compactSessions: number;
      compactEvents: number;
      finalTotalMedian?: number;
      finalUncachedMedian?: number;
    }>;
    compactionEffect: Record<string, {
      events: number;
      manualInferred: number;
      preLastInputMedian?: number;
      postLastInputMedian?: number;
      preContextPctMedian?: number;
      postOverPreMedian?: number;
    }>;
  };
  claude: {
    sessions: number;
    compactBoundaries: number;
    compactByEntrypoint: Record<string, number>;
    compactByTrigger: Record<string, number>;
    preTokensMedian?: number;
    postTokensMedian?: number;
    postOverPreMedian?: number;
  };
  rows: CompactBaselineInput;
};

export type CompactBaselineGate = {
  schemaVersion: 1;
  name?: string;
  description?: string;
  missingData?: 'fail' | 'warn';
  minimums?: {
    codex?: Record<string, {
      sessions?: number;
      compactSessions?: number;
      compactEvents?: number;
    }>;
    claude?: {
      sessions?: number;
      compactBoundaries?: number;
    };
  };
  maximums?: {
    codexPostOverPreMedian?: Record<string, number>;
    claudePostOverPreMedian?: number;
  };
};

export type CompactBaselineGateResult = {
  passed: boolean;
  violations: string[];
  warnings: string[];
};

export type ScanCodexJsonlInput = {
  file: string;
  kind: CodexSessionKind;
  text: string;
};

export type ScanClaudeJsonlInput = {
  file: string;
  text: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeJson(line: string): JsonRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function median(values: Array<number | undefined>): number | undefined {
  const xs = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const middle = (xs.length - 1) / 2;
  const lower = Math.floor(middle);
  const upper = Math.ceil(middle);
  if (lower === upper) return xs[lower];
  return (xs[lower] + xs[upper]) / 2;
}

function countBy<T>(rows: T[], key: (row: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = key(row) ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function tokenFromCodexPayload(payload: JsonRecord, line: number): TokenEvent | null {
  const info = isRecord(payload.info) ? payload.info : null;
  if (!info) return null;
  const total = isRecord(info.total_token_usage) ? info.total_token_usage : {};
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : {};
  return {
    line,
    totalInput: asNumber(total.input_tokens),
    totalCached: asNumber(total.cached_input_tokens),
    totalOutput: asNumber(total.output_tokens),
    totalTokens: asNumber(total.total_tokens),
    lastInput: asNumber(last.input_tokens),
    lastCached: asNumber(last.cached_input_tokens),
    lastTotal: asNumber(last.total_tokens),
    contextWindow: asNumber(info.model_context_window),
  };
}

function userTextFromCodexPayload(payload: JsonRecord): string {
  if (payload.type === 'user_message') {
    return typeof payload.message === 'string' ? payload.message : '';
  }
  if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    return payload.content
      .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
      .join('\n');
  }
  return '';
}

export function scanCodexJsonl(input: ScanCodexJsonlInput): { session: CodexSessionRow; compactions: CodexCompactionRow[] } {
  const tokenEvents: TokenEvent[] = [];
  const contextCompactedLines: number[] = [];
  const compactedRecordLines: number[] = [];
  const manualRequestLines: number[] = [];
  let meta: JsonRecord = {};
  let lineCount = 0;
  let toolCalls = 0;

  const lines = input.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    lineCount = index + 1;
    const obj = safeJson(line);
    if (!obj) continue;
    const payload = isRecord(obj.payload) ? obj.payload : {};

    if (obj.type === 'session_meta') meta = payload;
    if (obj.type === 'response_item' && payload.type === 'function_call') toolCalls += 1;
    if ((obj.type === 'event_msg' || obj.type === 'response_item') && userTextFromCodexPayload(payload).trim().startsWith('/compact')) {
      manualRequestLines.push(lineCount);
    }
    if (obj.type === 'compacted') compactedRecordLines.push(lineCount);
    if (payload.type === 'context_compacted') contextCompactedLines.push(lineCount);
    if (payload.type === 'token_count') {
      const tokenEvent = tokenFromCodexPayload(payload, lineCount);
      if (tokenEvent) tokenEvents.push(tokenEvent);
    }
  }

  const last = tokenEvents[tokenEvents.length - 1];
  const sessionId = asString(meta.id) ?? path.basename(input.file, '.jsonl');
  const session: CodexSessionRow = {
    kind: input.kind,
    file: input.file,
    sessionId,
    timestamp: asString(meta.timestamp),
    cwd: asString(meta.cwd),
    originator: asString(meta.originator),
    tokenEvents: tokenEvents.length,
    toolCalls,
    lineCount,
    contextCompacted: contextCompactedLines.length,
    compactedRecords: compactedRecordLines.length,
    manualCompactRequests: manualRequestLines.length,
    finalTotal: last?.totalTokens,
    finalInput: last?.totalInput,
    finalCached: last?.totalCached,
    finalUncached: last?.totalInput !== undefined ? last.totalInput - (last.totalCached ?? 0) : undefined,
    lastInput: last?.lastInput,
    lastUncached: last?.lastInput !== undefined ? last.lastInput - (last.lastCached ?? 0) : undefined,
  };

  const compactions = contextCompactedLines.map((line): CodexCompactionRow => {
    const compactedAnchor = compactedRecordLines.filter((candidate) => candidate < line).at(-1);
    const anchor = compactedAnchor ?? line;
    const before = tokenEvents.filter((event) => event.line < anchor && (event.lastInput ?? 0) > 0).at(-1);
    const after = tokenEvents.find((event) => event.line > line && (event.lastInput ?? 0) > 0);
    const preLastInput = before?.lastInput;
    const postLastInput = after?.lastInput;
    return {
      kind: input.kind,
      file: input.file,
      sessionId,
      line,
      manualInferred: manualRequestLines.some((requestLine) => requestLine <= line && line - requestLine <= 40),
      hasCompactedRecord: compactedAnchor !== undefined && Math.abs(compactedAnchor - line) <= 5,
      preLastInput,
      postLastInput,
      preLastTotal: before?.lastTotal,
      postLastTotal: after?.lastTotal,
      contextWindow: before?.contextWindow,
      preContextPct: preLastInput !== undefined && before?.contextWindow ? (preLastInput / before.contextWindow) * 100 : undefined,
      postContextPct: postLastInput !== undefined && after?.contextWindow ? (postLastInput / after.contextWindow) * 100 : undefined,
      postOverPre: preLastInput !== undefined && postLastInput !== undefined && preLastInput > 0 ? postLastInput / preLastInput : undefined,
    };
  });

  return { session, compactions };
}

export function scanClaudeJsonl(input: ScanClaudeJsonlInput): { session: ClaudeSessionRow; compactions: ClaudeCompactionRow[] } {
  let sessionId: string | undefined;
  let entrypoint: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let lineCount = 0;
  let assistantMessages = 0;
  let userMessages = 0;
  let toolUses = 0;
  const usageInputs: number[] = [];
  const usageTotals: number[] = [];
  const compactions: ClaudeCompactionRow[] = [];

  const lines = input.text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    lineCount = index + 1;
    const obj = safeJson(line);
    if (!obj) continue;
    sessionId = sessionId ?? asString(obj.sessionId);
    entrypoint = entrypoint ?? asString(obj.entrypoint);
    cwd = cwd ?? asString(obj.cwd);
    version = version ?? asString(obj.version);

    if (obj.type === 'assistant') {
      assistantMessages += 1;
      const message = isRecord(obj.message) ? obj.message : {};
      const usage = isRecord(message.usage) ? message.usage : null;
      if (usage) {
        const inputTokens = Object.entries(usage)
          .filter(([key, value]) => key.endsWith('input_tokens') && typeof value === 'number')
          .reduce((sum, [, value]) => sum + (value as number), 0);
        const outputTokens = Object.entries(usage)
          .filter(([key, value]) => key.endsWith('output_tokens') && typeof value === 'number')
          .reduce((sum, [, value]) => sum + (value as number), 0);
        if (inputTokens > 0) usageInputs.push(inputTokens);
        if (inputTokens > 0 || outputTokens > 0) usageTotals.push(inputTokens + outputTokens);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      toolUses += content.filter((block) => isRecord(block) && block.type === 'tool_use').length;
    }
    if (obj.type === 'user') userMessages += 1;
    if (obj.type === 'system' && obj.subtype === 'compact_boundary') {
      const metadata = isRecord(obj.compactMetadata) ? obj.compactMetadata : {};
      const preTokens = asNumber(metadata.preTokens);
      const postTokens = asNumber(metadata.postTokens);
      compactions.push({
        file: input.file,
        line: lineCount,
        sessionId: asString(obj.sessionId) ?? sessionId ?? path.basename(input.file, '.jsonl'),
        entrypoint: asString(obj.entrypoint) ?? entrypoint,
        cwd: asString(obj.cwd) ?? cwd,
        version: asString(obj.version) ?? version,
        trigger: asString(metadata.trigger),
        preTokens,
        postTokens,
        tokensSaved: preTokens !== undefined && postTokens !== undefined && preTokens > postTokens ? preTokens - postTokens : undefined,
        durationMs: asNumber(metadata.durationMs),
        precomputed: typeof metadata.precomputed === 'boolean' ? metadata.precomputed : undefined,
        tools: Array.isArray(metadata.preCompactDiscoveredTools) ? metadata.preCompactDiscoveredTools.length : undefined,
      });
    }
  }

  const resolvedSessionId = sessionId ?? path.basename(input.file, '.jsonl');
  return {
    session: {
      file: input.file,
      sessionId: resolvedSessionId,
      entrypoint,
      cwd,
      version,
      lineCount,
      assistantMessages,
      userMessages,
      toolUses,
      compactBoundaries: compactions.length,
      lastUsageInput: usageInputs.at(-1),
      medianUsageInput: median(usageInputs),
      maxUsageInput: usageInputs.length > 0 ? Math.max(...usageInputs) : undefined,
      lastUsageTotal: usageTotals.at(-1),
      maxUsageTotal: usageTotals.length > 0 ? Math.max(...usageTotals) : undefined,
    },
    compactions,
  };
}

export function buildCompactBaseline(input: CompactBaselineInput): CompactBaselineSummary {
  const kinds = Array.from(new Set(input.codexSessions.map((session) => session.kind))).sort();
  const byKind: CompactBaselineSummary['codex']['byKind'] = {};
  const compactionEffect: CompactBaselineSummary['codex']['compactionEffect'] = {};

  for (const kind of kinds) {
    const sessions = input.codexSessions.filter((session) => session.kind === kind);
    const compactions = input.codexCompactions.filter((compaction) => compaction.kind === kind);
    byKind[kind] = {
      sessions: sessions.length,
      compactSessions: sessions.filter((session) => session.contextCompacted > 0).length,
      compactEvents: sessions.reduce((sum, session) => sum + session.contextCompacted, 0),
      finalTotalMedian: median(sessions.map((session) => session.finalTotal)),
      finalUncachedMedian: median(sessions.map((session) => session.finalUncached)),
    };
    compactionEffect[kind] = {
      events: compactions.length,
      manualInferred: compactions.filter((compaction) => compaction.manualInferred).length,
      preLastInputMedian: median(compactions.map((compaction) => compaction.preLastInput)),
      postLastInputMedian: median(compactions.map((compaction) => compaction.postLastInput)),
      preContextPctMedian: median(compactions.map((compaction) => compaction.preContextPct)),
      postOverPreMedian: median(compactions.map((compaction) => compaction.postOverPre)),
    };
  }

  const ratios = input.claudeCompactions
    .map((row) => (row.preTokens !== undefined && row.postTokens !== undefined && row.preTokens > 0 ? row.postTokens / row.preTokens : undefined));

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    codex: { byKind, compactionEffect },
    claude: {
      sessions: input.claudeSessions.length,
      compactBoundaries: input.claudeCompactions.length,
      compactByEntrypoint: countBy(input.claudeCompactions, (row) => row.entrypoint),
      compactByTrigger: countBy(input.claudeCompactions, (row) => row.trigger),
      preTokensMedian: median(input.claudeCompactions.map((row) => row.preTokens)),
      postTokensMedian: median(input.claudeCompactions.map((row) => row.postTokens)),
      postOverPreMedian: median(ratios),
    },
    rows: input,
  };
}

function formatGateNumber(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  if (value === 0) return '0';
  if (Math.abs(value) < 1) return value.toFixed(2);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function assertAtLeast(
  violations: string[],
  name: string,
  actual: number | undefined,
  expected: number | undefined
): void {
  if (expected === undefined) return;
  if (actual === undefined || actual < expected) {
    violations.push(`${name} expected >= ${formatGateNumber(expected)}, got ${formatGateNumber(actual)}`);
  }
}

function assertAtMost(
  violations: string[],
  name: string,
  actual: number | undefined,
  expected: number | undefined
): void {
  if (expected === undefined) return;
  if (actual === undefined || actual > expected) {
    violations.push(`${name} expected <= ${formatGateNumber(expected)}, got ${formatGateNumber(actual)}`);
  }
}

function reportMissingReplayData(
  result: Pick<CompactBaselineGateResult, 'violations' | 'warnings'>,
  mode: CompactBaselineGate['missingData'],
  name: string
): void {
  const message = `${name} expected replay data, got none`;
  if (mode === 'warn') {
    result.warnings.push(message);
  } else {
    result.violations.push(message);
  }
}

export function compareCompactBaselineGate(
  summary: CompactBaselineSummary,
  gate: CompactBaselineGate
): CompactBaselineGateResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const missingData = gate.missingData ?? 'fail';
  const gateResult = { violations, warnings };

  for (const [kind, minimum] of Object.entries(gate.minimums?.codex ?? {})) {
    const actual = summary.codex.byKind[kind];
    if (!actual) {
      violations.push(`codex.${kind} expected replay data, got none`);
      continue;
    }
    assertAtLeast(violations, `codex.${kind}.sessions`, actual.sessions, minimum.sessions);
    assertAtLeast(violations, `codex.${kind}.compactSessions`, actual.compactSessions, minimum.compactSessions);
    assertAtLeast(violations, `codex.${kind}.compactEvents`, actual.compactEvents, minimum.compactEvents);
  }

  assertAtLeast(violations, 'claude.sessions', summary.claude.sessions, gate.minimums?.claude?.sessions);
  assertAtLeast(violations, 'claude.compactBoundaries', summary.claude.compactBoundaries, gate.minimums?.claude?.compactBoundaries);

  for (const [kind, maxRatio] of Object.entries(gate.maximums?.codexPostOverPreMedian ?? {})) {
    const actual = summary.codex.compactionEffect[kind];
    if (!actual || (missingData === 'warn' && actual.events === 0 && actual.postOverPreMedian === undefined)) {
      reportMissingReplayData(gateResult, missingData, `codex.${kind}.postOverPreMedian`);
      continue;
    }
    assertAtMost(violations, `codex.${kind}.postOverPreMedian`, actual.postOverPreMedian, maxRatio);
  }

  const claudeMaxRatio = gate.maximums?.claudePostOverPreMedian;
  if (
    claudeMaxRatio !== undefined &&
    missingData === 'warn' &&
    summary.claude.compactBoundaries === 0 &&
    summary.claude.postOverPreMedian === undefined
  ) {
    reportMissingReplayData(gateResult, missingData, 'claude.postOverPreMedian');
  } else {
    assertAtMost(violations, 'claude.postOverPreMedian', summary.claude.postOverPreMedian, claudeMaxRatio);
  }

  if (summary.rows.codexSessions.length === 0 && summary.rows.claudeSessions.length === 0) {
    warnings.push('No local replay sessions were found. Check --hapi-codex-root, --cli-codex-root, and --claude-root.');
  }

  return {
    passed: violations.length === 0,
    violations,
    warnings,
  };
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  if (Math.abs(value) < 1) return value.toFixed(2);
  if (Math.abs(value) < 100) return value.toFixed(2).replace(/\.00$/, '');
  return Math.round(value).toLocaleString('en-US');
}

export function renderCompactBaselineMarkdown(summary: CompactBaselineSummary): string {
  const lines: string[] = [];
  lines.push('# HAPI token replay baseline');
  lines.push('');
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push('');
  lines.push('## Codex sessions');
  lines.push('| kind | sessions | compact sessions | compact events | median final total | median final uncached |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const [kind, row] of Object.entries(summary.codex.byKind)) {
    lines.push(`| ${kind} | ${row.sessions} | ${row.compactSessions} | ${row.compactEvents} | ${formatNumber(row.finalTotalMedian)} | ${formatNumber(row.finalUncachedMedian)} |`);
  }
  lines.push('');
  lines.push('## Codex compaction effect');
  lines.push('| kind | events | inferred manual | median pre input | median post input | median pre/context | median post/pre |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [kind, row] of Object.entries(summary.codex.compactionEffect)) {
    lines.push(`| ${kind} | ${row.events} | ${row.manualInferred} | ${formatNumber(row.preLastInputMedian)} | ${formatNumber(row.postLastInputMedian)} | ${formatNumber(row.preContextPctMedian)}% | ${formatNumber(row.postOverPreMedian)} |`);
  }
  lines.push('');
  lines.push('## Claude sessions');
  lines.push(`- Claude sessions: ${summary.claude.sessions}`);
  lines.push(`- Claude compact boundaries: ${summary.claude.compactBoundaries}`);
  lines.push(`- By entrypoint: \`${JSON.stringify(summary.claude.compactByEntrypoint)}\``);
  lines.push(`- By trigger: \`${JSON.stringify(summary.claude.compactByTrigger)}\``);
  lines.push(`- Median preTokens: ${formatNumber(summary.claude.preTokensMedian)}`);
  lines.push(`- Median postTokens: ${formatNumber(summary.claude.postTokensMedian)}`);
  lines.push(`- Median post/pre: ${formatNumber(summary.claude.postOverPreMedian)}`);
  lines.push('');
  lines.push('## Replay boundary');
  lines.push('- This dashboard replays local transcript files only.');
  lines.push('- It does not call Codex, Claude, or any model provider.');
  lines.push('- It measures native compact events already emitted by official CLI runtimes.');
  return `${lines.join('\n')}\n`;
}

async function walkJsonl(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function scanCompactBaselineRoots(options: {
  hapiCodexRoot?: string;
  cliCodexRoot?: string;
  claudeRoot?: string;
  generatedAt?: string;
}): Promise<CompactBaselineSummary> {
  const codexSessions: CodexSessionRow[] = [];
  const codexCompactions: CodexCompactionRow[] = [];
  const claudeSessions: ClaudeSessionRow[] = [];
  const claudeCompactions: ClaudeCompactionRow[] = [];

  for (const [kind, root] of [
    ['hapi-codex', options.hapiCodexRoot],
    ['cli-codex', options.cliCodexRoot],
  ] as const) {
    if (!root) continue;
    for (const file of await walkJsonl(root)) {
      const result = scanCodexJsonl({ file, kind, text: await readFile(file, 'utf8') });
      if (result.session.tokenEvents || result.session.contextCompacted > 0) {
        codexSessions.push(result.session);
        codexCompactions.push(...result.compactions);
      }
    }
  }

  if (options.claudeRoot) {
    for (const file of await walkJsonl(options.claudeRoot)) {
      const result = scanClaudeJsonl({ file, text: await readFile(file, 'utf8') });
      if (result.session.lineCount && result.session.lineCount > 0) {
        claudeSessions.push(result.session);
        claudeCompactions.push(...result.compactions);
      }
    }
  }

  return buildCompactBaseline({
    generatedAt: options.generatedAt,
    codexSessions,
    codexCompactions,
    claudeSessions,
    claudeCompactions,
  });
}

function csvEscape(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv(rows: JsonRecord[]): string {
  const keys = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).sort();
  if (keys.length === 0) return '';
  const lines = [keys.join(',')];
  for (const row of rows) {
    lines.push(keys.map((key) => csvEscape(row[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function writeCompactBaselineArtifacts(options: {
  outDir: string;
  hapiCodexRoot?: string;
  cliCodexRoot?: string;
  claudeRoot?: string;
  generatedAt?: string;
}): Promise<CompactBaselineSummary> {
  const summary = await scanCompactBaselineRoots(options);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(path.join(options.outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(path.join(options.outDir, 'report.md'), renderCompactBaselineMarkdown(summary));
  await writeFile(path.join(options.outDir, 'codex_sessions.csv'), rowsToCsv(summary.rows.codexSessions as unknown as JsonRecord[]));
  await writeFile(path.join(options.outDir, 'codex_compactions.csv'), rowsToCsv(summary.rows.codexCompactions as unknown as JsonRecord[]));
  await writeFile(path.join(options.outDir, 'claude_sessions.csv'), rowsToCsv(summary.rows.claudeSessions as unknown as JsonRecord[]));
  await writeFile(path.join(options.outDir, 'claude_compactions.csv'), rowsToCsv(summary.rows.claudeCompactions as unknown as JsonRecord[]));
  return summary;
}
