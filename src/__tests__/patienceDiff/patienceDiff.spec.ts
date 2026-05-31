// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { patienceDiff } from '../../diff/patienceDiff';
import { CodeMirrorMergeView } from '../../diff/merge-view';

describe('patienceDiff', () => {
  it('T1 keeps equal lines matched', () => {
    const out = patienceDiff(['a', 'b'], ['a', 'b']);

    expect(out.lines).toEqual([
      { line: 'a', aIndex: 0, bIndex: 0 },
      { line: 'b', aIndex: 1, bIndex: 1 },
    ]);
  });

  it('T2 marks insertions and deletions', () => {
    const out = patienceDiff(['a', 'old', 'c'], ['a', 'new', 'c']);

    expect(out.lines).toContainEqual({ line: 'old', aIndex: 1, bIndex: -1 });
    expect(out.lines).toContainEqual({ line: 'new', aIndex: -1, bIndex: 1 });
  });
});

describe('CodeMirrorMergeView', () => {
  it('T3 renders without throwing', () => {
    expect(() =>
      render(React.createElement(CodeMirrorMergeView, {
        original: 'a\nold\n',
        modified: 'a\nnew\n',
      })),
    ).not.toThrow();
  });
});
