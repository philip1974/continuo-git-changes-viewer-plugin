import { useEffect, useState } from 'react';

export type DrawerAction = 'stage' | 'unstage' | 'discard';

export type PreviewDrawerState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'previewing';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch: string;
    }
  | {
      readonly kind: 'applying';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch: string;
    }
  | { readonly kind: 'success'; readonly action: DrawerAction; readonly filePath: string }
  | {
      readonly kind: 'error';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch: string;
      readonly error: string;
    };

export type PreviewDrawerAction =
  | {
      readonly type: 'open';
      readonly action?: DrawerAction;
      readonly filePath: string;
      readonly patch: string;
    }
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
        action: action.action ?? 'stage',
        filePath: action.filePath,
        patch: action.patch,
      };
    case 'confirm':
      if (state.kind !== 'previewing' && state.kind !== 'error') return state;
      return {
        kind: 'applying',
        action: state.action,
        filePath: state.filePath,
        patch: state.patch,
      };
    case 'succeed':
      if (state.kind !== 'applying') return state;
      return { kind: 'success', action: state.action, filePath: state.filePath };
    case 'fail':
      if (state.kind !== 'applying') return state;
      return {
        kind: 'error',
        action: state.action,
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

function verb(action: DrawerAction): string {
  if (action === 'stage') return 'Stage';
  if (action === 'unstage') return 'Unstage';
  return 'Discard';
}

function pastTense(action: DrawerAction): string {
  if (action === 'stage') return 'staged';
  if (action === 'unstage') return 'unstaged';
  return 'discarded';
}

export function PreviewDrawer({
  state,
  onConfirm,
  onCancel,
}: PreviewDrawerProps) {
  const [confirmInput, setConfirmInput] = useState('');

  const targetKey =
    state.kind === 'idle'
      ? 'idle'
      : `${state.kind}:${state.action}:${state.filePath}:${patchForState(state) ?? ''}`;

  useEffect(() => {
    setConfirmInput('');
  }, [targetKey]);

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
  const verbText = verb(state.action);
  const isDiscardConfirmable =
    state.action === 'discard' && (state.kind === 'previewing' || state.kind === 'error');
  const isDiscardConfirmed = isDiscardConfirmable && confirmInput === 'discard';

  if (isDiscardConfirmable) {
    const isError = state.kind === 'error';
    return (
      <section
        className="cgv-preview-drawer cgv-preview-drawer--warning"
        role="region"
        aria-label="Discard hunk preview"
      >
        <header className="cgv-preview-header">
          <strong>{`Discard hunk: ${state.filePath}`}</strong>
        </header>
        <div className="cgv-preview-warning">
          <strong>WARNING: This will permanently delete the unstaged change.</strong>
          <span> Use <code>git stash</code> first if uncertain.</span>
        </div>
        {isError ? <span className="cgv-preview-error">{state.error}</span> : null}
        {patch ? <pre className="cgv-preview-patch">{patch}</pre> : null}
        <div className="cgv-confirm-row">
          <label htmlFor="cgv-discard-confirm">Type "discard" to confirm:</label>
          <input
            id="cgv-discard-confirm"
            className="cgv-confirm-input"
            value={confirmInput}
            onChange={(event) => setConfirmInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isDiscardConfirmed) event.preventDefault();
            }}
            autoFocus
            spellCheck={false}
          />
        </div>
        <footer className="cgv-preview-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="cgv-discard-btn"
            onClick={onConfirm}
            disabled={!isDiscardConfirmed}
            aria-label={isError ? 'Retry discard hunk' : 'Discard hunk'}
          >
            {isError ? 'Retry Discard' : 'Discard'}
          </button>
        </footer>
      </section>
    );
  }

  return (
    <section
      className={`cgv-preview-drawer cgv-preview-drawer--${state.kind}`}
      role="region"
      aria-label={`${verbText} hunk preview`}
    >
      <header className="cgv-preview-header">
        <strong>
          {state.kind === 'success'
            ? `Hunk ${pastTense(state.action)}`
            : `${verbText} hunk: ${state.filePath}`}
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
              aria-label={`${verbText} hunk`}
            >
              {state.kind === 'applying' ? `${verbText}...` : verbText}
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
