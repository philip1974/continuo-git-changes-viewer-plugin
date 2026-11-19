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
- a path containing a backslash is written differently: every `\` and `'`
  goes outside the quotes, escaped with one backslash (`\\`, `\'`), and the
  runs between them are single-quoted (`a\b` → `'a'\\'b'`). In fish, `\'`
  and `\\` are escapes even inside single quotes, so the POSIX-only form of
  a file named `\';touch PWNED;#` closed the quote early and ran the rest.
  The portable form reads the same in sh, bash, zsh and fish, and never has
  `''` inside a quoted run (zsh `RC_QUOTES`). Same scheme as the host's
  terminal drop quoting;
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
- Q9: backslash paths (`\';touch PWNED;#`, trailing `\`, `\\'…`) parse to
  exactly one argument under fish's quoting rules (a parser written from the
  fish documentation; a real `fish` is also used when installed), where the
  previous form is shown to leave `;` unquoted.
- Q10: every test path read back by real `sh`, `bash` (also `-H`), `zsh`
  (also `RC_QUOTES`, `BANG_HIST`), `dash`, `ksh` — whichever exist; `sh` and
  `zsh` are required.
- Q11: paths without a backslash keep their previous output.
- Q4: the placeholder command for ordinary paths is unchanged (`git diff --
  large.txt`, `git diff --cached -- src/a.ts`).
- Q5: for hostile names, a real `/bin/sh` given the command sees `git` called
  once with `diff [--cached] -- <path>`.
- Q6: names with control characters → `exactCommand: null`.
- Q7: the Copy button writes exactly the command shown; its title says the
  command is quoted for POSIX-style shells, not PowerShell / cmd.
- Q8: with no command, the button is disabled and carries a title explaining
  why; no command text is shown and nothing is copied.
- Q12: the clipboard refuses the write (window not focused, permission
  denied) → an error "Could not copy the command: <reason>"; no unhandled
  rejection (before: nothing was shown).
- Q13: no clipboard API at all → the same error ("clipboard unavailable"),
  as a banner when the host has no notifications (before: a silent no-op).

This is the only copy-to-clipboard surface in the panel. Other places that
show a path (banners, toasts, the file list) render it as text.

Scope: the quoting targets POSIX-style shells (sh, bash, zsh, fish). Windows
shells (PowerShell, cmd) have different rules and are not covered; the Copy
button's title says so.
