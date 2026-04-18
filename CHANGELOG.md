# Changelog

## 3.0.0
- Added a full manual editing workflow, including edit/sync commands for revising chapters outside the chat.
- Added Markdown-to-DOCX and DOCX-to-Markdown conversion support so WPS, Word, and LibreOffice can be used as external editors.
- Added `editor` configuration support in `workspace.yaml` and improved install-time workspace initialization.
- Improved sync safety with better rollback handling, draft preservation, and project/reference update consistency.
- Added stronger workspace path guardrails to keep writing data out of root, system, and skill directories.

## 0.1.0
- Initial release of the `novel-writer` Claude Code plugin
- Added end-to-end fiction writing workflows for workspace setup, outlining, drafting, rewriting, editing, restore/rollback, and export preparation
- Released as a text-only plugin with no GUI components
