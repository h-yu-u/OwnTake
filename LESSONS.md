# Lessons

Durable failure-prevention rules, not a chronological activity log. Each entry explains a rule, why it exists and where to verify it. Implementation owners remain in [subsystems](docs/subsystems/README.md).

## A closed connection is not completed application work

**Rule:** Drain in-flight application handlers before closing SQLite; cancel and await owned uploads and workers before releasing the data-directory lock.

**Why:** A client can disappear while a handler is still committing results. Socket shutdown alone can turn a valid result into a write against a closed database.

**Evidence:** [HTTP lifecycle](docs/subsystems/http-lifecycle.md), [handler tracking](apps/server/src/http/plugins/lifecycle.ts), [core ownership](apps/server/src/bootstrap/core.ts).

## An unknown paid POST is not a retryable download

**Rule:** Preserve `submission_unknown`; reconcile the original request rather than submitting another one. Resume downloading an already-created result independently.

**Why:** A timeout can occur after the supplier has accepted and charged the request. Retrying changes the financial and creative operation.

**Evidence:** [generation state](apps/server/src/generation-runner.ts), [provider requests](packages/providers/src/generation-http.ts), [provider owner](docs/subsystems/providers-generation.md).

## A reference is an identity, not an arbitrary path

**Rule:** Resolve registered artifact IDs under their owning project, check canonical paths and expected content, and never silently replace a missing asset with a new generation.

**Why:** Relative paths, symlinks and edited files can break project isolation and reproducibility.

**Evidence:** [asset boundary](apps/server/src/assets.ts), [storage paths](packages/storage/src/paths.ts), [storage tests](tests/storage.test.ts).

## A database snapshot is not a full project backup

**Rule:** Label migration snapshots as database-only. Full backup and restore must include referenced media, verify checksums and refuse nonempty restore destinations.

**Why:** A database may restore successfully while the actual video/audio files are missing. Credentials require separate handling.

**Evidence:** [migration snapshots](packages/storage/src/migration-backup.ts), [backup implementation](packages/storage/src/backup.ts), [operations](docs/operations/data-and-configuration.md).

## Building source is not testing the distributed application

**Rule:** Extract the actual archive, inspect the executable's architecture and launch that executable. Do not let repository `node_modules` hide missing packaged dependencies.

**Why:** ESM/CommonJS loading, embedded Node, archive paths and architecture mismatches may fail only after packaging.

**Evidence:** [service bundle smoke](scripts/smoke-service.mjs), [package smoke](scripts/release/smoke.mjs), [integrity tests](scripts/release/release.test.mjs).

## Environment setup has an order

**Rule:** Install operating-system tools first; then establish and verify the required Node major and architecture. Reuse only an Electron distribution whose version and binary architecture were checked.

**Why:** A package manager may change PATH or install another Node. Downloading the same Electron archive again creates an unnecessary failure point.

**Evidence:** [native package workflow](.github/workflows/desktop-packages.yml), [release tooling](scripts/release/package.mjs), [development guide](docs/development/README.md).

## A filename is a public contract

**Rule:** Generate the build matrix, expected filenames and release completeness checks from one target registry. Use `amd64` publicly and translate to Electron's `x64` internally.

**Why:** Manually duplicated names drift; a successful upload does not prove every OS/architecture is present or came from the same source revision.

**Evidence:** [target registry](scripts/release/targets.mjs), [release assembly](scripts/release/assemble.mjs), [release operations](docs/operations/release.md).

## Claims must follow evidence, not a phase plan

**Rule:** State which commit, platform and artifact were tested. Do not present a historical plan, a passing mock, an unsigned installer or a capability declaration as proof of current implementation, real service compatibility or trusted signing.

**Why:** Those are different promises with different acceptance conditions.

**Evidence:** [documentation map](docs/README.md), [history](docs/history/README.md), [release validation boundaries](docs/operations/release.md).

## Executable scripts need their own parse gate

**Rule:** Parse every JavaScript build, release and smoke entry point before expensive native jobs. Do not assume the application's TypeScript check covers `.mjs` files.

**Why:** A missing closing brace in the desktop smoke entry point passed application checks and then failed every operating-system job before any runtime assertion executed.

**Evidence:** [script syntax gate](scripts/check-scripts.mjs), [desktop smoke](scripts/smoke-desktop.mjs), [development guide](docs/development/README.md).

## An empty secret is not an absent environment variable

**Rule:** Normalize blank signing inputs at the packaging boundary before loading tools that read `process.env`; use that same environment to derive signing claims and reject partial credentials.

**Why:** GitHub maps missing secrets to empty strings, while electron-builder treats a defined empty certificate path as the working directory. Unsigned/ad-hoc CI builds must not accidentally attempt a certificate import.

**Evidence:** [signing policy](scripts/release/config.mjs), [packaging boundary](scripts/release/package.mjs), [release regression tests](scripts/release/release.test.mjs).
