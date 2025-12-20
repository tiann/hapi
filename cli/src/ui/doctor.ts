/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for hapi CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findRunawayHappyProcesses, findAllHappyProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isBunCompiled, projectPath, runtimePath } from '@/projectPath'
import packageJson from '../../package.json'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        HAPI_HOME_DIR: process.env.HAPI_HOME_DIR,
        HAPPY_BOT_URL: process.env.HAPPY_BOT_URL,
        HAPPY_PROJECT_ROOT: process.env.HAPPY_PROJECT_ROOT,
        CLI_API_TOKEN_SET: Boolean(process.env.CLI_API_TOKEN),
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: process.argv,
        happyDir: configuration?.happyHomeDir,
        serverUrl: configuration?.serverUrl,
        logsDir: configuration?.logsDir,
        processPid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        user: process.env.USER,
        home: process.env.HOME,
        shell: process.env.SHELL,
        terminal: process.env.TERM,
    };
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
        return [];
    }
}

/**
 * Run doctor command specifically for daemon diagnostics
 */
export async function runDoctorDaemon(): Promise<void> {
    return runDoctorCommand('daemon');
}

export async function runDoctorCommand(filter?: 'all' | 'daemon'): Promise<void> {
    // Default to 'all' if no filter specified
    if (!filter) {
        filter = 'all';
    }
    
    console.log(chalk.bold.cyan('\n🩺 hapi CLI Doctor\n'));

    // For 'all' filter, show everything. For 'daemon', only show daemon-related info
    if (filter === 'all') {
        // Version and basic info
        console.log(chalk.bold('📋 Basic Information'));
        console.log(`hapi CLI Version: ${chalk.green(packageJson.version)}`);
        console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
        console.log(`Node.js Version: ${chalk.green(process.version)}`);
        console.log('');

        // Daemon spawn diagnostics
        console.log(chalk.bold('🔧 Daemon Spawn Diagnostics'));
        const projectRoot = projectPath();
        const wrapperPath = join(projectRoot, 'bin', 'happy.mjs');
        const cliEntrypoint = join(projectRoot, 'dist', 'index.mjs');
        
        if (isBunCompiled()) {
            console.log(`Executable: ${chalk.blue(process.execPath)}`);
            console.log(`Runtime Assets: ${chalk.blue(runtimePath())}`);
        } else {
            console.log(`Project Root: ${chalk.blue(projectRoot)}`);
            console.log(`Wrapper Script: ${chalk.blue(wrapperPath)}`);
            console.log(`CLI Entrypoint: ${chalk.blue(cliEntrypoint)}`);
            console.log(`Wrapper Exists: ${existsSync(wrapperPath) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
            console.log(`CLI Exists: ${existsSync(cliEntrypoint) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
        }
        console.log('');

        // Configuration
        console.log(chalk.bold('⚙️  Configuration'));
        console.log(`hapi Home: ${chalk.blue(configuration.happyHomeDir)}`);
        console.log(`Bot URL: ${chalk.blue(configuration.serverUrl)}`);
        console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

        // Environment
        console.log(chalk.bold('\n🌍 Environment Variables'));
        const env = getEnvironmentInfo();
        console.log(`HAPI_HOME_DIR: ${env.HAPI_HOME_DIR ? chalk.green(env.HAPI_HOME_DIR) : chalk.gray('not set')}`);
        console.log(`HAPPY_BOT_URL: ${env.HAPPY_BOT_URL ? chalk.green(env.HAPPY_BOT_URL) : chalk.gray('not set')}`);
        console.log(`CLI_API_TOKEN: ${env.CLI_API_TOKEN_SET ? chalk.green('set') : chalk.gray('not set')}`);
        console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING ? chalk.yellow('ENABLED') : chalk.gray('not set')}`);
        console.log(`DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray('not set')}`);
        console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray('not set')}`);

        // Settings
        let settings;
        try {
            settings = await readSettings();
            console.log(chalk.bold('\n📄 Settings (settings.json):'));
            // Hide cliApiToken in output for security
            const displaySettings = { ...settings, cliApiToken: settings.cliApiToken ? '***' : undefined };
            console.log(chalk.gray(JSON.stringify(displaySettings, null, 2)));
        } catch (error) {
            console.log(chalk.bold('\n📄 Settings:'));
            console.log(chalk.red('❌ Failed to read settings'));
            settings = {};
        }

        // Authentication status (direct-connect)
        console.log(chalk.bold('\n🔐 Direct Connect Auth'));
        const envToken = process.env.CLI_API_TOKEN;
        const settingsToken = settings.cliApiToken;
        const hasToken = Boolean(envToken || settingsToken);
        const tokenSource = envToken ? 'environment variable' : (settingsToken ? 'settings file' : 'none');
        if (hasToken) {
            console.log(chalk.green(`✓ CLI_API_TOKEN is set (from ${tokenSource})`));
        } else {
            console.log(chalk.red('❌ CLI_API_TOKEN is not set'));
            console.log(chalk.gray('  Run `hapi auth login` to configure or set CLI_API_TOKEN env var'));
        }

        // Legacy credentials (unused in direct-connect mode)
        try {
            const credentials = await readCredentials();
            if (credentials) {
                console.log(chalk.yellow('⚠️  Legacy credentials file present (unused in direct-connect mode)'));
            }
        } catch {
            // ignore
        }
    }

    // Daemon status - shown for both 'all' and 'daemon' filters
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        if (isRunning && state) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${state.pid}`);
            console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
            console.log(`  CLI Version: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  HTTP Port: ${state.httpPort}`);
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(state, null, 2)));
        }

        // All hapi processes
        const allProcesses = await findAllHappyProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold('\n🔍 All hapi CLI Processes'));

            // Group by type
            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            // Display each group
            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': '📍 Current Process',
                    'daemon': '🤖 Daemon',
                    'daemon-version-check': '🔍 Daemon Version Check (stuck)',
                    'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                    'user-session': '👤 User Sessions',
                    'dev-daemon': '🛠️  Dev Daemon',
                    'dev-daemon-version-check': '🛠️  Dev Daemon Version Check (stuck)',
                    'dev-session': '🛠️  Dev Sessions',
                    'dev-doctor': '🛠️  Dev Doctor',
                    'dev-related': '🛠️  Dev Related',
                    'doctor': '🩺 Doctor',
                    'unknown': '❓ Unknown'
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach(({ pid, command }) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('daemon') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
                });
            });
        } else {
            console.log(chalk.red('❌ No hapi processes found'));
        }

        if (filter === 'all' && allProcesses.length > 1) { // More than just current process
            console.log(chalk.bold('\n💡 Process Management'));
            console.log(chalk.gray('To clean up runaway processes: hapi doctor clean'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    // Log files - only show for 'all' filter
    if (filter === 'all') {
        console.log(chalk.bold('\n📝 Log Files'));

        // Get ALL log files
        const allLogs = getLogFiles(configuration.logsDir);
        
        if (allLogs.length > 0) {
            // Separate daemon and regular logs
            const daemonLogs = allLogs.filter(({ file }) => file.includes('daemon'));
            const regularLogs = allLogs.filter(({ file }) => !file.includes('daemon'));

            // Show regular logs (max 10)
            if (regularLogs.length > 0) {
                console.log(chalk.blue('\nRecent Logs:'));
                const logsToShow = regularLogs.slice(0, 10);
                logsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (regularLogs.length > 10) {
                    console.log(chalk.gray(`  ... and ${regularLogs.length - 10} more log files`));
                }
            }

            // Show daemon logs (max 5)
            if (daemonLogs.length > 0) {
                console.log(chalk.blue('\nDaemon Logs:'));
                const daemonLogsToShow = daemonLogs.slice(0, 5);
                daemonLogsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (daemonLogs.length > 5) {
                    console.log(chalk.gray(`  ... and ${daemonLogs.length - 5} more daemon log files`));
                }
            } else {
                console.log(chalk.yellow('\nNo daemon log files found'));
            }
        } else {
            console.log(chalk.yellow('No log files found'));
        }

        // Support and bug reports
        console.log(chalk.bold('\n🐛 Support & Bug Reports'));
        const pkg = packageJson as unknown as { bugs?: string | { url?: string }; homepage?: string }
        const bugsUrl = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url
        if (bugsUrl) {
            console.log(`Report issues: ${chalk.blue(bugsUrl)}`);
        }
        console.log(`Documentation: ${chalk.blue(pkg.homepage ?? 'See project README')}`);
    }

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}
