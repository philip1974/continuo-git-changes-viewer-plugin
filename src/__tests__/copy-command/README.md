# Copy Command

The "Diff too large" placeholder offers the equivalent command (`git diff
[--cached] -- <path>`) with a Copy button. The path comes from an untrusted
repository and the user pastes the text into a terminal, so it must reach the
shell as exactly one argument: a file named `a;touch pwned`, `$(…)`, with
backticks or a space would otherwise run something or split into several
arguments.

`shellQuotePath` (`src/git/shell-quote.ts`):

- paths made only of `[A-Za-z0-9_./-]` are returned unchanged — ordinary
  commands look exactly as before;
- any other path is wrapped in single quotes, an embedded `'` written as
  `'\''` (POSIX: nothing is interpreted inside single quotes);
- a path containing a newline or any other control character (C0, DEL, C1) has
  no pasteable form (`null`): inside quotes the shell would take it literally,
  but the paste itself goes through the terminal — a newline submits the line,
  escape sequences may be interpreted.

Commands the plugin runs itself never go through a shell (argument arrays via
`app.shell.exec`); this is only about text handed to the user.

- Q1: ordinary paths are unchanged.
- Q2: every other path, read back by a real `/bin/sh`, is exactly one argument
  equal to the path (`;`, `$()`, backticks, quotes, globs, `~`, `#`, `!`,
  backslashes, spaces, non-ASCII).
- Q3: control characters / empty → `null`.
- Q4: the placeholder command for ordinary paths is unchanged (`git diff --
  large.txt`, `git diff --cached -- src/a.ts`).
- Q5: for hostile names, a real `/bin/sh` given the command sees `git` called
  once with `diff [--cached] -- <path>`.
- Q6: names with control characters → `exactCommand: null`.
- Q7: the Copy button writes exactly the command shown.
- Q8: with no command, the button is disabled and carries a title explaining
  why; no command text is shown and nothing is copied.

This is the only copy-to-clipboard surface in the panel. Other places that
show a path (banners, toasts, the file list) render it as text.
