import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Fragment, jsx, jsxs } from '../../sdk/jsx-runtime';

interface FakeReactCall {
  type: unknown;
  props: unknown;
  children: unknown[];
}

let calls: FakeReactCall[];
const REAL_FRAGMENT_MARKER = Symbol('host-react-fragment');

function fakeReact() {
  return {
    Fragment: REAL_FRAGMENT_MARKER,
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      const call: FakeReactCall = { type, props, children };
      calls.push(call);
      return call;
    },
  };
}

beforeEach(() => {
  calls = [];
  (globalThis as { co?: unknown }).co = { React: fakeReact() };
});

afterEach(() => {
  (globalThis as { co?: unknown }).co = undefined;
  vi.restoreAllMocks();
});

describe('jsx-runtime shim', () => {
  it('T1 jsx(Fragment, {children:[a,b]}) resolves to host React.Fragment with spread children', () => {
    const a = { tag: 'a' };
    const b = { tag: 'b' };
    jsx(Fragment, { children: [a, b] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe(REAL_FRAGMENT_MARKER);
    expect(calls[0]?.children).toEqual([a, b]);
  });

  it('T2 jsx("div", {className,children:[a,b]}) strips children from props and spreads to createElement', () => {
    const a = { tag: 'a' };
    const b = { tag: 'b' };
    jsx('div', { className: 'x', children: [a, b] });

    expect(calls[0]?.type).toBe('div');
    expect(calls[0]?.props).toEqual({ className: 'x' });
    expect(calls[0]?.children).toEqual([a, b]);
  });

  it('T3 jsx("div", {children:single}) passes single child as positional arg', () => {
    const child = { tag: 'span' };
    jsx('div', { className: 'x', children: child });

    expect(calls[0]?.props).toEqual({ className: 'x' });
    expect(calls[0]?.children).toEqual([child]);
  });

  it('T4 jsx with key adds key to props and still resolves Fragment', () => {
    jsx(Fragment, { children: [] }, 'mykey');

    expect(calls[0]?.type).toBe(REAL_FRAGMENT_MARKER);
    expect(calls[0]?.props).toEqual({ key: 'mykey' });
    expect(calls[0]?.children).toEqual([]);
  });

  it('T5 jsxs is an alias of jsx (same children-spread behavior)', () => {
    const a = {};
    const b = {};
    jsxs('section', { children: [a, b] });

    expect(calls[0]?.type).toBe('section');
    expect(calls[0]?.children).toEqual([a, b]);
  });

  it('T6 jsx with no children passes props unchanged (no positional children)', () => {
    jsx('hr', { className: 'sep' });

    expect(calls[0]?.props).toEqual({ className: 'sep' });
    expect(calls[0]?.children).toEqual([]);
  });

  it('T7 Fragment exported is a Symbol sentinel (not Proxy/object)', () => {
    expect(typeof Fragment).toBe('symbol');
    expect(Symbol.keyFor(Fragment as symbol)).toBe('git-viewer.fragment.shim');
  });
});
