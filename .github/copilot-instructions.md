# Copilot Instructions — piperun

## Build, Test, Lint

```bash
npm run build          # tsup → dist/index.js (CLI) + dist/lib.js (library)
npm test               # all tests
npm run test:unit      # unit tests only (vitest.config.unit.ts)
npm run test:integration  # integration tests (vitest.config.integration.ts)
npm run test:e2e       # e2e tests (vitest.config.e2e.ts)

# Coverage per area (each has 80%/75%/80%/80% thresholds)
npm run test:coverage:unit
npm run test:coverage:integration
npm run test:coverage:e2e

# Run a single test file
npx vitest run tests/unit/expression-engine.test.ts

# Run tests matching a name pattern
npx vitest run -t "setvariable"

npm run typecheck      # tsc --noEmit
```

The project must be built (`npm run build`) before running integration or e2e tests — they execute against `dist/index.js`.

## Architecture

Piperun is a locally executable YAML pipeline runner inspired by Azure DevOps but with its own format. It compiles YAML into an execution plan, then runs stages → jobs → steps as real child processes.

**Pipeline flow:** YAML → parser/validator → compiler (templates, expressions, parameters) → runtime (pipeline → stage → job → step runners)

### Key layers

- **`src/parser/`** — YAML loading (`js-yaml`) and Zod schema validation. All pipeline shapes validated before compilation.
- **`src/compiler/`** — Template expansion (`include`/`extends` with `${{ if }}`/`${{ each }}`), expression evaluation (recursive descent parser → AST → evaluator), parameter resolution with type coercion.
- **`src/runtime/`** — Execution orchestration. `PipelineRunner` → `StageRunner` → `JobRunner` → `StepRunner`. `DependencyGraph` does topological sort (Kahn's algorithm) for stage/job ordering. `StepRunner` spawns real child processes (`pwsh`, `node`, `python`).
- **`src/variables/`** — Scoped variable storage (pipeline → stage → job). `SecretMasker` redacts secrets from output. `OutputVariableStore` tracks `##pipeline[setvariable]` cross-step communication.
- **`src/functions/`** — 30+ expression functions (logical, comparison, string, collection, status). Each category in its own file, registered via `createFunctionRegistry()`.
- **`src/cli/`** — Commander.js commands: `run`, `validate`, `list`, `plan`, `visualize`. Param syntax: `--param.name=value`.

### Expression system — three syntaxes

- `${{ expr }}` — compile-time evaluation (templates, conditions)
- `$[ expr ]` — runtime evaluation (step display names, conditions)
- `$(varName)` — macro expansion (variable substitution in step scripts)

### Step execution model

Each step type spawns a real child process:
- `pwsh` → `pwsh -NoProfile -NonInteractive -File <temp.ps1>`
- `node` → `node <temp.mjs>` (ESM)
- `python` → `python3` (falls back to `python` on Windows)

Temp files are created in `os.tmpdir()` and cleaned up in `finally` blocks. Output is streamed via `readline` on stdout/stderr pipes. `##pipeline[...]` logging commands are parsed from stdout in real-time.

### Dependency injection pattern

Runners receive their dependencies via constructor injection — `PipelineRunner.run()` takes a `conditionEvaluator` and `stepRunnerFactory`. This makes the runtime testable without spawning processes.

## Conventions

### ESM with `.js` extensions

All imports must use `.js` extensions — this is required for ESM resolution:
```typescript
import { PipelineRunner } from '../runtime/pipeline-runner.js';
import type { StepDefinition } from '../types/pipeline.js';
```

Use `import type { }` for type-only imports.

### Error handling

Custom error classes for specific failure modes:
```typescript
export class PipelineCompilationError extends Error { ... }
export class ExpressionParseError extends Error { ... }
```

CLI commands catch errors, format with chalk, and set `process.exitCode` (the `run` command) or call `process.exit()` (other commands).

### Exit codes

- `0` — success (all stages passed)
- `1` — failure (any stage failed)
- `2` — partial (some stages passed, some failed)

### Testing structure

| Suite | Config | Coverage scope |
|-------|--------|---------------|
| Unit (`tests/unit/`) | `vitest.config.unit.ts` | `src/**` excluding `cli/`, `types/`, barrel `index.ts` |
| Integration (`tests/integration/`) | `vitest.config.integration.ts` | `src/cli/**` |
| E2E (`tests/e2e/`) | `vitest.config.e2e.ts` | `src/runtime/**` |

- **Unit tests** import source modules directly and mock dependencies with `vi.fn()`/`vi.mock()`.
- **Integration tests** have two patterns: subprocess tests (`node dist/index.js`) and source-importing tests that call CLI command functions directly for V8 coverage.
- **E2E tests** have two patterns: subprocess tests and source-importing tests that call `PipelineRunner.run()` directly.
- Vitest globals are enabled — no need to import `describe`, `it`, `expect`.
- Use `{ timeout: 30_000 }` for tests that spawn child processes.
- Fixtures live in `tests/fixtures/`.

### Logging command protocol

Steps communicate with the runner via stdout commands:
```
##pipeline[setvariable variable=name;isOutput=true;isSecret=false]value
##pipeline[logissue type=warning]This is a warning
```

Parsed by `src/logging/command-parser.ts`, handled by `src/logging/commands/index.ts`.

### Variable scoping hierarchy

`pipeline` → `stage` → `job` (each level inherits and can override). The `VariableManager` maintains a scope stack. System variables (`Pipeline.Name`, `Pipeline.RunId`, etc.) are set automatically.

### Dual build output

tsup produces two bundles:
- **CLI binary** (`dist/index.js`) — has `#!/usr/bin/env node` shebang banner, no `.d.ts`
- **Library** (`dist/lib.js`) — exports public API with `.d.ts` for programmatic use
