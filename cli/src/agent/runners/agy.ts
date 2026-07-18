import { AgentRegistry } from '@/agent/AgentRegistry';
import { createAgyBackend } from '@/agy/utils/agyBackend';

export function registerAgyAgent(yolo: boolean): void {
    AgentRegistry.register('agy', () => createAgyBackend({
        permissionMode: yolo ? 'yolo' : 'default'
    }));
}
