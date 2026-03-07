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

### Coverage architecture

Each test area has its own Vitest config with specific source coverage scope:

| Config | Tests | Coverage scope | Thresholds |
|--------|-------|---------------|------------|
| `vitest.config.unit.ts` | `tests/unit/**` | `src/**` excluding `cli/`, `types/`, barrel `index.ts` | 80/75/80/80 |
| `vitest.config.integration.ts` | `tests/integration/**` | `src/cli/**` | 80/75/80/80 |
| `vitest.config.e2e.ts` | `tests/e2e/**` | `src/runtime/**` | 80/75/80/80 |

**Do NOT use `vitest.workspace.ts` or `defineWorkspace`** — these are deprecated in Vitest 4.x. Use separate config files with `-c` flag instead.

**V8 coverage only instruments directly-imported source code.** Tests that spawn `node dist/index.js` as a subprocess do NOT contribute to V8 coverage. To get coverage credit, tests must import source modules directly (e.g., `import { runCommand } from '../../src/cli/commands/run.js'`). Both integration and E2E suites have two patterns: subprocess tests (for realistic end-to-end validation) and source-importing tests (for V8 coverage).

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
- `$[ expr ]` — runtime evaluation (step display names, conditions, variables section mappings)
- `$(varName)` — macro expansion (variable substitution in step scripts)

Runtime expressions support nested bracket access (e.g. `$[dependencies.Job.outputs['step.var']]`) via balanced bracket matching in `findRuntimeExpressions()` — NOT regex.

### Step execution model

Each step type spawns a real child process:
- `pwsh` → `pwsh -NoProfile -NonInteractive -File <temp.ps1>`
- `node` → `node <temp.mjs>` (ESM)
- `python` → `python3` (falls back to `python` on Windows)

Temp files are created in `os.tmpdir()` and cleaned up in `finally` blocks. Output is streamed via `readline` on stdout/stderr pipes. `##pipeline[...]` logging commands are parsed from stdout in real-time.

### Matrix / parallel strategy

`StrategyRunner` (src/runtime/strategy-runner.ts) expands matrix/parallel strategies into job instances. Integration is in `StageRunner.runSingleJob()` — when a `RegularJobDefinition` has a `strategy`, it delegates to `runStrategyJob()` which:
1. Calls `expandStrategy()` to create instances (named `{job}_{config}`)
2. Merges instance variables into the job's variable definitions
3. Runs instances via `runInstances()` with `maxParallel` throttling
4. Aggregates results into a single parent `JobRunResult`

Matrix values in YAML use `z.coerce.string()` in the schema to handle booleans/numbers. Variables are accessible in steps via environment variables (e.g., `$env:NODEVERSION` in PowerShell).

**Concurrent instance isolation:** Each matrix instance gets a forked `VariableManager` (via `VariableManager.fork()`) to prevent scope stack corruption from interleaved `enterScope()`/`exitScope()` calls during parallel execution.

**Dynamic matrix:** The `matrix` field can be a runtime expression string (e.g., `$[dependencies.Job.outputs['step.matrix']]`) that resolves to JSON. `resolveDynamicMatrix()` evaluates the expression, parses the JSON, validates the structure, and guards against prototype pollution (`__proto__`, `constructor`, `prototype` keys are rejected).

### Variables format

`VariablesInput` (src/types/pipeline.ts) accepts both formats:
- **Shorthand Record:** `variables: { key: value }` — simple key-value pairs
- **Explicit array:** `variables: [{ name, value, readonly }]` — full VariableDefinition objects

Both are handled polymorphically by `VariableManager.loadVariables()`. The `mergeInstanceVariables()` method in stage-runner also handles both formats when merging matrix instance vars into existing job variables.

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

### Testing patterns

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

### Output variable propagation

Output variables (`isOutput=true`) propagate between jobs and stages:
- **Cross-job:** Consumer maps via `variables:` section with `$[dependencies.JobName.outputs['stepName.varName']]`
- **Cross-stage:** Consumer maps via `variables:` section with `$[stageDependencies.StageName.JobName.outputs['stepName.varName']]`
- **Auto-inject (piperun convenience):** Upstream outputs are automatically injected into downstream job/stage scopes as env vars

Resolution happens in `job-runner.ts` and `stage-runner.ts` after loading variables, using `VariableManager.resolveRuntimeExpressions()` with the expression engine's `evaluateRuntime()`.

### Variable scoping hierarchy

`pipeline` → `stage` → `job` (each level inherits and can override). The `VariableManager` maintains a scope stack. System variables (`Pipeline.Name`, `Pipeline.RunId`, etc.) are set automatically.

### Dual build output

tsup produces two bundles:
- **CLI binary** (`dist/index.js`) — has `#!/usr/bin/env node` shebang banner, no `.d.ts`
- **Library** (`dist/lib.js`) — exports public API with `.d.ts` for programmatic use

### Zod v4 (not v3)

This project uses **Zod v4** (`zod@4.3.6`). Key API differences from v3:
- `z.record(keySchema, valueSchema)` takes **2 arguments** (not 1)
- Import from `'zod'` not `'zod/v4'`

### Commander.js `--param.*` pattern

The CLI supports `--param.name=value` for pipeline parameters. Commander.js requires **both** `allowUnknownOption(true)` AND `allowExcessArguments(true)` on any command that accepts `--param.*` — without both, Commander rejects the dotted flags as unrecognized options or excess positional arguments.

### Git commands and hookflow

This repo uses hookflow for agent governance. **Each git command must be a separate tool call** — do not chain `git add && git commit` in a single shell invocation. Hookflow validates each git operation individually.
