import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export interface FoldRange {
  readonly from: number;
  readonly to: number;
  readonly lines: number;
}

export const setFoldRanges = StateEffect.define<readonly FoldRange[]>();

class FoldWidget extends WidgetType {
  constructor(private readonly lines: number) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cgv-fold-unchanged';
    el.textContent = `${this.lines} unchanged lines`;
    return el;
  }
}

export const foldUnchangedField = StateField.define<DecorationSetLike>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFoldRanges)) {
        const decorations = effect.value.map((range) =>
          Decoration.replace({
            widget: new FoldWidget(range.lines),
            block: true,
          }).range(range.from, range.to),
        );
        return Decoration.set(decorations, true);
      }
    }
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

type DecorationSetLike = typeof Decoration.none;
