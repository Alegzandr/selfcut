# CLAUDE.md

## Working language

All generated content is written in **English**: commit messages, PR titles and
descriptions, code comments, and any review comments. Branch names too, when the
name is not pre-assigned by the harness.

The exception is anything that is a literal reference to existing content — e.g.
quoting a user-facing UI string (`"Supprimer"`) that lives in the codebase, or
copy that is intentionally localized. Those stay verbatim.

User-facing UI copy itself is localized separately via `src/i18n/locales/`.
