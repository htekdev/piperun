# piperun

A locally executable pipeline framework inspired by Azure DevOps YAML pipelines.

**Define stages, jobs, and steps in YAML — run them on your machine with `piperun run`.**

✦ Multi-language steps (pwsh · node · python) · ✦ 30 expression functions · ✦ Template system with conditionals and loops · ✦ Matrix strategy · ✦ Deployment lifecycles · ✦ Logging command protocol · ✦ Secret masking

---

## Features

- **Multi-language steps** — `pwsh`, `node`, and `python` inline scripts, plus reusable `task` references
- **Expression engine** — 30 built-in functions across logical, comparison, string, collection, and status categories
- **Three expression syntaxes** — `${{ }}` compile-time, `$[ ]` runtime, `$(var)` variable macros
- **Template system** — `include` and `extends` templates with `${{ if }}` / `${{ each }}` directives
- **Parameters** — typed pipeline parameters (`string`, `number`, `boolean`, `object`, `step`, `stepList`, `job`, `jobList`, `stage`, `stageList`) with defaults and allowed values
- **Variables** — inline, groups, templates, secrets, outputs, read-only, and system variables scoped at pipeline → stage → job
- **Conditions** — stage, job, and step-level conditions using expression functions
- **Matrix strategy** — fan-out jobs across configuration combinations with `maxParallel` control
- **Deployment jobs** — `runOnce`, `rolling`, and `canary` strategies with full lifecycle hooks (`preDeploy`, `deploy`, `routeTraffic`, `postRouteTraffic`, `on.success`, `on.failure`)
- **Dependency graph** — `dependsOn` at stage and job level, with automatic topological ordering
- **Resources** — pipeline, repository, and container resource declarations
- **Logging commands** — `##pipeline[...]` protocol with 10 built-in commands for setting variables, logging issues, uploading artifacts, and more
- **Secret masking** — automatic redaction of secret values from all output
- **Pools** — `vmImage` and `demands` for declaring execution targets
- **Validation** — Zod-powered schema validation for pipeline YAML
- **Visualization** — ASCII dependency graph rendering in the terminal
- **Dry-run mode** — compile and inspect the execution plan without executing steps
- **Security** — extends enforcement, pipeline decorators, and settable variable guards
- **Approvals** — interactive CLI prompts with configurable timeouts
- **Artifacts** — local artifact storage and hash-based caching

---

## Quick Start

### Install

```bash
npm install -g piperun
```

Or build from source:

```bash
git clone <repo-url> && cd pipeline-runner
npm install && npm run build
npm link   # makes `piperun` available globally
```

### Create a pipeline

Create a file named `pipeline.yaml`:

```yaml
name: "My First Pipeline"

steps:
  - pwsh: |
      Write-Host "Hello from PowerShell!"
    displayName: "Say Hello"

  - node: |
      console.log('Hello from Node.js!');
    displayName: "Node Hello"

  - python: |
      print("Hello from Python!")
    displayName: "Python Hello"
```

### Run it

```bash
piperun run
```

piperun finds `pipeline.yaml` in the current directory and executes each step in order.

---

## CLI Commands

All commands default to `pipeline.yaml` when no file argument is given.

### `piperun run [file] [options]`

Run a pipeline.

```bash
piperun run                                  # runs pipeline.yaml
piperun run deploy.yaml                      # runs a specific file
piperun run --stage Build                    # run only the Build stage (and its dependencies)
piperun run --job RunTests                   # run only a specific job (and its dependencies)
piperun run --dry-run                        # compile and show plan, don't execute
piperun run --verbose                        # enable verbose output
piperun run --param.environment=prod         # pass parameter values
piperun run --param.region=eastus --verbose  # combine flags and params
```

| Flag | Description |
|---|---|
| `--stage <name>` | Run only a specific stage and its dependencies |
| `--job <name>` | Run only a specific job and its dependencies |
| `--dry-run` | Compile and display the execution plan without running |
| `--verbose` | Enable verbose output |
| `--param.<name>=<value>` | Pass a parameter value (repeatable) |

### `piperun validate [file]`

Validate a pipeline YAML file against the schema.

```bash
piperun validate
piperun validate deploy.yaml
```

### `piperun list [file]`

List all stages and jobs in a pipeline as a tree.

```bash
piperun list
piperun list ci.yaml
```

### `piperun plan [file]`

Show the compiled execution plan with resolved templates, parameters, and execution order.

```bash
piperun plan
piperun plan --param.environment=staging
```

### `piperun visualize [file]`

Render the pipeline dependency graph as ASCII art in the terminal.

```bash
piperun visualize
piperun visualize deploy.yaml
```

---

## Pipeline YAML Reference

A pipeline can be written at three levels of shorthand:

```yaml
# Shortest — steps only (single implicit job and stage)
steps:
  - pwsh: echo "hello"

# Medium — jobs (single implicit stage)
jobs:
  - job: Build
    steps:
      - pwsh: echo "building"

# Full — stages, jobs, steps
stages:
  - stage: Build
    jobs:
      - job: Compile
        steps:
          - pwsh: echo "compiling"
```

### Comprehensive Example

```yaml
name: "Full Pipeline"

parameters:
  - name: environment
    type: string
    default: dev
    displayName: Target Environment
    values: [dev, staging, prod]
  - name: runTests
    type: boolean
    default: true

variables:
  buildConfig: Release

pool:
  vmImage: ubuntu-latest

stages:
  # ── Build ────────────────────────────
  - stage: Build
    displayName: Build Stage
    jobs:
      - job: Compile
        displayName: Compile Application
        pool:
          vmImage: ubuntu-latest
        steps:
          - pwsh: |
              Write-Host "Building with config: $(buildConfig)"
            displayName: "Build"

          - node: |
              const fs = require('fs');
              console.log('Post-build validation passed');
            displayName: "Validate Build"

      - job: Lint
        displayName: Lint Source
        strategy:
          matrix:
            linux:
              os: linux
            windows:
              os: windows
          maxParallel: 2
        steps:
          - pwsh: |
              Write-Host "Linting on $(os)"
            displayName: "Lint"

  # ── Test ─────────────────────────────
  - stage: Test
    displayName: Test Stage
    dependsOn: Build
    condition: eq('${{ parameters.runTests }}', 'true')
    jobs:
      - job: UnitTests
        displayName: Run Unit Tests
        steps:
          - pwsh: |
              Write-Host "Running tests..."
            displayName: "Run Tests"
            retryCountOnTaskFailure: 2
            continueOnError: false
            timeoutInMinutes: 10

          - python: |
              import json
              results = {"passed": 42, "failed": 0}
              print(json.dumps(results))
            displayName: "Parse Results"

  # ── Deploy ───────────────────────────
  - stage: Deploy
    displayName: Deploy Stage
    dependsOn: Test
    condition: and(succeeded(), eq('${{ parameters.environment }}', 'prod'))
    jobs:
      - deployment: DeployApp
        displayName: Deploy Application
        environment: production
        strategy:
          runOnce:
            preDeploy:
              steps:
                - pwsh: Write-Host "Pre-deploy checks..."
                  displayName: "Pre-deploy"
            deploy:
              steps:
                - pwsh: |
                    Write-Host "Deploying to ${{ parameters.environment }}..."
                  displayName: "Deploy"
            on:
              success:
                steps:
                  - pwsh: Write-Host "Deployment succeeded!"
                    displayName: "Notify Success"
              failure:
                steps:
                  - pwsh: Write-Host "Deployment failed!"
                    displayName: "Notify Failure"
```

### Step Types

| Type | Description | Example |
|---|---|---|
| `pwsh` | Inline PowerShell script | `pwsh: Write-Host "hello"` |
| `node` | Inline Node.js script | `node: console.log('hello')` |
| `python` | Inline Python script | `python: print("hello")` |
| `task` | Reusable task reference | `task: MyTask@1` |
| `template` | Step template include | `template: steps/build.yaml` |

### Step Properties

```yaml
- pwsh: |
    Write-Host "example"
  displayName: "Step Name"          # display name shown in output
  name: stepId                       # reference name for output variables
  condition: succeeded()             # run condition expression
  enabled: true                      # enable/disable the step
  continueOnError: false             # continue pipeline on step failure
  timeoutInMinutes: 10               # maximum step execution time
  retryCountOnTaskFailure: 2         # automatic retries on failure
  env:                               # environment variables injected into the step
    MY_VAR: my-value
  target:                            # execution target
    container: myContainer
    settableVariables:               # restrict which variables the step can set
      - allowedVar1
```

### Parameters

Parameters are typed and validated. Pass values from the CLI with `--param.name=value`.

```yaml
parameters:
  - name: version
    type: string
    default: "1.0.0"

  - name: debug
    type: boolean
    default: false

  - name: replicas
    type: number
    default: 3

  - name: env
    type: string
    displayName: "Target Environment"
    values: [dev, staging, prod]
    default: dev

  - name: extraSteps
    type: stepList
    default: []
```

Supported types: `string`, `number`, `boolean`, `object`, `step`, `stepList`, `job`, `jobList`, `stage`, `stageList`.

### Variables

Variables support two input formats and are scoped — pipeline-level variables are available everywhere, stage-level within that stage, job-level within that job.

```yaml
# Shorthand Record format — simple key-value pairs
variables:
  globalVar: "available everywhere"
  buildConfig: Release

# Explicit array format — supports readonly, secrets, groups, and templates
variables:
  - name: buildConfig
    value: Release
    readonly: true

  - group: my-variable-group        # reference a variable group

  - template: vars/common.yaml      # include variables from a template
    parameters:
      region: eastus
```

Both formats can be used at any scope (pipeline, stage, job). The shorthand Record format is convenient for simple key-value pairs; the explicit array format is required for readonly flags, variable groups, and template includes.

**System variables** are automatically available: `Pipeline.RunId`, `Pipeline.RunNumber`, `Pipeline.Name`, `Pipeline.Workspace`, `Stage.Name`, `Job.Name`, `Agent.OS`, `Agent.MachineName`, and more.

### Conditions

```yaml
stages:
  - stage: Deploy
    dependsOn: Test
    condition: succeeded()             # only run if Test succeeded

  - stage: Notify
    dependsOn: Deploy
    condition: always()                # run even if Deploy failed

jobs:
  - job: DeployProd
    condition: and(succeeded(), eq('${{ parameters.environment }}', 'prod'))

steps:
  - pwsh: echo "cleanup"
    condition: failed()                # run only when a previous step failed
```

### Matrix Strategy

Fan out jobs across configuration combinations. Each matrix entry produces a separate job instance (named `{job}_{config}`). Use `maxParallel` to limit concurrent instances.

```yaml
jobs:
  - job: CrossPlatform
    strategy:
      matrix:
        linux-node18:
          nodeVersion: "18"
          os: linux
        linux-node20:
          nodeVersion: "20"
          os: linux
        windows-node20:
          nodeVersion: "20"
          os: windows
      maxParallel: 2
    steps:
      - pwsh: |
          Write-Host "Node $env:NODEVERSION on $env:OS"
```

This creates 3 job instances: `CrossPlatform_linux-node18`, `CrossPlatform_linux-node20`, `CrossPlatform_windows-node20`. Each instance gets the matrix variables injected into its environment. With `maxParallel: 2`, at most 2 instances run concurrently.

#### Parallel strategy (count-based)

```yaml
jobs:
  - job: LoadTest
    strategy:
      parallel: 5
    steps:
      - pwsh: Write-Host "Instance $env:SYSTEM_JOBPOSITIONINPHASE of $env:SYSTEM_TOTALJOBSINPHASE"
```

Creates 5 identical instances named `LoadTest_1` through `LoadTest_5`, each with `System.JobPositionInPhase` and `System.TotalJobsInPhase` variables.

#### Dynamic matrix (from job output)

Generate matrix configurations at runtime from a previous job's output — matching Azure DevOps' `$[ dependencies... ]` pattern:

```yaml
jobs:
  - job: Discover
    steps:
      - name: scan
        pwsh: |
          $matrix = '{"svc1":{"name":"auth"},"svc2":{"name":"api"}}'
          Write-Host "##pipeline[setvariable variable=matrix;isOutput=true]$matrix"

  - job: Build
    dependsOn: Discover
    strategy:
      matrix: "$[dependencies.Discover.outputs['scan.matrix']]"
      maxParallel: 2
    steps:
      - pwsh: Write-Host "Building $env:NAME"
```

The matrix expression is resolved at runtime after the upstream job completes. The JSON output is parsed into matrix configurations and each becomes a job instance. Cross-stage dynamic matrices work via `$[stageDependencies.Stage.Job.outputs['step.var']]`.

### Deployment Strategies

```yaml
# runOnce — deploy once to all targets
strategy:
  runOnce:
    preDeploy:
      steps:
        - pwsh: echo "pre-deploy checks"
    deploy:
      steps:
        - pwsh: echo "deploying..."
    routeTraffic:
      steps:
        - pwsh: echo "routing traffic..."
    postRouteTraffic:
      steps:
        - pwsh: echo "post-route validation"
    on:
      success:
        steps:
          - pwsh: echo "deploy succeeded!"
      failure:
        steps:
          - pwsh: echo "deploy failed!"
```

```yaml
# rolling — deploy in batches
strategy:
  rolling:
    maxParallel: 2
    deploy:
      steps:
        - pwsh: echo "rolling deploy..."
```

```yaml
# canary — incremental rollout
strategy:
  canary:
    increments: [10, 25, 50, 100]
    deploy:
      steps:
        - pwsh: echo "canary deploy..."
```

All three strategies support the full lifecycle: `preDeploy` → `deploy` → `routeTraffic` → `postRouteTraffic` → `on.success` / `on.failure`.

### Resources

```yaml
resources:
  repositories:
    - repository: common
      type: git
      name: org/common-templates
      ref: refs/heads/main

  containers:
    - container: build-env
      image: node:20-alpine
      ports: ["8080:80"]
      volumes: ["./src:/app/src"]

  pipelines:
    - pipeline: upstream
      source: path/to/other-pipeline.yaml
```

---

## Expression Functions

All 30 built-in functions, organized by category. Function names are **case-insensitive**.

### Logical

| Function | Signature | Description |
|---|---|---|
| `and` | `and(a, b, ...)` | `true` if all arguments are truthy |
| `or` | `or(a, b, ...)` | `true` if any argument is truthy |
| `not` | `not(a)` | Negates truthiness |
| `xor` | `xor(a, b)` | `true` if exactly one argument is truthy |
| `iif` | `iif(cond, trueVal, falseVal)` | Returns `trueVal` if `cond` is truthy, else `falseVal` |

### Comparison

| Function | Signature | Description |
|---|---|---|
| `eq` | `eq(a, b)` | Equal (case-insensitive strings, numeric coercion) |
| `ne` | `ne(a, b)` | Not equal |
| `gt` | `gt(a, b)` | Greater than |
| `lt` | `lt(a, b)` | Less than |
| `ge` | `ge(a, b)` | Greater than or equal |
| `le` | `le(a, b)` | Less than or equal |
| `in` | `in(needle, a, b, ...)` | `true` if needle equals any subsequent argument |
| `notin` | `notin(needle, a, b, ...)` | `true` if needle doesn't equal any subsequent argument |

### String

| Function | Signature | Description |
|---|---|---|
| `contains` | `contains(haystack, needle)` | Case-insensitive substring check |
| `startsWith` | `startsWith(str, prefix)` | Case-insensitive prefix check |
| `endsWith` | `endsWith(str, suffix)` | Case-insensitive suffix check |
| `format` | `format(fmt, arg0, arg1, ...)` | Format string with `{0}`, `{1}` placeholders; supports date format specs (`yyyyMMdd`) |
| `join` | `join(separator, collection)` | Join array elements with separator |
| `split` | `split(str, delimiter)` | Split string into array |
| `replace` | `replace(str, old, new)` | Replace all occurrences of `old` with `new` |
| `upper` | `upper(str)` | Convert to uppercase |
| `lower` | `lower(str)` | Convert to lowercase |
| `trim` | `trim(str)` | Trim leading and trailing whitespace |

### Collection

| Function | Signature | Description |
|---|---|---|
| `containsValue` | `containsValue(collection, value)` | Check if array or object values contain a value |
| `length` | `length(value)` | Length of string, array, or object key count |
| `convertToJson` | `convertToJson(value)` | Serialize any value to a JSON string |
| `counter` | `counter(prefix, seed)` | Auto-incrementing counter, persisted per prefix |
| `coalesce` | `coalesce(a, b, ...)` | Return first non-null, non-empty argument |

### Status

| Function | Signature | Description |
|---|---|---|
| `succeeded` | `succeeded()` or `succeeded('JobA', 'JobB')` | `true` if all dependencies (or named jobs) succeeded |
| `failed` | `failed()` or `failed('JobA')` | `true` if any dependency (or named job) failed |
| `succeededOrFailed` | `succeededOrFailed()` | `true` if all dependencies reached a terminal state |
| `always` | `always()` | Always `true` — run even when canceled or failed |
| `canceled` | `canceled()` | `true` if the pipeline run was canceled |

---

## Expression Syntax

piperun supports three expression syntaxes, each evaluated at a different phase:

### `${{ }}` — Compile-time expressions

Evaluated when the YAML is parsed, **before** execution begins. Used for template directives and parameter expansion.

```yaml
steps:
  - pwsh: echo "Deploying to ${{ parameters.environment }}"

  - ${{ if eq(parameters.runTests, true) }}:
    - pwsh: echo "Running tests"

  - ${{ each region in parameters.regions }}:
    - pwsh: echo "Deploy to ${{ region }}"
```

### `$[ ]` — Runtime expressions

Evaluated at runtime, just before a stage, job, or step runs. Has access to dependency outputs and runtime state.

```yaml
- stage: Deploy
  condition: $[ and(succeeded(), eq(variables.deploy, 'true')) ]

- job: PostDeploy
  condition: $[ succeeded('DeployJob') ]
```

### `$(variable)` — Variable macros

Simple variable substitution, replaced inline just before a step executes.

```yaml
steps:
  - pwsh: |
      Write-Host "Config: $(buildConfig)"
      Write-Host "Run: $(Pipeline.RunNumber)"
      Write-Host "OS: $(Agent.OS)"
```

### Context Namespaces

| Namespace | Description | Example |
|---|---|---|
| `variables.*` | Pipeline, stage, and job variables | `variables.buildConfig` |
| `parameters.*` | Pipeline parameters | `parameters.environment` |
| `dependencies.*` | Outputs from dependency jobs (same stage) | `dependencies.Build.outputs['step.var']` |
| `stageDependencies.*` | Outputs from dependency stages | `stageDependencies.Build.Job.outputs['step.var']` |
| `pipeline.*` | System variables | `pipeline.RunId`, `pipeline.Name` |

### Output Variables Between Jobs and Stages

Steps communicate output variables via `##pipeline[setvariable]` logging commands. Output variables can be passed between jobs and stages using runtime expressions in the `variables:` section.

#### Same Job — Step to Step

```yaml
steps:
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=myVar]hello"
    name: setter
  - pwsh: |
      Write-Host "Value: $env:MYVAR"
```

#### Cross-Job — Explicit Mapping (ADO-style)

```yaml
jobs:
  - job: Producer
    steps:
      - pwsh: |
          Write-Host "##pipeline[setvariable variable=ver;isOutput=true]v2.0"
        name: buildStep
  - job: Consumer
    dependsOn: Producer
    variables:
      myVersion: "$[dependencies.Producer.outputs['buildStep.ver']]"
    steps:
      - pwsh: Write-Host "Version $env:MYVERSION"
```

#### Cross-Stage — Explicit Mapping

```yaml
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: |
              Write-Host "##pipeline[setvariable variable=tag;isOutput=true]v1.0"
            name: tagStep
  - stage: Deploy
    dependsOn: Build
    variables:
      deployTag: "$[stageDependencies.Build.BuildJob.outputs['tagStep.tag']]"
    jobs:
      - job: DeployJob
        steps:
          - pwsh: Write-Host "Deploying $env:DEPLOYTAG"
```

> **Piperun convenience:** Upstream output variables are also auto-injected into downstream jobs/stages as environment variables, so explicit mapping is optional for simple cases.

---

## Template System

### Include Templates

Import steps, jobs, or stages from another YAML file. Templates accept parameters.

**Step template:**

```yaml
# templates/build-steps.yaml
parameters:
  - name: config
    type: string
    default: Release

steps:
  - pwsh: |
      Write-Host "Building with ${{ parameters.config }}"
    displayName: "Build"
```

```yaml
# pipeline.yaml
stages:
  - stage: Build
    jobs:
      - job: Compile
        steps:
          - template: templates/build-steps.yaml
            parameters:
              config: Debug
```

**Job template:**

```yaml
jobs:
  - template: templates/test-job.yaml
    parameters:
      framework: net8.0
```

**Stage template:**

```yaml
stages:
  - template: templates/deploy-stage.yaml
    parameters:
      environment: prod
```

### Extends Templates

Use `extends` to wrap your pipeline in an organizational template that enforces structure:

```yaml
# pipeline.yaml
extends:
  template: templates/base-pipeline.yaml
  parameters:
    buildSteps:
      - pwsh: echo "building"
```

```yaml
# templates/base-pipeline.yaml
parameters:
  - name: buildSteps
    type: stepList

stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps: ${{ parameters.buildSteps }}

  - stage: SecurityScan
    dependsOn: Build
    jobs:
      - job: Scan
        steps:
          - pwsh: echo "Running required security scan"
```

### `${{ if }}` — Conditional Insertion

Conditionally include YAML blocks at compile time:

```yaml
steps:
  - ${{ if eq(parameters.environment, 'prod') }}:
    - pwsh: echo "Production deploy"
  - ${{ elseif eq(parameters.environment, 'staging') }}:
    - pwsh: echo "Staging deploy"
  - ${{ else }}:
    - pwsh: echo "Dev deploy"
```

### `${{ each }}` — Iteration

Loop over a collection to generate repeated YAML blocks:

```yaml
parameters:
  - name: regions
    type: object
    default:
      - eastus
      - westus
      - westeurope

steps:
  - ${{ each region in parameters.regions }}:
    - pwsh: echo "Deploying to ${{ region }}"
      displayName: "Deploy ${{ region }}"
```

---

## Directory Conventions

### Project-level: `.pipeline/`

Place a `.pipeline/` directory in your project root for local configuration:

```
.pipeline/
├── groups/              # Variable group YAML files
│   └── my-vars.yaml
├── connections/         # Service connection definitions
│   └── docker.yaml
├── decorators/          # Step decorators (pre/post injection)
│   └── audit.yaml
└── tasks/               # Local task definitions
    └── MyTask/
        ├── task.json
        └── index.js
```

### User-level: `~/.piperun/`

Global configuration shared across all projects:

```
~/.piperun/
├── config.yaml          # Global settings
├── groups/              # Shared variable groups
├── connections/         # Shared service connections
├── tasks/               # Globally installed tasks
├── cache/               # Hash-based artifact cache
└── artifacts/           # Local artifact storage
```

Project-level configuration in `.pipeline/` overrides user-level configuration in `~/.piperun/` when both exist.

---

## Logging Commands

Steps communicate with the piperun runtime by writing specially formatted lines to stdout. The protocol uses the `##pipeline[...]` prefix.

**Syntax:** `##pipeline[command key=value;key=value]message`

| Command | Syntax | Description |
|---|---|---|
| `setvariable` | `##pipeline[setvariable variable=name;isOutput=true;isSecret=false]value` | Set a variable. Use `isOutput=true` to share across jobs, `isSecret=true` to mask the value in logs. |
| `logissue` | `##pipeline[logissue type=warning]message` | Log a warning (`type=warning`) or error (`type=error`). |
| `complete` | `##pipeline[complete result=Succeeded]message` | Set step completion result (`Succeeded`, `SucceededWithIssues`, `Failed`). |
| `setprogress` | `##pipeline[setprogress value=50]Halfway done` | Report progress percentage (0–100) with description. |
| `addbuildtag` | `##pipeline[addbuildtag]my-tag` | Add a tag to the current pipeline run. |
| `updatebuildnumber` | `##pipeline[updatebuildnumber]1.2.3` | Override the run number. |
| `prependpath` | `##pipeline[prependpath]/usr/local/bin` | Prepend a directory to the `PATH` environment variable. |
| `uploadfile` | `##pipeline[uploadfile]/path/to/artifact` | Register a file for artifact collection. |
| `uploadsummary` | `##pipeline[uploadsummary]/path/to/summary.md` | Attach a markdown summary file to the run. |
| `logdetail` | `##pipeline[logdetail id=guid;parentId=guid;type=build]message` | Create a detailed timeline log entry with hierarchy. |

### Example: Setting an Output Variable

```yaml
steps:
  - pwsh: |
      $version = "2.1.0"
      Write-Host "##pipeline[setvariable variable=appVersion;isOutput=true]$version"
    name: getVersion
    displayName: "Determine Version"

  - pwsh: |
      Write-Host "Deploying version $(getVersion.appVersion)"
    displayName: "Use Version"
```

### Example: Error Logging

```yaml
steps:
  - pwsh: |
      if (-not (Test-Path ./build)) {
        Write-Host "##pipeline[logissue type=error]Build output directory not found"
        Write-Host "##pipeline[complete result=Failed]Missing build artifacts"
      }
    displayName: "Verify Build"
```

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | **Success** — all stages, jobs, and steps completed successfully |
| `1` | **Failure** — one or more steps failed |
| `2` | **Partial** — some steps succeeded, some failed (when `continueOnError` is used) |

---

## Development

```bash
npm install            # install dependencies
npm run build          # build with tsup
npm run dev            # watch mode
npm run test           # run tests with vitest
npm run test:watch     # watch mode tests
npm run test:coverage  # coverage report
npm run lint           # eslint
npm run typecheck      # typescript type checking
```

---

## License

MIT
