#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  compareCompactBaselineGate,
  writeCompactBaselineArtifacts,
  type CompactBaselineGate,
} from './compactBaseline';

function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: bun cli/src/metrics/compactBaselineCli.ts [options]

Replay local Codex and Claude transcript logs into an offline token baseline dashboard.
No model calls are made.

Options:
  --out <dir>              Output directory. Default: ./hapi-token-baseline-<timestamp>
  --hapi-codex-root <dir>  Default: ~/.hapi/codex-home/sessions
  --cli-codex-root <dir>   Default: ~/.codex/sessions
  --claude-root <dir>      Default: ~/.claude/projects
  --check <file>           Compare replay summary against a gate JSON file and exit 1 on regression
  --json                   Print summary JSON instead of only the output directory
`);
  process.exit(0);
}

const outDir = expandHome(readArg('--out') ?? path.join(process.cwd(), `hapi-token-baseline-${timestampSlug()}`));
const hapiCodexRoot = expandHome(readArg('--hapi-codex-root') ?? '~/.hapi/codex-home/sessions');
const cliCodexRoot = expandHome(readArg('--cli-codex-root') ?? '~/.codex/sessions');
const claudeRoot = expandHome(readArg('--claude-root') ?? '~/.claude/projects');
const checkPath = readArg('--check');

const summary = await writeCompactBaselineArtifacts({
  outDir,
  hapiCodexRoot,
  cliCodexRoot,
  claudeRoot,
});

if (checkPath) {
  const gate = JSON.parse(await readFile(expandHome(checkPath), 'utf8')) as CompactBaselineGate;
  const result = compareCompactBaselineGate(summary, gate);
  for (const warning of result.warnings) {
    console.warn(`warning: ${warning}`);
  }
  if (!result.passed) {
    console.error(`Token replay gate failed: ${gate.name ?? checkPath}`);
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }
  console.log(`Token replay gate passed: ${gate.name ?? checkPath}`);
}

if (hasFlag('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else if (!checkPath) {
  console.log(outDir);
}
