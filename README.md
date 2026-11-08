# OwnTake

**Turn your ideas into your own films.**

[简体中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Development](docs/development/README.md)

OwnTake is a local, single-user AI film workbench. Organize stories and scripts, review storyboard proposals, import or generate media, arrange a timeline, and export an MP4. Vue, a local Fastify service, SQLite and FFmpeg are shared by the browser and Electron desktop interfaces.

## What is available

- A versioned story library, scripts and project provenance; editable shots and explicitly selected media candidates.
- Model connections, unified OpenAI configuration and model discovery, generation records, cost reservations and recovery of uncertain requests.
- Media import, images/video, speech and batch workflows, captions, audio tracks, deterministic export and optional local CLI draft runtimes.
- A sandboxed desktop interface with native file selection, background work, orderly shutdown and project recovery.

Model availability and capabilities depend on your configured provider. Declarations and mock tests are not guarantees of real service compatibility or visual quality. Model proposals require review. A reusable character library is **not part of the current main-branch implementation**; historical designs are not a feature checklist.

## Desktop packages

The release pipeline defines these native targets. Availability means that the corresponding files are actually present in a completed release, not merely that a workflow exists.

| System | Architecture | Installable package | Portable alternative |
| --- | --- | --- | --- |
| macOS | Apple Silicon | `owntake-darwin-arm64.dmg` | `owntake-darwin-arm64.zip` |
| macOS | Intel | `owntake-darwin-amd64.dmg` | `owntake-darwin-amd64.zip` |
| Windows | Intel/AMD 64-bit | `owntake-windows-amd64.exe` | `owntake-windows-amd64.zip` |
| Windows | ARM64 | `owntake-windows-arm64.exe` | `owntake-windows-arm64.zip` |
| Linux | Intel/AMD 64-bit | `owntake-linux-amd64.AppImage` | `owntake-linux-amd64.tar.gz` |
| Linux | ARM64 | `owntake-linux-arm64.AppImage` | `owntake-linux-arm64.tar.gz` |

Download only from this repository's Releases, verify `SHA256SUMS`, and read the release's signing disclosure. Stable filenames omit the version; the version tag and manifest identify the build. `amd64` means x64, not an AMD-only build. You do not need the JSON manifest to open the app.

FFmpeg, ffprobe, subtitle fonts and API credentials are configured separately; they are not bundled. Unsigned/ad-hoc packages are not trusted-publisher-signed or notarized. See [installation and release details](docs/operations/release.md) before installing.

## Run from source

Use **Node.js 24.12+ within 24.x**, npm, FFmpeg and ffprobe. Install a font containing the subtitles you use; FFmpeg needs libass for subtitle export.

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4317`. For the desktop interface run `npm run desktop`. Development and native packaging commands are in the [development guide](docs/development/README.md).

## Data, privacy and safety

Projects and media remain on your computer. Selected prompts/media are sent to the model service you choose; “local application” does not mean “always offline.” The service binds only to loopback and is not designed for public hosting.

On macOS, metadata defaults to `~/Library/Application Support/OwnTake/` and projects to `~/Movies/OwnTake/Projects/`. Other platforms retain the existing XDG/home-based data layout; see [configuration and backup](docs/operations/data-and-configuration.md) before moving anything. API keys are stored in a restricted local file, **not encrypted by this application**, and are excluded from project backups.

Closing the desktop window keeps the core running. Use the application quit command to stop it. Keep unknown paid requests for reconciliation instead of resubmitting them.

## Contributing

Read [AGENTS.md](AGENTS.md), [code standards](docs/code-standards.md) and the relevant [subsystem](docs/subsystems/README.md). Run `npm run check`; desktop changes also require a native packaged-app smoke. Report actual commands and limitations. Pushing a version tag publishes a Release after all native checks and remote asset verification pass. Manual workflow runs default to a draft.
