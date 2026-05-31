import { useEffect, useRef } from 'react';
import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { foldUnchangedField } from './fold-unchanged';

export interface CodeMirrorMergeViewProps {
  readonly original: string;
  readonly modified: string;
}

export function CodeMirrorMergeView({
  original,
  modified,
}: CodeMirrorMergeViewProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const view = new MergeView({
      a: {
        doc: original,
        extensions: [
          lineNumbers(),
          foldUnchangedField,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
        ],
      },
      b: {
        doc: modified,
        extensions: [
          lineNumbers(),
          foldUnchangedField,
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
        ],
      },
      parent: ref.current,
      highlightChanges: true,
      gutter: true,
      revertControls: 'a-to-b',
    });
    return () => view.destroy();
  }, [original, modified]);

  return <div className="cgv-merge-view" ref={ref} />;
}
