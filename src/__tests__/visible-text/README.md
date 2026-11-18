# visible-text

Error messages and notices that carry git output or repository-controlled text
are shown only in visible form (`src/lib/visible-text.ts`).

Why: git's stderr (and values such as `core.hooksPath` or hook file names)
reach the panel's error texts verbatim — `failureDetail` (d79f8d3) puts the
first stderr line of a failed `git status` into the status alert. Such text can
carry terminal escapes, U+202E (the rest of the sentence is shown reversed) or
invisible zero-width characters.

`visibleText`: every code point in `\p{Cc}`, `\p{Cf}` or
`\p{Default_Ignorable_Code_Point}` (controls, bidi controls and marks,
zero-width characters, soft hyphen, invisible operators, tag characters,
variation selectors, CGJ, …), plus the Hangul fillers U+115F, U+1160, U+3164,
U+FFA0 (already default-ignorable in Node 24 / V8; listed anyway) →
`<U+XXXX>`; runs of line breaks (`\n`, `\r\n`, `\r`, U+2028, U+2029) → one
space; tab → space; trimmed; cut at 500 code points of the original text with
an ellipsis — the cut comes before the replacement (no half-written `<U+…>`),
never inside a surrogate pair, and at a grapheme boundary (`Intl.Segmenter`)
so a base character keeps its combining marks; a single cluster longer than
the limit is cut by code points. Applied where text is shown: host notifications sent by the
panel, the commit editor, the diff view and the plugin's setup; the rendered
banner, status alert and restriction notice; the preview drawer's error line;
the diff view's failure message; the hooks prompt; the command shown in the
"Diff too large" placeholder (not cut; Copy still copies the exact command). File names in the file list
are not changed (existing behaviour, separate question).

- V1–V4: the helper. V14–V17 (reviewer, measured: these passed through
  unchanged before): other invisible code points, visible text left alone,
  cut before replace, grapheme-aware cut.
- V18: the "Diff too large" placeholder.
- V5–V8: panel notification, banner fallback, status alert / restriction,
  drawer error (hunk and discard-file drawer).
- V9–V13: commit failure, hooks prompt, failed diff, plugin setup failure,
  failed hunk action.
