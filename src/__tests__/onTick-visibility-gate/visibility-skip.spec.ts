// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * v0.2.2 onTick visibility gate: regression guard ensuring the in-tick
 * `document.visibilityState` check is preserved. The actual integration
 * (panel wires AutoRefreshTimer onTick) is covered by auto-refresh-wiring
 * specs; this spec locks in the pattern via source file grep.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const panelPath = resolve(here, '../../panel/GitViewerPanel.tsx');

function panelSource(): string {
  return readFileSync(panelPath, 'utf-8');
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setVisibility('visible');
});

describe('onTick visibility gate (v0.2.2)', () => {
  it('T1 GitViewerPanel onTick reads document.visibilityState and skips when not visible', () => {
    const src = panelSource();
    expect(src).toMatch(/document\.visibilityState\s*!==\s*['"]visible['"]/);
  });

  it('T2 the gate appears BEFORE readStatusHash call in onTick (skip without git work)', () => {
    const src = panelSource();
    // Find onTick callback body bounds
    const onTickIdx = src.indexOf('onTick:');
    expect(onTickIdx).toBeGreaterThanOrEqual(0);
    const visIdx = src.indexOf('document.visibilityState', onTickIdx);
    const readIdx = src.indexOf('readStatusHash', onTickIdx);
    expect(visIdx).toBeGreaterThan(0);
    expect(readIdx).toBeGreaterThan(visIdx);
  });

  it('T3 jsdom default visibilityState is "visible" (sanity check)', () => {
    expect(document.visibilityState).toBe('visible');
  });

  it('T4 setVisibility helper actually flips the value', () => {
    setVisibility('hidden');
    expect(document.visibilityState).toBe('hidden');
    setVisibility('visible');
    expect(document.visibilityState).toBe('visible');
  });
});
