# piperun examples

A collection of example pipelines demonstrating piperun features. Run any example:

```bash
piperun run examples/<file>.yaml --verbose
```

| Example | Features |
|---------|----------|
| `01-hello-world.yaml` | Minimal pipeline, single step |
| `02-multi-language.yaml` | pwsh, node, and python steps |
| `03-multi-stage.yaml` | Stages with dependencies |
| `04-parameters.yaml` | Typed parameters with CLI overrides |
| `05-variables.yaml` | Inline, scoped, and output variables |
| `06-conditions.yaml` | Conditional execution with expressions |
| `07-matrix-strategy.yaml` | Fan-out across configurations |
| `08-deployment.yaml` | Deployment job with lifecycle hooks |
| `09-templates/pipeline.yaml` | Template includes and reuse |
| `10-error-handling.yaml` | Retries, timeouts, continueOnError |
| `11-full-pipeline.yaml` | Production-style multi-stage CI/CD |
| `12-output-variables.yaml` | Cross-job/stage output variable patterns |
| `13-cross-stage-outputs.yaml` | Realistic CI/CD with output chaining |
