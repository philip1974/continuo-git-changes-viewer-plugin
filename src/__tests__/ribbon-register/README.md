# Ribbon Register

BDD coverage for the v0.1.7 ribbon entry.

- registers the Git Changes ribbon only when `app.dock.openPanel` exists;
- renders a lightweight inline SVG ReactNode, without adding `lucide-react`;
- clicking the ribbon opens or focuses the singleton `git-changes-viewer` panel.
