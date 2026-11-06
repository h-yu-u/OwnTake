# OwnTake engineering conventions

- Read `docs/architecture.md` and the current phase before changing behavior.
- Keep domain validation and transitions pure. Put network, filesystem, database and subprocess effects at explicit boundaries.
- Keep Vue views, API clients, application use cases, adapters and persistence separate. Prefer focused files and reusable components.
- Validate runtime inputs, not just TypeScript types. All mutating local HTTP endpoints require session and CSRF verification.
- Preserve immutable artifacts, frozen timeline inputs and explicit candidate selection. Never overwrite an existing media version.
- A lost provider response is not evidence that a paid request failed. Submission POST retries require a documented upstream idempotency guarantee.
- Tests must cover actual risks: persistence/recovery, deduplication, version conflicts, local paths, media validity and provider contract failures.
- Never add keys, provider credentials, private source media, local databases, node_modules or generated binaries to the repository.
- Record the checks actually run and their limitations. Do not label fixtures as real supplier verification or Linux checks as macOS acceptance.
- Keep phase documentation and implementation status aligned. External credentials and environment prerequisites remain visible in acceptance records.
