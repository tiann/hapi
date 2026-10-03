/**
 * Runner doctor utilities
 * 
 * Process discovery and cleanup functions for the runner
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import { cliT } from '@/i18n/cliI18n'
import psList from 'ps-list';
import { killProcess } from '@/utils/process';

/**
 * Find all HAPI CLI processes (including current process)
 */
export async function findAllHappyProcesses(): Promise<Array<{ pid: number, command: string, type: string }>> {
  try {
    const processes = await psList();
    const allProcesses: Array<{ pid: number, command: string, type: string }> = [];
    
    for (const proc of processes) {
      const cmd = proc.cmd || '';
      const name = proc.name || '';
      
      // Check if it's a HAPI process
      const isHappyBinary = name === 'hapi' || name === 'hapi.exe' || /\bhapi(\.exe)?\b/.test(cmd);
      // Dev mode: running via bun/node with src/index.ts (production uses compiled binary)
      const isDevMode = cmd.includes('src/index.ts');
      const isHappy = name.includes('happy') ||
                      name === 'node' && cmd.includes('happy-cli') ||
                      cmd.includes('happy-coder') ||
                      isHappyBinary ||
                      isDevMode;
      
      if (!isHappy) continue;

      // Classify process type
      let type = 'unknown';
      if (proc.pid === process.pid) {
        type = 'current';
      } else if (cmd.includes('--version')) {
        type = isDevMode ? 'dev-runner-version-check' : 'runner-version-check';
      } else if (cmd.includes('runner start-sync') || cmd.includes('runner start')) {
        type = isDevMode ? 'dev-runner' : 'runner';
      } else if (cmd.includes('--started-by runner')) {
        type = isDevMode ? 'dev-runner-spawned' : 'runner-spawned-session';
      } else if (cmd.includes('doctor')) {
        type = isDevMode ? 'dev-doctor' : 'doctor';
      } else if (cmd.includes('--yolo')) {
        type = 'dev-session';
      } else {
        type = isDevMode ? 'dev-related' : 'user-session';
      }

      allProcesses.push({ pid: proc.pid, command: cmd || name, type });
    }

    return allProcesses;
  } catch (error) {
    return [];
  }
}

/**
 * Find all runaway HAPI CLI processes that should be killed
 */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number, command: string }>> {
  const allProcesses = await findAllHappyProcesses();
  
  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p => 
      p.pid !== process.pid && (
        p.type === 'runner' ||
        p.type === 'dev-runner' ||
        p.type === 'runner-spawned-session' ||
        p.type === 'dev-runner-spawned' ||
        p.type === 'runner-version-check' ||
        p.type === 'dev-runner-version-check'
      )
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway HAPI CLI processes
 */
export async function killRunawayHappyProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayHappyProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(cliT('doctor.clean.killing', { pid, command }));
      
      await killProcess(pid, false);

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if still alive
      const processes = await psList();
      const stillAlive = processes.find(p => p.pid === pid);
      if (stillAlive) {
        console.log(cliT('doctor.clean.force', { pid }));
        await killProcess(pid, true);
      }
      
      console.log(cliT('doctor.clean.killed', { pid }));
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(cliT('doctor.clean.failed', { pid, error: errorMessage }));
    }
  }

  return { killed, errors };
}
