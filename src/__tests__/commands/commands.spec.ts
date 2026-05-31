import { describe, expect, it, vi } from 'vitest';
import { registerCommands } from '../../commands';
import type { CoPluginApp, CommandSpec } from '../../sdk/types';

describe('commands', () => {
  it('T1 registers only git-viewer.refresh', () => {
    const specs: CommandSpec[] = [];
    const app = {
      commands: {
        register: vi.fn((spec: CommandSpec) => {
          specs.push(spec);
          return { dispose() {} };
        }),
      },
    } as unknown as CoPluginApp;

    registerCommands(app, { refresh: vi.fn() });

    expect(specs.map((spec) => spec.id)).toEqual(['git-viewer.refresh']);
  });

  it('T2 routes refresh command to store.refresh', async () => {
    const specs: CommandSpec[] = [];
    const refresh = vi.fn().mockResolvedValue(undefined);
    const app = {
      commands: {
        register: vi.fn((next: CommandSpec) => {
          specs.push(next);
          return { dispose() {} };
        }),
      },
    } as unknown as CoPluginApp;

    registerCommands(app, { refresh });
    const registered = specs[0];
    if (!registered) throw new Error('expected command registration');
    await registered.fn();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
