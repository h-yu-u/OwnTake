# Repository guide

OwnTake is a local, single-user AI film workbench. Read the relevant owner document before changing behavior. This file is a navigation and safety contract, not a copy of every subsystem's implementation.

## Start here

- [Documentation map](docs/README.md): current documentation versus historical design.
- [Architecture](docs/architecture.md): process boundaries and dependency direction.
- [Code standards](docs/code-standards.md): cohesion, pure policy, side effects and tests.
- [Lessons](LESSONS.md): durable rules with reasons and evidence.
- [Development](docs/development/README.md): toolchain and verification commands.

## Find the owner

| Change | Read first |
| --- | --- |
| HTTP routes, security, streaming, shutdown | [HTTP and lifecycle](docs/subsystems/http-lifecycle.md) |
| SQLite, files, migrations, backup and recovery | [Storage](docs/subsystems/storage.md) |
| Stories, scripts, shots, candidates, revisions | [Stories and storyboard](docs/subsystems/stories-storyboard.md) |
| Credentials, model discovery, requests, budget, retries | [Providers and generation](docs/subsystems/providers-generation.md) |
| FFmpeg, export, captions, speech, batches, CLI | [Media and studio](docs/subsystems/media-studio.md) |
| Vue state, navigation, shared components | [Frontend](docs/subsystems/frontend.md) |
| Electron, preload, service process, native bridge | [Desktop](docs/subsystems/desktop.md) |
| Package names, target matrix, signing, releases | [Release operations](docs/operations/release.md) |

## Non-negotiable boundaries

1. Keep one local core. Web and Electron reuse the same HTTP, storage and execution code; do not add parallel databases or services for a screen.
2. Keep domain rules independent of Fastify, Vue, Electron, filesystem and network. Pass explicit values and narrow dependencies; do not introduce global service locators.
3. Store authoritative state locally. A model response is an untrusted proposal, not a command or proof of correctness.
4. Never retry an ambiguous paid submission as a fresh request. Preserve its identity, reserved cost, frozen input and reconciliation path.
5. Do not overwrite immutable artifacts, revisions or previous outputs. Validate IDs, real paths and hashes at file boundaries.
6. Keep loopback, exact-origin, session, CSRF and renderer-isolation controls. A test-only sandbox exception is not a production default.
7. Do not introduce secrets, user data, third-party fonts or model weights into Git, logs, screenshots or release artifacts.
8. Do not copy Magpie's unrelated implementation stack. Its documentation responsibility model and platform naming are references; OwnTake remains Vue/Fastify/Electron.

## Before handing off

Run `npm run check`. For desktop, packaging or dependency changes, also run the relevant native packaged-app smoke; CI must verify all declared targets before a release. Describe tests not executed and external credentials not available. Update the owning document with the behavior change in the same PR; add a lesson only when there is a reusable failure-prevention rule.

Do not create a tag, publish a release or merge a PR unless the user requested that action. Historical phase records are evidence for their recorded revision, not current capability promises.
