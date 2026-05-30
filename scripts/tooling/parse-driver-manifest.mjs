#!/usr/bin/env bun
/**
 * Minimal YAML subset parser for ~/.config/hapi/driver-manifest.yaml
 * Supports: base, layers with branch / pr / integrate keys.
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: parse-driver-manifest.mjs <manifest.yaml>');
    process.exit(2);
}

const text = readFileSync(path, 'utf8');
const result = { base: 'upstream/main', layers: [] };

for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const baseMatch = line.match(/^base:\s*(.+)$/);
    if (baseMatch) {
        result.base = baseMatch[1].trim();
        continue;
    }

    const branchMatch = line.match(/^\s*-\s*branch:\s*(.+)$/);
    if (branchMatch) {
        result.layers.push({ type: 'branch', ref: branchMatch[1].trim() });
        continue;
    }

    const prMatch = line.match(/^\s*-\s*pr:\s*(\d+)\s*$/);
    if (prMatch) {
        result.layers.push({ type: 'pr', ref: Number(prMatch[1]) });
        continue;
    }

    const integrateMatch = line.match(/^\s*-\s*integrate:\s*(.+)$/);
    if (integrateMatch) {
        result.layers.push({ type: 'integrate', ref: integrateMatch[1].trim() });
        continue;
    }
}

console.log(JSON.stringify(result));
