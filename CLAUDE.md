# CLAUDE.md — SpeechNote Codebase Guide

## Project Overview

SpeechNote (`obsidian-speechnote`) is an Obsidian plugin that transcribes audio files to text using multiple AI providers (OpenAI Whisper, Deepgram Nova-3). Read the current version from `manifest.json` and `package.json`.

-   **Language:** TypeScript (strict mode)
-   **Target platform:** Obsidian (desktop/mobile)
-   **Build output:** single `main.js` bundle + `styles.css`
-   **Development runtime:** Node.js 22 (22.14.0 or newer in the 22.x line); the release tooling requires this minimum. Use the version in `.nvmrc`.

---

## Quick-Start Commands

```bash
npm ci               # install the exact locked dependencies
npm run dev          # watch mode (development)
npm run build        # production build (type-check + bundle)
npm run build:css    # concatenate CSS into styles.css
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier format
npm run typecheck    # TypeScript check (no emit)
npm test             # lint + typecheck + all tests (see note below)
npm run test:unit    # unit tests only
npm run test:integration  # integration tests
npm run test:e2e     # end-to-end tests
npm run test:coverage     # generate coverage report
npm run validate     # lint + typecheck + test (full local check)
```

> **Note:** `npm test` runs `pretest` (lint + typecheck) before Jest. Use `npx jest` or `npm run test:watch` for test-only feedback during rapid iteration.

---

## Repository Structure

```
SpeechNote/
├── src/                    # TypeScript source
│   ├── main.ts             # Plugin entry point
│   ├── __tests__/          # Additional colocated tests; outside default Jest projects
│   ├── application/        # Use-case orchestration
│   ├── architecture/       # Dependency container, error boundary, plugin lifecycle
│   ├── config/             # Deepgram constants and model registry
│   ├── core/               # Transcription business logic
│   ├── domain/             # Domain models & settings schema
│   ├── infrastructure/     # External integrations (APIs, storage, logging)
│   ├── patterns/           # Shared design pattern implementations
│   ├── testing/            # Test helpers used inside src/
│   ├── types/              # Shared TypeScript types & type guards
│   ├── ui/                 # Obsidian UI components (settings, modals, etc.)
│   └── utils/              # Generic utilities
├── tests/                  # External test suites
│   ├── unit/               # Unit tests
│   ├── integration/        # Integration tests
│   ├── e2e/                # End-to-end tests (jsdom)
│   ├── performance/        # Performance tests
│   ├── settings/           # Settings-specific tests
│   ├── helpers/            # Shared test utilities & setup
│   └── mocks/              # Mock implementations (obsidian, styles, files)
├── config/                 # Static config (deepgram-models.json)
├── docs/                   # User documentation
├── scripts/                # Build & release scripts
├── styles/                 # Component-level CSS (concatenated into styles.css)
├── .github/workflows/      # CI/CD pipelines
├── manifest.json           # Obsidian plugin metadata
├── versions.json           # Version history
├── esbuild.config.mjs      # Bundle configuration
├── jest.config.js          # Test configuration
├── tsconfig.json           # TypeScript configuration
├── .releaserc.json         # Active semantic-release configuration
├── release.config.js      # Additional release configuration; keep changes consistent
└── commitlint.config.js    # Commit message rules
```

---

## Architecture

The codebase is organized into the following layers. Some core services also use Obsidian APIs and infrastructure; consult existing imports before assuming a layer is independent:

```
UI  →  Application  →  Core  →  Domain
              ↓
        Infrastructure
```

### Layers

| Layer              | Path                  | Responsibility                                                                                    |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------- |
| **Domain**         | `src/domain/`         | Settings schema (`Settings.ts`), business entities — no external deps                             |
| **Core**           | `src/core/`           | Transcription logic: `TranscriptionService`, `AudioProcessor`, `TextFormatter`                    |
| **Application**    | `src/application/`    | Use-case orchestration: `StateManager`, `EventManager`, `EditorService`, `TextInsertionHandler`   |
| **Infrastructure** | `src/infrastructure/` | External systems: API clients, `SettingsManager`, `Logger`, `MemoryCache`, audio handling         |
| **UI**             | `src/ui/`             | Obsidian components: `SettingsTab`, modals, progress indicators, formatting options               |
| **Utils**          | `src/utils/`          | Cross-cutting helpers: `ErrorHandler`, async utilities, memory management, performance monitoring |

### Key Design Patterns

-   **Factory Pattern** — `TranscriberFactory` / provider `factory/` directory for provider instantiation
-   **Adapter Pattern** — `TranscriberToWhisperAdapter` bridges provider interfaces
-   **Strategy Pattern** — Multiple transcription providers behind `ITranscriber` interface
-   **Observer / Event-Driven** — `EventManager` decouples components
-   **Dependency Injection** — `DependencyContainer` wires services
-   **Repository Pattern** — `SettingsManager` abstracts storage

### TypeScript Path Aliases

Configured in `tsconfig.json` and resolved at build time by esbuild:

```
src/*            → src/*
@core/*          → src/core/*
@infrastructure/* → src/infrastructure/*
@presentation/*  → src/presentation/*
@application/*   → src/application/*
@domain/*        → src/domain/*
@utils/*         → src/utils/*
@types/*         → src/types/*
```

`jest.config.js` also maps `@ui/*` to `src/ui/*`, but TypeScript does not define that alias. Conversely, TypeScript defines `@presentation/*`, which Jest does not map and whose directory is currently absent. Use an alias supported by both configurations, or update both when introducing one.

---

## Key Files

| File                                               | Purpose                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/main.ts`                                      | Plugin class `SpeechToTextPlugin`, service wiring, command/event registration |
| `src/domain/models/Settings.ts`                    | `SpeechToTextSettings` interface and `DEFAULT_SETTINGS`                       |
| `src/core/transcription/TranscriptionService.ts`   | Orchestrates a transcription run                                              |
| `src/core/transcription/AudioProcessor.ts`         | Audio file validation and preprocessing                                       |
| `src/core/transcription/TextFormatter.ts`          | Post-processing, speaker diarization formatting                               |
| `src/infrastructure/api/TranscriberFactory.ts`     | Instantiates the active provider                                              |
| `src/infrastructure/api/providers/ITranscriber.ts` | Provider interface contract                                                   |
| `src/infrastructure/api/providers/deepgram/`       | Deepgram Nova-3 integration                                                   |
| `src/infrastructure/api/providers/whisper/`        | OpenAI Whisper integration                                                    |
| `src/infrastructure/api/SettingsMigrator.ts`       | Migrates old settings across versions                                         |
| `src/infrastructure/storage/SettingsManager.ts`    | Loads/saves settings via Obsidian API                                         |
| `src/infrastructure/logging/Logger.ts`             | Structured logger with prefix support                                         |
| `src/infrastructure/cache/MemoryCache.ts`          | Generic in-memory cache                                                       |
| `src/ui/settings/SettingsTab.ts`                   | Main settings UI tab                                                          |
| `src/ui/formatting/FormatOptions.ts`               | `FormatOptionsModal` and `TextFormat` type                                    |
| `src/utils/ErrorHandler.ts`                        | Centralized error handling and user notices                                   |

---

## Adding a New Transcription Provider

1. Create a directory under `src/infrastructure/api/providers/<name>/`
2. Implement the `ITranscriber` interface from `providers/ITranscriber.ts`
3. Register the provider in `TranscriberFactory.ts`
4. Add provider-specific settings fields to `src/domain/models/Settings.ts` and `DEFAULT_SETTINGS`
5. Add UI controls in `src/ui/settings/provider/` following existing provider patterns
6. Write unit tests in `tests/unit/` and integration tests in `tests/integration/`

---

## Testing

### Structure

```
tests/
├── unit/         *.test.ts      — pure logic, no Obsidian API
├── integration/  *.test.ts      — provider/API integration
├── e2e/          *.e2e.test.ts  — full flows with jsdom
├── performance/                 — performance benchmarks
├── settings/                    — settings migration / validation
├── helpers/      mockDataFactory.ts, testSetup.js, e2e.setup.ts
└── mocks/        obsidian.mock.ts, styleMock.js, fileMock.js
```

### Coverage Thresholds

| Suite       | Branches | Functions | Lines |
| ----------- | -------- | --------- | ----- |
| Unit        | 50%      | 25%       | 10%   |
| Integration | 50%      | 25%       | 3%    |
| E2E         | 50%      | 25%       | 3%    |

The statement thresholds match the line thresholds. These are the values declared in each project in `jest.config.js`; check the actual coverage run before assuming enforcement. The default Jest projects discover only `tests/unit`, `tests/integration`, and `tests/e2e`. Files in `tests/performance`, `tests/settings`, and `src/__tests__` require a separate test configuration and are not included by `npm test`.

### Running Tests

```bash
npm run test:unit        # fast feedback loop
npm run test:watch       # TDD watch mode
npm run test:ci          # CI mode with coverage (maxWorkers=2)
npm run test:debug       # attach Node debugger
```

The Obsidian API is mapped to `tests/mocks/obsidian.mock.ts`. Tests may import from `obsidian`; Jest resolves that import to the mock, so no live Obsidian runtime is required.

---

## Code Style

### TypeScript

-   **Strict mode** — `noImplicitAny`, `strictNullChecks`, and `strict: true` in `tsconfig.json`
-   No `any` types — use proper generics or type assertions with justification
-   No non-null assertions (`!`) unless provably safe
-   Use type guards (`src/types/guards.ts`, `src/utils/fs/typeGuards.ts`) instead of type casting

### Formatting (Prettier)

-   Print width: **100** characters
-   Indent: **4 spaces** (tabs disabled)
-   Single quotes, trailing commas, semicolons enabled
-   Line endings: LF

### Linting (ESLint)

-   Config: `.eslintrc.json` — compatible with Obsidian plugin review bot rules
-   Run `npm run lint:fix` for auto-fixable issues
-   Zero ESLint **errors** are enforced in CI; warnings are flagged but non-blocking

### Comments

-   Prefer self-documenting code over inline comments
-   Only add comments to explain non-obvious constraints, workarounds, or subtle invariants
-   No JSDoc on obvious methods; no multi-line comment blocks

---

## Commit Conventions

**Husky** runs the formatting check in `pre-commit` and **commitlint** in `commit-msg`.

Format: `<type>(<scope>): <subject>`

**Allowed types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Rules:

-   Subject max length: 72 characters
-   Body line max length: 100 characters
-   Subject must be lowercase, no trailing period

Examples:

```
feat(transcription): add Deepgram Nova-3 speaker diarization
fix(settings): correct API key validation for empty strings
test(audio): add edge cases for unsupported file formats
```

Semantic-release maps commit types to version bumps:

-   `feat` → minor
-   `fix` → patch
-   `BREAKING CHANGE` footer → major

---

## Build System

**Tool:** esbuild, with its exact version pinned in `package.json`.

-   Config: `esbuild.config.mjs`
-   Output: single `main.js` (Obsidian plugin format)
-   Production: tree-shaking + minification. The build configuration reports aspirational targets of < 150 KB initial and < 400 KB total; CI enforces a separate 5 MB maximum.
-   Development: source maps, watch mode via `npm run dev`
-   CSS: `npm run build:css` concatenates `src/ui/styles/*.css` + `styles/*.css` → `styles.css`

The build is **not** a standard npm package — `main.js` is the direct plugin artifact loaded by Obsidian.

---

## CI/CD

### Workflows

| File                     | Trigger                                        | Purpose                                                      |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| `ci.yml`                 | push/PR to `main`/`develop`, tags `v*`         | Lint, type-check, unit+integration tests, build verification |
| `release-auto.yml`       | push to `main`                                 | semantic-release automated versioning and GitHub release     |
| `release.yml`            | version tag push or manual                     | Release artifact build and publication                       |
| `claude.yml`             | supported issue/PR events containing `@claude` | Requested AI assistance                                      |
| `claude-code-review.yml` | PR opened or synchronized                      | AI code review                                               |

### CI Requirements (blocking)

1. ESLint passes with zero errors
2. Prettier formatting check passes
3. TypeScript compiles cleanly (`typecheck`)
4. Build succeeds and bundle ≤ 5 MB
5. Quality check gate passes before tests run

Unit and integration test failures are **non-blocking** in CI (continue-on-error) but should be fixed.

### Release Process

Automated via `semantic-release` on merge to `main`:

1. Analyzes commits since last tag
2. Bumps versions in `manifest.json`, `package.json`, `package-lock.json`, `versions.json`
3. Generates release notes
4. Creates GitHub release with `main.js`, `manifest.json`, `styles.css` assets

To preview a release without publishing: `npm run release:dry-run`

---

## Environment & Secrets

Integration tests use environment variables:

-   `TEST_API_KEY` — generic test API key (GitHub secret)
-   `TEST_API_URL` — test endpoint URL (GitHub secret)

For local development, set real API keys in Obsidian plugin settings (stored via Obsidian's `loadData`/`saveData`). Never commit API keys.

---

## Obsidian Plugin Conventions

-   The plugin class `SpeechToTextPlugin` extends `Plugin` from `obsidian`
-   Service initialization order in `onload()`: Logger → Services → Commands → Context menu → Settings tab → Event handlers → Status bar
-   Always call `this.registerEvent(...)` and `this.addCommand(...)` (not bare addEventListener) so Obsidian auto-cleans on unload
-   Use `this.app.workspace.onLayoutReady(...)` for status bar items
-   Settings are loaded via `SettingsManager` which wraps `this.loadData()` / `this.saveData()`
-   `SettingsMigrator` handles version upgrades automatically on load

---

## Common Pitfalls

-   **Import paths:** Use path aliases (`@core/...`) in `src/`; Jest uses `moduleNameMapper` to resolve them — if you add a new alias, update both `tsconfig.json` `paths` and `jest.config.js` `moduleNameMapper`.
-   **CSS:** Don't edit `styles.css` directly — it is generated. Edit files under `src/ui/styles/` or `styles/` and run `npm run build:css`.
-   **Bundle size:** Avoid importing large third-party libraries; esbuild will tree-shake but heavy deps inflate the bundle.
-   **Obsidian API in tests:** The real `obsidian` package is a stub. Use `tests/mocks/obsidian.mock.ts` and extend it when new API surface is needed.
-   **Settings migration:** When adding new settings fields, add them to `DEFAULT_SETTINGS` and update `SettingsMigrator` if old installations need migration.
