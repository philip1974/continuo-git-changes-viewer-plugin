# Git Viewer Panel

The panel is self-contained: no Continuo design SDK, no notification SDK, no
editor jump API. Degraded jump-back is an inline banner.

- T1: renders Changed and Untracked sections.
- T2: clicking a diff hunk line sets the jump-back banner.
- T3: too-large placeholder renders the exact git command.
