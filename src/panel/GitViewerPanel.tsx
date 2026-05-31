import { useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DiffResult } from '../git/diff-fetcher';
import type { GitViewerState } from '../state/git-store';
import { FileList } from './FileList';
import { DiffView } from './DiffView';
import '../styles/index.css';

interface GitViewerPanelProps {
  readonly store: StoreApi<GitViewerState>;
  readonly diff?: DiffResult | null;
}

export function GitViewerPanel({ store, diff = null }: GitViewerPanelProps) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  const selected =
    state.changes.find((change) => change.path === state.selectedPath) ??
    state.changes[0] ??
    null;

  return (
    <section className="cgv-panel">
      <div className="cgv-body">
        <FileList store={store} changes={state.changes} />
        <DiffView store={store} change={selected} diff={diff} />
      </div>
      {state.banner ? (
        <div className={`cgv-banner cgv-banner--${state.banner.kind}`}>
          <span>{state.banner.message}</span>
          {state.banner.dismissable ? (
            <button type="button" onClick={() => store.getState().dismissBanner()}>
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
