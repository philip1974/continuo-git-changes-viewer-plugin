import { useEffect } from 'react';

export type PreviewDrawerState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'previewing'; readonly filePath: string; readonly patch: string }
  | { readonly kind: 'applying'; readonly filePath: string; readonly patch: string }
  | { readonly kind: 'success'; readonly filePath: string }
  | {
      readonly kind: 'error';
      readonly filePath: string;
      readonly patch: string;
      readonly error: string;
    };

export type PreviewDrawerAction =
  | { readonly type: 'open'; readonly filePath: string; readonly patch: string }
  | { readonly type: 'confirm' }
  | { readonly type: 'succeed' }
  | { readonly type: 'fail'; readonly error: string }
  | { readonly type: 'cancel' }
  | { readonly type: 'dismiss' };

export function previewDrawerReducer(
  state: PreviewDrawerState,
  action: PreviewDrawerAction,
): PreviewDrawerState {
  switch (action.type) {
    case 'open':
      return {
        kind: 'previewing',
        filePath: action.filePath,
        patch: action.patch,
      };
    case 'confirm':
      if (state.kind !== 'previewing' && state.kind !== 'error') return state;
      return {
        kind: 'applying',
        filePath: state.filePath,
        patch: state.patch,
      };
    case 'succeed':
      if (state.kind !== 'applying') return state;
      return { kind: 'success', filePath: state.filePath };
    case 'fail':
      if (state.kind !== 'applying') return state;
      return {
        kind: 'error',
        filePath: state.filePath,
        patch: state.patch,
        error: action.error,
      };
    case 'cancel':
    case 'dismiss':
      return { kind: 'idle' };
  }
}

interface PreviewDrawerProps {
  readonly state: PreviewDrawerState;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function patchForState(state: PreviewDrawerState): string | null {
  if (state.kind === 'previewing' || state.kind === 'applying' || state.kind === 'error') {
    return state.patch;
  }
  return null;
}

export function PreviewDrawer({
  state,
  onConfirm,
  onCancel,
}: PreviewDrawerProps) {
  useEffect(() => {
    if (state.kind === 'idle') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state.kind !== 'applying') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, state.kind]);

  if (state.kind === 'idle') return null;

  const patch = patchForState(state);
  return (
    <section
      className={`cgv-preview-drawer cgv-preview-drawer--${state.kind}`}
      role="region"
      aria-label="Stage hunk preview"
    >
      <header className="cgv-preview-header">
        <strong>
          {state.kind === 'success' ? 'Hunk staged' : `Stage hunk: ${state.filePath}`}
        </strong>
        {state.kind === 'error' ? (
          <span className="cgv-preview-error">{state.error}</span>
        ) : null}
      </header>
      {patch ? <pre className="cgv-preview-patch">{patch}</pre> : null}
      <footer className="cgv-preview-actions">
        {state.kind === 'success' ? (
          <button type="button" onClick={onCancel}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onConfirm}
              disabled={state.kind === 'applying'}
              aria-label="Stage hunk"
            >
              {state.kind === 'applying' ? 'Staging...' : 'Stage'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={state.kind === 'applying'}
            >
              Cancel
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
