# Jump Back Real Editor

BDD coverage for v0.1.5 jump-back from unified diff line numbers to
Continuo's `app.editor.openFile(path, { line })` SDK.

The specs pin:

- runtime feature detection when `app.editor.openFile` is absent;
- absolute path construction from `repoRoot + change.path`;
- no banner on successful CodeMirror jumps;
- precise fallback banners for editor success reasons and failure codes.

