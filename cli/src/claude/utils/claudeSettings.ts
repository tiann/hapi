/**
 * Utilities for reading Claude's settings.json configuration
 * 
 * Handles reading Claude's settings.json file to respect user preferences
 * like includeCoAuthoredBy setting for commit message generation.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '@/ui/logger';

export interface ClaudeSettings {
  includeCoAuthoredBy?: boolean;
  [key: string]: any;
}

/**
 * Get the path to Claude's settings.json file
 */
function getClaudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(claudeConfigDir, 'settings.json');
}

function readSettingsModel(path: string): string | undefined {
  try {
    const model = JSON.parse(readFileSync(path, 'utf-8'))?.model;
    return typeof model === 'string' ? model.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

function readArg(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length && !args[i + 1].startsWith('-')) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/**
 * The model Claude Code starts with, with any "[1m]" suffix intact, using its
 * launch precedence: --model, ANTHROPIC_MODEL, project local settings, project
 * settings, user settings (limited by --setting-sources). `env` is the extra
 * env HAPI passes to the process; `args` are the user's extra Claude args.
 */
export function resolveClaudeLaunchModel(opts: { model?: string | null; cwd: string; env?: Record<string, string>; args?: string[] }): string | null {
  const env = { ...process.env, ...opts.env };
  const args = opts.args ?? [];
  const sources = readArg(args, '--setting-sources')?.split(',').map((s) => s.trim()) ?? ['user', 'project', 'local'];
  return opts.model?.trim()
    || readArg(args, '--model')?.trim()
    || env.ANTHROPIC_MODEL?.trim()
    || (sources.includes('local') ? readSettingsModel(join(opts.cwd, '.claude', 'settings.local.json')) : undefined)
    || (sources.includes('project') ? readSettingsModel(join(opts.cwd, '.claude', 'settings.json')) : undefined)
    || (sources.includes('user') ? readSettingsModel(getClaudeSettingsPath(env)) : undefined)
    || null;
}

/**
 * Read Claude's settings.json file from the default location
 * 
 * @returns Claude settings object or null if file doesn't exist or can't be read
 */
export function readClaudeSettings(): ClaudeSettings | null {
  try {
    const settingsPath = getClaudeSettingsPath();
    
    if (!existsSync(settingsPath)) {
      logger.debug(`[ClaudeSettings] No Claude settings file found at ${settingsPath}`);
      return null;
    }
    
    const settingsContent = readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(settingsContent) as ClaudeSettings;
    
    logger.debug(`[ClaudeSettings] Successfully read Claude settings from ${settingsPath}`);
    logger.debug(`[ClaudeSettings] includeCoAuthoredBy: ${settings.includeCoAuthoredBy}`);
    
    return settings;
  } catch (error) {
    logger.debug(`[ClaudeSettings] Error reading Claude settings: ${error}`);
    return null;
  }
}

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Claude's settings
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const settings = readClaudeSettings();
  
  // If no settings file or includeCoAuthoredBy is not explicitly set,
  // default to true to maintain backward compatibility
  if (!settings || settings.includeCoAuthoredBy === undefined) {
    return true;
  }
  
  return settings.includeCoAuthoredBy;
}