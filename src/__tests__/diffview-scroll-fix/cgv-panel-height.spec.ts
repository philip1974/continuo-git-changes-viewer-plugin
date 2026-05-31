import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../../styles/index.css');

function readCgvPanelRule(): string {
  const css = readFileSync(cssPath, 'utf-8');
  const match = css.match(/\.cgv-panel\s*\{[^}]*\}/);
  if (!match) throw new Error('.cgv-panel rule not found in src/styles/index.css');
  return match[0];
}

describe('cgv-panel height regression guard (v0.1.8 hot-fix)', () => {
  it('T1 .cgv-panel uses `height: 100%` (locks panel to dockview parent)', () => {
    const rule = readCgvPanelRule();
    expect(rule).toMatch(/(^|\s|\n)height:\s*100%/);
  });

  it('T2 .cgv-panel does NOT use `min-height: 100%` (regression guard)', () => {
    const rule = readCgvPanelRule();
    // min-height: 100% lets panel grow past dockview parent → scroll lost
    expect(rule).not.toMatch(/min-height:\s*100%/);
  });
});
