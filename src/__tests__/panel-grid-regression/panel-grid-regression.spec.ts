import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../../styles/index.css');

function rule(selector: string): string {
  const css = readFileSync(cssPath, 'utf-8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  if (!match) throw new Error(`${selector} rule not found`);
  return match[0];
}

describe('CommitEditor panel grid regression guard', () => {
  it('T29 .cgv-panel declares five rows after CommitEditor insertion', () => {
    expect(rule('.cgv-panel')).toContain('grid-template-rows: auto auto minmax(0, 1fr) auto auto');
  });

  it('T30 .cgv-body remains the minmax(0, 1fr) main scroll row', () => {
    const panelRule = rule('.cgv-panel');
    expect(panelRule.indexOf('auto auto')).toBeLessThan(panelRule.indexOf('minmax(0, 1fr)'));
    expect(rule('.cgv-body')).toMatch(/min-height:\s*0/);
  });

  it('T31 .cgv-commit-editor is the second auto-sized top row', () => {
    expect(rule('.cgv-panel')).toContain('auto auto minmax(0, 1fr)');
    expect(rule('.cgv-commit-editor')).toMatch(/display:\s*grid/);
  });
});

