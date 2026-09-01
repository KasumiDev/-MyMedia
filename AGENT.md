# Working guidance

- Read `PLAN.md` before changing scope. Implement only the phase the user asks for.
- Prefer TypeScript, npm, WXT, and Vue for this project. WXT owns the extension manifest and build entrypoints.
- Use subagents for independent, bounded research or verification when doing so speeds up a task; do not delegate overlapping edits in this shared workspace.
- Never start a development server. Ask the user to start one when it is needed for manual testing.
- Do not make authenticated Fansly requests. The user performs live testing in their own browser session.
- Treat HAR files and all Fansly session data as sensitive. Do not copy, commit, log, display, or persist credentials, cookies, account tokens, or signed-URL query strings.
- Keep extension permissions narrow and preserve existing user changes.
