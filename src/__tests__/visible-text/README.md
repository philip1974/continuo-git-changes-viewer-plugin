# visible-text

Error messages and notices that carry git output or repository-controlled text
are shown only in visible form (`src/lib/visible-text.ts`).

Why: git's stderr (and values such as `core.hooksPath` or hook file names)
reach the panel's error texts verbatim — `failureDetail` (d79f8d3) puts the
first stderr line of a failed `git status` into the status alert. Such text can
carry terminal escapes, U+202E (the rest of the sentence is shown reversed) or
invisible zero-width characters.

`visibleText`: C0 / DEL / C1 controls, U+202A–202E, U+2066–2069, U+200E/F,
U+061C and zero-width characters (U+200B–200D, U+2060, U+FEFF) → `<U+XXXX>`;
runs of line breaks (`\n`, `\r\n`, `\r`, U+2028, U+2029) → one space; tab →
space; trimmed; cut at 500 code points with an ellipsis (never inside a
surrogate pair). Applied where text is shown: host notifications sent by the
panel, the commit editor, the diff view and the plugin's setup; the rendered
banner, status alert and restriction notice; the preview drawer's error line;
the diff view's failure message; the hooks prompt. File names in the file list
are not changed (existing behaviour, separate question).

- V1–V4: the helper.
- V5–V8: panel notification, banner fallback, status alert / restriction,
  drawer error (hunk and discard-file drawer).
- V9–V13: commit failure, hooks prompt, failed diff, plugin setup failure,
  failed hunk action.
