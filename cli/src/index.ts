#!/usr/bin/env bun

/**
 * CLI entry point for hapi command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import type { StartOptions } from '@/claude/runClaude'
import { logger } from './ui/logger'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { isBunCompiled } from './projectPath'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayHappyProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { runDoctorCommand } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { spawnHappyCLI } from './utils/spawnHappyCLI'
import { claudeCliPath } from './claude/claudeLocal'
import { execFileSync } from 'node:child_process'
import { initializeToken } from './ui/tokenInit'
import { ensureRuntimeAssets } from './runtime/assets'
import { runHappyMcpStdioBridge } from './codex/happyMcpStdioBridge'
import { withBunRuntimeEnv } from './utils/bunRuntime'


(async () => {
  const args = (() => {
    if (!isBunCompiled()) {
      return process.argv.slice(2)
    }

    const arg1 = process.argv[1] || ''
    if (arg1 === process.execPath) {
      return process.argv.slice(2)
    }
    if (arg1.includes('$bunfs')) {
      return process.argv.slice(2)
    }
    if (arg1.endsWith('.js') || arg1.endsWith('.mjs') || arg1.endsWith('.ts')) {
      return process.argv.slice(2)
    }

    return process.argv.slice(1)
  })()

  // Check if first argument is a subcommand
  const subcommand = args[0]

  if (isBunCompiled()) {
    process.env.DEV = 'false'
  }

  if (subcommand === 'mcp') {
    await runHappyMcpStdioBridge(args.slice(1))
    return
  }

  if (subcommand === 'server') {
    try {
      await import('../../server/src/index')
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return
  }

  await ensureRuntimeAssets()

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting hapi CLI with args: ', process.argv)
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayHappyProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      const { runCodex } = await import('@/codex/runCodex');

      // Parse known arguments and collect unknown ones for passthrough
      const options: { startedBy?: 'daemon' | 'terminal'; codexArgs?: string[] } = {};
      const unknownArgs: string[] = [];
      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--started-by') {
          options.startedBy = args[++i] as 'daemon' | 'terminal';
        } else {
          unknownArgs.push(arg);
        }
      }
      if (unknownArgs.length > 0) {
        options.codexArgs = unknownArgs;
      }

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runCodex(options);
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini command
    try {
      await import('./agent/runners/gemini');
      const { runAgentSession } = await import('./agent/runners/runAgentSession');

      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }

      await initializeToken();
      await authAndSetupMachineIfNeeded();
      await runAgentSession({ agentType: 'gemini', startedBy });
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "hapi logout" is deprecated. Use "hapi auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    console.error(chalk.red('The `hapi notify` command is not available in direct-connect mode.'))
    console.error(chalk.gray('Use Telegram notifications from hapi-server instead.'))
    process.exit(1)
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await initializeToken();
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      // Show daemon-specific doctor output
      await runDoctorCommand('daemon')
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('hapi daemon')} - Daemon management

${chalk.bold('Usage:')}
  hapi daemon start              Start the daemon (detached)
  hapi daemon stop               Stop the daemon (sessions stay alive)
  hapi daemon status             Show daemon status
  hapi daemon list               List active sessions

  If you want to kill all hapi related processes run 
  ${chalk.cyan('hapi doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('hapi doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--hapi-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('hapi')} - Claude Code On the Go

${chalk.bold('Usage:')}
  hapi [options]         Start Claude with Telegram control (direct-connect)
  hapi auth              Manage authentication
  hapi codex             Start Codex mode
  hapi gemini            Start Gemini ACP mode
  hapi mcp               Start MCP stdio bridge
  hapi connect           (not available in direct-connect mode)
  hapi notify            (not available in direct-connect mode)
  hapi server            Start the API + web server
  hapi daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  hapi doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  hapi                    Start session (will prompt for token if not set)
  hapi auth login         Configure CLI_API_TOKEN interactively
  hapi --yolo             Start with bypassing permissions
                            hapi sugar for --dangerously-skip-permissions
  hapi auth status        Show direct-connect status
  hapi doctor             Run diagnostics

${chalk.bold('hapi supports ALL Claude options!')}
  Use any claude flag with hapi as you would with claude. Our favorite:

  hapi --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)
      
      // Run claude --help and display its output
      // Use execFileSync with the current Node executable for cross-platform compatibility
      try {
        const claudeHelp = execFileSync(
          process.execPath,
          [claudeCliPath, '--help'],
          { encoding: 'utf8', env: withBunRuntimeEnv() }
        )
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }
      
      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`hapi version: ${packageJson.version}`)
      const versionOnly = args.every((value) => value === '-v' || value === '--version')
      if (versionOnly) {
        process.exit(0)
      }
      // Continue to pass --version to Claude Code when other args are present.
    }

    // Normal flow - auth and machine setup
    await initializeToken();
    await authAndSetupMachineIfNeeded();

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring hapi background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting hapi background service...');

      // Use the built binary to spawn daemon
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref();

      // Give daemon a moment to write PID & port file
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Start the CLI
    try {
      const { runClaude } = await import('@/claude/runClaude');
      await runClaude(options);
    } catch (error) {
      // Categorize errors for better user experience
      const message = error instanceof Error ? error.message : 'Unknown error';
      const messageLower = message.toLowerCase();
      const axiosCode = (error as any)?.code;
      const httpStatus = (error as any)?.response?.status;

      if (axiosCode === 'ECONNREFUSED' || axiosCode === 'ETIMEDOUT' || axiosCode === 'ENOTFOUND' ||
          messageLower.includes('econnrefused') || messageLower.includes('etimedout') ||
          messageLower.includes('enotfound') || messageLower.includes('network error')) {
        const { configuration } = await import('@/configuration');
        console.error(chalk.yellow('Unable to connect to HAPI server'));
        console.error(chalk.gray(`  Server URL: ${configuration.serverUrl}`));
        console.error(chalk.gray('  Please check your network connection or server status'));
      } else if (httpStatus === 401 || httpStatus === 403 ||
                 messageLower.includes('unauthorized') || messageLower.includes('forbidden')) {
        console.error(chalk.red('Authentication error:'), message);
        console.error(chalk.gray('  Run: hapi auth login'));
      } else {
        console.error(chalk.red('Error:'), message);
      }

      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
})();
