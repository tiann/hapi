import { describe, expect, it } from 'vitest';
import {
  buildCompactBaseline,
  compareCompactBaselineGate,
  renderCompactBaselineMarkdown,
  scanClaudeJsonl,
  scanCodexJsonl,
} from './compactBaseline';

describe('compact baseline replay scanner', () => {
  it('replays Codex token_count and context_compacted records into compaction metrics', () => {
    const jsonl = [
      {
        type: 'session_meta',
        payload: {
          id: 'codex-session-1',
          cwd: '/repo',
          timestamp: '2026-07-04T00:00:00Z',
          originator: 'hapi',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 1_000,
            last_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 100,
              total_tokens: 950,
            },
            total_token_usage: {
              input_tokens: 10_000,
              cached_input_tokens: 3_000,
              output_tokens: 1_000,
              total_tokens: 11_000,
            },
          },
        },
      },
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'context_compacted' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 1_000,
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              total_tokens: 150,
            },
            total_token_usage: {
              input_tokens: 10_200,
              cached_input_tokens: 3_020,
              output_tokens: 1_050,
              total_tokens: 11_250,
            },
          },
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n');

    const result = scanCodexJsonl({
      file: '/fixtures/codex.jsonl',
      kind: 'hapi-codex',
      text: jsonl,
    });

    expect(result.session).toMatchObject({
      kind: 'hapi-codex',
      sessionId: 'codex-session-1',
      cwd: '/repo',
      contextCompacted: 1,
      compactedRecords: 1,
      finalTotal: 11_250,
      finalUncached: 7_180,
    });
    expect(result.compactions).toEqual([
      expect.objectContaining({
        kind: 'hapi-codex',
        sessionId: 'codex-session-1',
        preLastInput: 900,
        postLastInput: 120,
        preContextPct: 90,
        postOverPre: 120 / 900,
      }),
    ]);
  });

  it('replays Claude compact boundaries and summarizes pre/post token reduction', () => {
    const jsonl = [
      {
        type: 'assistant',
        entrypoint: 'sdk-ts',
        sessionId: 'claude-session-1',
        cwd: '/repo',
        version: '2.1.198',
        message: {
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 200,
            output_tokens: 50,
          },
          content: [{ type: 'tool_use', id: 'tool-1' }],
        },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        entrypoint: 'sdk-ts',
        sessionId: 'claude-session-1',
        compactMetadata: {
          trigger: 'auto',
          preTokens: 1_003_310,
          postTokens: 20_011,
          durationMs: 146_000,
          preCompactDiscoveredTools: ['Read', 'Bash'],
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n');

    const result = scanClaudeJsonl({
      file: '/fixtures/claude.jsonl',
      text: jsonl,
    });

    expect(result.session).toMatchObject({
      sessionId: 'claude-session-1',
      entrypoint: 'sdk-ts',
      compactBoundaries: 1,
      assistantMessages: 1,
      toolUses: 1,
      maxUsageInput: 700,
    });
    expect(result.compactions).toEqual([
      expect.objectContaining({
        sessionId: 'claude-session-1',
        trigger: 'auto',
        preTokens: 1_003_310,
        postTokens: 20_011,
        tokensSaved: 983_299,
        tools: 2,
      }),
    ]);
  });

  it('builds a markdown dashboard from replayed HAPI, CLI, and Claude sessions', () => {
    const baseline = buildCompactBaseline({
      codexSessions: [
        { kind: 'hapi-codex', sessionId: 'h1', contextCompacted: 1, finalTotal: 10_000, finalUncached: 7_000 },
        { kind: 'cli-codex', sessionId: 'c1', contextCompacted: 0, finalTotal: 8_000, finalUncached: 6_000 },
      ],
      codexCompactions: [
        { kind: 'hapi-codex', sessionId: 'h1', preLastInput: 900, postLastInput: 120, preContextPct: 90, postOverPre: 120 / 900 },
      ],
      claudeSessions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', compactBoundaries: 1, assistantMessages: 3, toolUses: 2, maxUsageInput: 1_003_310 },
      ],
      claudeCompactions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', trigger: 'auto', preTokens: 1_003_310, postTokens: 20_011, tokensSaved: 983_299 },
      ],
      generatedAt: '2026-07-04T00:00:00.000Z',
    });

    const markdown = renderCompactBaselineMarkdown(baseline);

    expect(markdown).toContain('# HAPI token replay baseline');
    expect(markdown).toContain('| hapi-codex | 1 | 1 | 1 |');
    expect(markdown).toContain('| cli-codex | 1 | 0 | 0 |');
    expect(markdown).toContain('Claude compact boundaries: 1');
    expect(markdown).toContain('Median post/pre: 0.02');
  });

  it('passes the replay gate when current metrics stay within the real-history thresholds', () => {
    const baseline = buildCompactBaseline({
      codexSessions: [
        { kind: 'hapi-codex', sessionId: 'h1', contextCompacted: 2, finalTotal: 10_000, finalUncached: 7_000 },
        { kind: 'cli-codex', sessionId: 'c1', contextCompacted: 1, finalTotal: 8_000, finalUncached: 6_000 },
      ],
      codexCompactions: [
        { kind: 'hapi-codex', sessionId: 'h1', preLastInput: 900, postLastInput: 120, preContextPct: 90, postOverPre: 120 / 900 },
        { kind: 'cli-codex', sessionId: 'c1', preLastInput: 880, postLastInput: 110, preContextPct: 88, postOverPre: 110 / 880 },
      ],
      claudeSessions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', compactBoundaries: 1, assistantMessages: 3, toolUses: 2, maxUsageInput: 1_003_310 },
      ],
      claudeCompactions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', trigger: 'auto', preTokens: 1_003_310, postTokens: 20_011, tokensSaved: 983_299 },
      ],
      generatedAt: '2026-07-04T00:00:00.000Z',
    });

    const result = compareCompactBaselineGate(baseline, {
      schemaVersion: 1,
      minimums: {
        codex: {
          'hapi-codex': { sessions: 1, compactSessions: 1, compactEvents: 1 },
          'cli-codex': { sessions: 1, compactSessions: 1, compactEvents: 1 },
        },
        claude: { sessions: 1, compactBoundaries: 1 },
      },
      maximums: {
        codexPostOverPreMedian: {
          'hapi-codex': 0.2,
          'cli-codex': 0.2,
        },
        claudePostOverPreMedian: 0.05,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails the replay gate when native compact telemetry disappears or compaction ratios regress', () => {
    const baseline = buildCompactBaseline({
      codexSessions: [
        { kind: 'hapi-codex', sessionId: 'h1', contextCompacted: 0, finalTotal: 10_000, finalUncached: 7_000 },
      ],
      codexCompactions: [
        { kind: 'hapi-codex', sessionId: 'h1', preLastInput: 900, postLastInput: 500, preContextPct: 90, postOverPre: 500 / 900 },
      ],
      claudeSessions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', compactBoundaries: 0, assistantMessages: 3, toolUses: 2, maxUsageInput: 1_003_310 },
      ],
      claudeCompactions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', trigger: 'auto', preTokens: 1_000_000, postTokens: 100_000, tokensSaved: 900_000 },
      ],
      generatedAt: '2026-07-04T00:00:00.000Z',
    });

    const result = compareCompactBaselineGate(baseline, {
      schemaVersion: 1,
      minimums: {
        codex: {
          'hapi-codex': { sessions: 1, compactSessions: 1, compactEvents: 1 },
        },
        claude: { sessions: 1, compactBoundaries: 2 },
      },
      maximums: {
        codexPostOverPreMedian: { 'hapi-codex': 0.2 },
        claudePostOverPreMedian: 0.05,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toContain('codex.hapi-codex.compactSessions expected >= 1, got 0');
    expect(result.violations).toContain('codex.hapi-codex.compactEvents expected >= 1, got 0');
    expect(result.violations).toContain('codex.hapi-codex.postOverPreMedian expected <= 0.20, got 0.56');
    expect(result.violations).toContain('claude.compactBoundaries expected >= 2, got 1');
    expect(result.violations).toContain('claude.postOverPreMedian expected <= 0.05, got 0.10');
  });

  it('lets portable gates warn instead of failing when replay data is unavailable', () => {
    const baseline = buildCompactBaseline({
      codexSessions: [],
      codexCompactions: [],
      claudeSessions: [],
      claudeCompactions: [],
      generatedAt: '2026-07-04T00:00:00.000Z',
    });

    const result = compareCompactBaselineGate(baseline, {
      schemaVersion: 1,
      missingData: 'warn',
      maximums: {
        codexPostOverPreMedian: {
          'hapi-codex': 0.2,
          'cli-codex': 0.2,
        },
        claudePostOverPreMedian: 0.05,
      },
    });

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toContain('codex.hapi-codex.postOverPreMedian expected replay data, got none');
    expect(result.warnings).toContain('codex.cli-codex.postOverPreMedian expected replay data, got none');
    expect(result.warnings).toContain('claude.postOverPreMedian expected replay data, got none');
  });

  it('still fails portable gates when available replay ratios regress', () => {
    const baseline = buildCompactBaseline({
      codexSessions: [
        { kind: 'hapi-codex', sessionId: 'h1', contextCompacted: 1, finalTotal: 10_000, finalUncached: 7_000 },
      ],
      codexCompactions: [
        { kind: 'hapi-codex', sessionId: 'h1', preLastInput: 900, postLastInput: 500, postOverPre: 500 / 900 },
      ],
      claudeSessions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', compactBoundaries: 1, assistantMessages: 3, toolUses: 2 },
      ],
      claudeCompactions: [
        { sessionId: 'cl1', entrypoint: 'sdk-ts', trigger: 'auto', preTokens: 1_000_000, postTokens: 100_000 },
      ],
      generatedAt: '2026-07-04T00:00:00.000Z',
    });

    const result = compareCompactBaselineGate(baseline, {
      schemaVersion: 1,
      missingData: 'warn',
      maximums: {
        codexPostOverPreMedian: {
          'hapi-codex': 0.2,
          'cli-codex': 0.2,
        },
        claudePostOverPreMedian: 0.05,
      },
    });

    expect(result.passed).toBe(false);
    expect(result.violations).toContain('codex.hapi-codex.postOverPreMedian expected <= 0.20, got 0.56');
    expect(result.violations).toContain('claude.postOverPreMedian expected <= 0.05, got 0.10');
    expect(result.warnings).toContain('codex.cli-codex.postOverPreMedian expected replay data, got none');
  });
});
