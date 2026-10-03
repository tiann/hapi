/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for hapi CLI including configuration, runner status, logs, and links
 */

import chalk from 'chalk'
import { cliT } from '@/i18n/cliI18n'
import { configuration } from '@/configuration'
import { readSettings } from '@/persistence'
import { checkIfRunnerRunningAndCleanupStaleState } from '@/runner/controlClient'
import { findRunawayHappyProcesses, findAllHappyProcesses } from '@/runner/doctor'
import { readRunnerState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isBunCompiled, projectPath, runtimePath } from '@/projectPath'
import { getInvokedCwd } from '@/utils/invokedCwd'
import packageJson from '../../package.json'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        HAPI_HOME: process.env.HAPI_HOME,
        HAPI_API_URL: process.env.HAPI_API_URL,
        HAPI_PROJECT_ROOT: process.env.HAPI_PROJECT_ROOT,
        CLI_API_TOKEN_SET: Boolean(process.env.CLI_API_TOKEN),
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: getInvokedCwd(),
        processArgv: process.argv,
        happyDir: configuration?.happyHomeDir,
        apiUrl: configuration?.apiUrl,
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

export function redactSettingsForDisplay(settings: Record<string, unknown>): Record<string, unknown> {
    return {
        ...settings,
        cliApiToken: settings.cliApiToken ? '***' : undefined,
        extraHeaders: settings.extraHeaders === undefined ? undefined : '***'
    }
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
 * Run doctor command specifically for runner diagnostics
 */
export async function runDoctorRunner(): Promise<void> {
    return runDoctorCommand('runner');
}

export async function runDoctorCommand(filter?: 'all' | 'runner'): Promise<void> {
    // Default to 'all' if no filter specified
    if (!filter) {
        filter = 'all';
    }
    
    console.log(chalk.bold.cyan(`\n${cliT('doctor.title')}\n`));

    // For 'all' filter, show everything. For 'runner', only show runner-related info
    if (filter === 'all') {
        // Version and basic info
        console.log(chalk.bold(cliT('doctor.section.basic')));
        console.log(`${cliT('doctor.label.cliVersion')}: ${chalk.green(packageJson.version)}`);
        console.log(`${cliT('doctor.label.platform')}: ${chalk.green(process.platform)} ${process.arch}`);
        console.log(`${cliT('doctor.label.nodeVersion')}: ${chalk.green(process.version)}`);
        console.log('');

        // Runner spawn diagnostics
        console.log(chalk.bold(cliT('doctor.section.spawn')));
        const projectRoot = projectPath();
        const cliEntrypoint = join(projectRoot, 'src', 'index.ts');

        if (isBunCompiled()) {
            console.log(`${cliT('doctor.label.executable')}: ${chalk.blue(process.execPath)}`);
            console.log(`${cliT('doctor.label.runtimeAssets')}: ${chalk.blue(runtimePath())}`);
        } else {
            console.log(`${cliT('doctor.label.projectRoot')}: ${chalk.blue(projectRoot)}`);
            console.log(`${cliT('doctor.label.cliEntrypoint')}: ${chalk.blue(cliEntrypoint)}`);
            console.log(`${cliT('doctor.label.cliExists')}: ${existsSync(cliEntrypoint) ? chalk.green(cliT('doctor.value.yes')) : chalk.red(cliT('doctor.value.no'))}`);
        }
        console.log('');

        // Configuration
        console.log(chalk.bold(cliT('doctor.section.config')));
        console.log(`${cliT('doctor.label.hapiHome')}: ${chalk.blue(configuration.happyHomeDir)}`);
        console.log(`${cliT('doctor.label.botUrl')}: ${chalk.blue(configuration.apiUrl)}`);
        console.log(`${cliT('doctor.label.logsDir')}: ${chalk.blue(configuration.logsDir)}`);

        // Environment
        console.log(chalk.bold(`\n${cliT('doctor.section.env')}`));
        const env = getEnvironmentInfo();
        console.log(`HAPI_HOME: ${env.HAPI_HOME ? chalk.green(env.HAPI_HOME) : chalk.gray(cliT('doctor.value.notSet'))}`);
        console.log(`HAPI_API_URL: ${env.HAPI_API_URL ? chalk.green(env.HAPI_API_URL) : chalk.gray(cliT('doctor.value.notSet'))}`);
        console.log(`CLI_API_TOKEN: ${env.CLI_API_TOKEN_SET ? chalk.green(cliT('doctor.value.set')) : chalk.gray(cliT('doctor.value.notSet'))}`);
        console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING ? chalk.yellow(cliT('doctor.value.enabled')) : chalk.gray(cliT('doctor.value.notSet'))}`);
        console.log(`DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray(cliT('doctor.value.notSet'))}`);
        console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray(cliT('doctor.value.notSet'))}`);

        // Settings
        let settings;
        try {
            settings = await readSettings();
            console.log(chalk.bold(`\n${cliT('doctor.section.settingsFile')}`));
            const displaySettings = redactSettingsForDisplay({ ...settings });
            console.log(chalk.gray(JSON.stringify(displaySettings, null, 2)));
        } catch (error) {
            console.log(chalk.bold(`\n${cliT('doctor.section.settings')}:`));
            console.log(chalk.red(cliT('doctor.settings.failed')));
            settings = {};
        }

        // Authentication status (direct-connect)
        console.log(chalk.bold(`\n${cliT('doctor.section.auth')}`));
        const envToken = process.env.CLI_API_TOKEN;
        const settingsToken = settings.cliApiToken;
        const hasToken = Boolean(envToken || settingsToken);
        const tokenSource = envToken
            ? cliT('doctor.auth.source.environment')
            : (settingsToken ? cliT('doctor.auth.source.settingsFile') : cliT('doctor.auth.source.none'));
        if (hasToken) {
            console.log(chalk.green(cliT('doctor.auth.set', { source: tokenSource })));
        } else {
            console.log(chalk.red(cliT('doctor.auth.missing')));
            console.log(chalk.gray(cliT('doctor.auth.hint')));
        }

    }

    // Runner status - shown for both 'all' and 'runner' filters
    console.log(chalk.bold(`\n${cliT('doctor.section.runner')}`));
    try {
        const isRunning = await checkIfRunnerRunningAndCleanupStaleState();
        const state = await readRunnerState();

        if (isRunning && state) {
            console.log(chalk.green(cliT('doctor.runner.running')));
            console.log(`  ${cliT('doctor.label.pid')}: ${state.pid}`);
            console.log(`  ${cliT('doctor.label.started')}: ${new Date(state.startTime).toLocaleString()}`);
            console.log(`  ${cliT('doctor.label.cliVersion')}: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  ${cliT('doctor.label.httpPort')}: ${state.httpPort}`);
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow(cliT('doctor.runner.stale')));
        } else {
            console.log(chalk.red(cliT('doctor.runner.notRunning')));
        }

        // Show runner state file
        if (state) {
            console.log(chalk.bold(`\n${cliT('doctor.section.runnerState')}`));
            console.log(chalk.blue(`${cliT('doctor.label.location')}: ${configuration.runnerStateFile}`));
            console.log(chalk.gray(JSON.stringify(state, null, 2)));
        }

        // All hapi processes
        const allProcesses = await findAllHappyProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold(`\n${cliT('doctor.section.processes')}`));

            // Group by type
            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            // Display each group
            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': cliT('doctor.processType.current'),
                    'runner': cliT('doctor.processType.runner'),
                    'runner-version-check': cliT('doctor.processType.runnerVersionCheck'),
                    'runner-spawned-session': cliT('doctor.processType.runnerSpawnedSession'),
                    'user-session': cliT('doctor.processType.userSession'),
                    'dev-runner': cliT('doctor.processType.devRunner'),
                    'dev-runner-version-check': cliT('doctor.processType.devRunnerVersionCheck'),
                    'dev-session': cliT('doctor.processType.devSession'),
                    'dev-doctor': cliT('doctor.processType.devDoctor'),
                    'dev-related': cliT('doctor.processType.devRelated'),
                    'doctor': cliT('doctor.processType.doctor'),
                    'unknown': cliT('doctor.processType.unknown')
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach(({ pid, command }) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('runner') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
                });
            });
        } else {
            console.log(chalk.red(cliT('doctor.processes.none')));
        }

        if (filter === 'all' && allProcesses.length > 1) { // More than just current process
            console.log(chalk.bold(`\n${cliT('doctor.section.processManagement')}`));
            console.log(chalk.gray(cliT('doctor.processes.cleanupHint')));
        }
    } catch (error) {
        console.log(chalk.red(cliT('doctor.processes.error')));
    }

    // Log files - only show for 'all' filter
    if (filter === 'all') {
        console.log(chalk.bold(`\n${cliT('doctor.section.logs')}`));

        // Get ALL log files
        const allLogs = getLogFiles(configuration.logsDir);
        
        if (allLogs.length > 0) {
            // Separate runner and regular logs
            const runnerLogs = allLogs.filter(({ file }) => file.includes('runner'));
            const regularLogs = allLogs.filter(({ file }) => !file.includes('runner'));

            // Show regular logs (max 10)
            if (regularLogs.length > 0) {
                console.log(chalk.blue(`\n${cliT('doctor.logs.recent')}`));
                const logsToShow = regularLogs.slice(0, 10);
                logsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (regularLogs.length > 10) {
                    console.log(chalk.gray(cliT('doctor.logs.more', { count: regularLogs.length - 10 })));
                }
            }

            // Show runner logs (max 5)
            if (runnerLogs.length > 0) {
                console.log(chalk.blue(`\n${cliT('doctor.logs.runner')}`));
                const runnerLogsToShow = runnerLogs.slice(0, 5);
                runnerLogsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (runnerLogs.length > 5) {
                    console.log(chalk.gray(cliT('doctor.logs.moreRunner', { count: runnerLogs.length - 5 })));
                }
            } else {
                console.log(chalk.yellow(`\n${cliT('doctor.logs.noRunner')}`));
            }
        } else {
            console.log(chalk.yellow(cliT('doctor.logs.none')));
        }

        // Support and bug reports
        console.log(chalk.bold(`\n${cliT('doctor.section.support')}`));
        const pkg = packageJson as unknown as { bugs?: string | { url?: string }; homepage?: string }
        const bugsUrl = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url
        if (bugsUrl) {
            console.log(`${cliT('doctor.support.report')} ${chalk.blue(bugsUrl)}`);
        }
        console.log(`${cliT('doctor.support.docs')} ${chalk.blue(pkg.homepage ?? cliT('doctor.support.readme'))}`);
    }

    console.log(chalk.green(`\n${cliT('doctor.done')}\n`));
}
