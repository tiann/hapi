import { logger } from '@/ui/logger';
import { uninstall as uninstallMac } from './mac/uninstall';

export async function uninstall(): Promise<void> {
    if (process.platform === 'win32') {
        throw new Error('Daemon uninstallation as Windows service not yet supported. Use "hapi daemon start".');
    }

    if (process.platform !== 'darwin') {
        throw new Error('Daemon uninstallation is currently only supported on macOS');
    }
    
    if (process.getuid && process.getuid() !== 0) {
        throw new Error('Daemon uninstallation requires sudo privileges. Please run with sudo.');
    }
    
    logger.info('Uninstalling HAPI CLI daemon for macOS...');
    await uninstallMac();
}
