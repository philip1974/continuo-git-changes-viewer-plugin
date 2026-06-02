import { useEffect, useState } from 'react';

export type DrawerAction = 'stage' | 'unstage' | 'discard' | 'discard-file';

export type PreviewDrawerState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'previewing';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch?: string;
      readonly body?: string;
    }
  | {
      readonly kind: 'applying';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch?: string;
      readonly body?: string;
    }
  | { readonly kind: 'success'; readonly action: DrawerAction; readonly filePath: string }
  | {
      readonly kind: 'error';
      readonly action: DrawerAction;
      readonly filePath: string;
      readonly patch?: string;
      readonly body?: string;
      readonly error: string;
    };

export type PreviewDrawerAction =
  | {
      readonly type: 'open';
      readonly action?: DrawerAction;
      readonly filePath: string;
      readonly patch?: string;
      readonly body?: string;
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
        ...(action.patch !== undefined ? { patch: action.patch } : {}),
        ...(action.body !== undefined ? { body: action.body } : {}),
      };
    case 'confirm':
      if (state.kind !== 'previewing' && state.kind !== 'error') return state;
      return {
        kind: 'applying',
        action: state.action,
        filePath: state.filePath,
        ...(state.patch !== undefined ? { patch: state.patch } : {}),
        ...(state.body !== undefined ? { body: state.body } : {}),
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
        ...(state.patch !== undefined ? { patch: state.patch } : {}),
        ...(state.body !== undefined ? { body: state.body } : {}),
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
    return state.patch ?? null;
  }
  return null;
}

function bodyForState(state: PreviewDrawerState): string | null {
  if (state.kind === 'previewing' || state.kind === 'applying' || state.kind === 'error') {
    return state.body ?? null;
  }
  return null;
}

function verb(action: DrawerAction): string {
  if (action === 'stage') return 'Stage';
  if (action === 'unstage') return 'Unstage';
  if (action === 'discard-file') return 'Discard file';
  return 'Discard';
}

function pastTense(action: DrawerAction): string {
  if (action === 'stage') return 'staged';
  if (action === 'unstage') return 'unstaged';
  if (action === 'discard-file') return 'discarded';
  return 'discarded';
}

function targetNoun(action: DrawerAction): 'hunk' | 'file' {
  return action === 'discard-file' ? 'file' : 'hunk';
}

function successText(action: DrawerAction): string {
  return action === 'discard-file' ? 'File discarded' : `Hunk ${pastTense(action)}`;
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
      : `${state.kind}:${state.action}:${state.filePath}:${patchForState(state) ?? ''}:${bodyForState(state) ?? ''}`;

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
  const body = bodyForState(state);
  const verbText = verb(state.action);
  const noun = targetNoun(state.action);
  const isDiscardConfirmable =
    (state.action === 'discard' || state.action === 'discard-file')
    && (state.kind === 'previewing' || state.kind === 'error');
  const isDiscardConfirmed = isDiscardConfirmable && confirmInput === 'discard';

  if (isDiscardConfirmable) {
    const isError = state.kind === 'error';
    return (
      <section
        className="cgv-preview-drawer cgv-preview-drawer--warning"
        role="region"
        aria-label={`Discard ${noun} preview`}
      >
        <header className="cgv-preview-header">
          <strong>{`Discard ${noun}: ${state.filePath}`}</strong>
        </header>
        <div className="cgv-preview-warning">
          <strong>WARNING: This will permanently delete the unstaged change.</strong>
          <span> Use <code>git stash</code> first if uncertain.</span>
        </div>
        {isError ? <span className="cgv-preview-error">{state.error}</span> : null}
        {body ? <div className="cgv-preview-body">{body}</div> : null}
        {!body && patch ? <pre className="cgv-preview-patch">{patch}</pre> : null}
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
            aria-label={isError ? `Retry discard ${noun}` : `Discard ${noun}`}
          >
            {isError ? `Retry ${verbText}` : verbText}
          </button>
        </footer>
      </section>
    );
  }

  return (
    <section
      className={`cgv-preview-drawer cgv-preview-drawer--${state.kind}`}
      role="region"
      aria-label={`${verbText} ${noun} preview`}
    >
      <header className="cgv-preview-header">
        <strong>
          {state.kind === 'success'
            ? successText(state.action)
            : `${verbText} ${noun}: ${state.filePath}`}
        </strong>
        {state.kind === 'error' ? (
          <span className="cgv-preview-error">{state.error}</span>
        ) : null}
      </header>
      {body ? <div className="cgv-preview-body">{body}</div> : null}
      {!body && patch ? <pre className="cgv-preview-patch">{patch}</pre> : null}
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
              aria-label={`${verbText} ${noun}`}
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
