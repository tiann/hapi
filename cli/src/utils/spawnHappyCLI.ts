/**
 * Cross-platform Happy CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with a JS runtime (Node.js or Bun). For Node we want to hide
 * deprecation warnings and other
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happy.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happy.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happy.cmd` and `happy.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happy` command
 * 2. Shell directly executes `bin/happy.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happy` command  
 * 2. NPM wrapper (`happy.cmd`) calls `node bin/happy.mjs`
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happy cli as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happy.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with the current
 * runtime), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn(process.execPath, ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 *
 * When running under Bun, we spawn the Bun executable with the entrypoint and
 * omit Node-specific flags.
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { isBunCompiled, projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';

/**
 * Spawn the Happy CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/happy.mjs) and spawns the
 * actual CLI entrypoint (dist/index.mjs) directly with the current runtime
 * (Node.js or Bun), ensuring compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Happy CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
function resolveEntrypointForBun(projectRoot: string): string {
  const distEntrypoint = join(projectRoot, 'dist', 'index.mjs');
  if (existsSync(distEntrypoint)) {
    return distEntrypoint;
  }

  const srcEntrypoint = join(projectRoot, 'src', 'index.ts');
  if (existsSync(srcEntrypoint)) {
    return srcEntrypoint;
  }

  throw new Error('No CLI entrypoint found for Bun runtime (expected dist/index.mjs or src/index.ts)');
}

export interface HappyCliCommand {
  command: string;
  args: string[];
}

export function getHappyCliCommand(args: string[]): HappyCliCommand {
  if (isBunCompiled()) {
    return {
      command: process.execPath,
      args
    };
  }

  const projectRoot = projectPath();
  const distEntrypoint = join(projectRoot, 'dist', 'index.mjs');
  const isBunRuntime = Boolean((process.versions as Record<string, string | undefined>).bun);
  const entrypoint = isBunRuntime ? resolveEntrypointForBun(projectRoot) : distEntrypoint;

  const spawnArgs = isBunRuntime ? [entrypoint, ...args] : [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  return {
    command: process.execPath,
    args: spawnArgs
  };
}

export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're executing the current runtime with the calculated entrypoint path below,
  // bypassing the 'happy' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'happy' here because other engineers are typically looking
  // for when "happy" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `hapi ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPI CLI] Spawning: ${fullCommand} in ${directory}`);
  
  const { command: spawnCommand, args: spawnArgs } = getHappyCliCommand(args);

  // Sanity check of the entrypoint path exists
  if (!isBunCompiled()) {
    const entrypoint = spawnArgs.find((arg) => arg.endsWith('index.mjs') || arg.endsWith('index.ts'));
    if (entrypoint && !existsSync(entrypoint)) {
      const errorMessage = `Entrypoint ${entrypoint} does not exist`;
      logger.debug(`[SPAWN HAPI CLI] ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }
  
  return spawn(spawnCommand, spawnArgs, options);
}
