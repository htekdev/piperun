import { z } from 'zod';

// Step schemas
const baseStepSchema = z.object({
  displayName: z.string().optional(),
  name: z.string().optional(),
  condition: z.string().optional(),
  enabled: z.boolean().optional(),
  continueOnError: z.boolean().optional(),
  timeoutInMinutes: z.number().optional(),
  retryCountOnTaskFailure: z.number().optional(),
  env: z.record(z.string(), z.string()).optional(),
  target: z.union([
    z.string(),
    z.object({
      container: z.string().optional(),
      settableVariables: z.union([
        z.array(z.string()),
        z.object({ none: z.boolean() }),
      ]).optional(),
    }),
  ]).optional(),
}).passthrough();

export const pwshStepSchema = baseStepSchema.extend({
  pwsh: z.string(),
});

export const nodeStepSchema = baseStepSchema.extend({
  node: z.string(),
});

export const pythonStepSchema = baseStepSchema.extend({
  python: z.string(),
});

export const taskStepSchema = baseStepSchema.extend({
  task: z.string(),
  inputs: z.record(z.string(), z.string()).optional(),
});

export const stepTemplateSchema = z.object({
  template: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const stepSchema = z.union([
  pwshStepSchema,
  nodeStepSchema,
  pythonStepSchema,
  taskStepSchema,
  stepTemplateSchema,
]);

// Variable schemas
export const inlineVariableSchema = z.object({
  name: z.string(),
  value: z.string(),
  readonly: z.boolean().optional(),
});

export const variableGroupSchema = z.object({
  group: z.string(),
});

export const variableTemplateSchema = z.object({
  template: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const variableDefinitionSchema = z.union([
  inlineVariableSchema,
  variableGroupSchema,
  variableTemplateSchema,
]);

export const variablesSchema = z.union([
  z.array(variableDefinitionSchema),
  z.record(z.string(), z.string()),
]);

// Parameter schema
export const parameterSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'object', 'step', 'stepList', 'job', 'jobList', 'stage', 'stageList']),
  default: z.unknown().optional(),
  displayName: z.string().optional(),
  values: z.array(z.unknown()).optional(),
});

// Pool schema
export const poolSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    vmImage: z.string().optional(),
    demands: z.union([z.string(), z.array(z.string())]).optional(),
  }),
]);

// Container reference
export const containerReferenceSchema = z.union([
  z.string(),
  z.object({
    image: z.string(),
    options: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    ports: z.array(z.string()).optional(),
    volumes: z.array(z.string()).optional(),
    mountReadOnly: z.object({
      work: z.boolean().optional(),
      externals: z.boolean().optional(),
      tools: z.boolean().optional(),
      tasks: z.boolean().optional(),
    }).optional(),
  }),
]);

// Workspace
export const workspaceSchema = z.object({
  clean: z.enum(['outputs', 'resources', 'all']).optional(),
});

// Uses
export const usesSchema = z.object({
  repositories: z.array(z.string()).optional(),
  pools: z.array(z.string()).optional(),
});

// Environment reference
export const environmentSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    resourceName: z.string().optional(),
    resourceType: z.string().optional(),
  }),
]);

// Lifecycle hook
export const lifecycleHookSchema = z.object({
  steps: z.array(stepSchema),
  pool: poolSchema.optional(),
});

// Deployment strategy schemas
export const deploymentLifecycleSchema = z.object({
  preDeploy: lifecycleHookSchema.optional(),
  deploy: lifecycleHookSchema.optional(),
  routeTraffic: lifecycleHookSchema.optional(),
  postRouteTraffic: lifecycleHookSchema.optional(),
  on: z.object({
    success: lifecycleHookSchema.optional(),
    failure: lifecycleHookSchema.optional(),
  }).optional(),
});

export const deploymentStrategySchema = z.object({
  runOnce: deploymentLifecycleSchema.optional(),
  rolling: deploymentLifecycleSchema.extend({
    maxParallel: z.union([z.number(), z.string()]).optional(),
  }).optional(),
  canary: deploymentLifecycleSchema.extend({
    increments: z.array(z.number()).optional(),
  }).optional(),
});

// Job strategy
export const jobStrategySchema = z.object({
  matrix: z.record(z.string(), z.record(z.string(), z.coerce.string())).optional(),
  parallel: z.number().optional(),
  maxParallel: z.number().optional(),
});

// Job schemas
export const regularJobSchema = z.object({
  job: z.string(),
  displayName: z.string().optional(),
  dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
  condition: z.string().optional(),
  continueOnError: z.boolean().optional(),
  timeoutInMinutes: z.number().optional(),
  cancelTimeoutInMinutes: z.number().optional(),
  variables: variablesSchema.optional(),
  pool: poolSchema.optional(),
  container: containerReferenceSchema.optional(),
  strategy: jobStrategySchema.optional(),
  workspace: workspaceSchema.optional(),
  uses: usesSchema.optional(),
  steps: z.array(stepSchema),
});

export const deploymentJobSchema = z.object({
  deployment: z.string(),
  displayName: z.string().optional(),
  dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
  condition: z.string().optional(),
  continueOnError: z.boolean().optional(),
  timeoutInMinutes: z.number().optional(),
  cancelTimeoutInMinutes: z.number().optional(),
  variables: variablesSchema.optional(),
  pool: poolSchema.optional(),
  environment: environmentSchema,
  strategy: deploymentStrategySchema,
});

export const jobTemplateSchema = z.object({
  template: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const jobSchema = z.union([
  regularJobSchema,
  deploymentJobSchema,
  jobTemplateSchema,
]);

// Stage schema
export const stageSchema = z.union([
  z.object({
    stage: z.string(),
    displayName: z.string().optional(),
    dependsOn: z.union([z.string(), z.array(z.string())]).optional(),
    condition: z.string().optional(),
    variables: variablesSchema.optional(),
    jobs: z.array(jobSchema).optional(),
    lockBehavior: z.enum(['sequential', 'runLatest']).optional(),
  }),
  z.object({
    template: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// Resources schemas
export const pipelineResourceSchema = z.object({
  pipeline: z.string(),
  source: z.string(),
  project: z.string().optional(),
  version: z.string().optional(),
});

export const repositoryResourceSchema = z.object({
  repository: z.string(),
  type: z.enum(['git', 'github']),
  name: z.string(),
  ref: z.string().optional(),
  endpoint: z.string().optional(),
});

export const containerResourceSchema = z.object({
  container: z.string(),
  image: z.string(),
  options: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  mountReadOnly: z.object({
    work: z.boolean().optional(),
    externals: z.boolean().optional(),
    tools: z.boolean().optional(),
    tasks: z.boolean().optional(),
  }).optional(),
});

export const resourcesSchema= z.object({
  pipelines: z.array(pipelineResourceSchema).optional(),
  repositories: z.array(repositoryResourceSchema).optional(),
  containers: z.array(containerResourceSchema).optional(),
});

// Extends schema
export const extendsSchema = z.object({
  template: z.string(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// Top-level pipeline schema
export const pipelineSchema = z.object({
  name: z.string().optional(),
  appendCommitMessageToRunName: z.boolean().optional(),
  lockBehavior: z.enum(['sequential', 'runLatest']).optional(),
  parameters: z.array(parameterSchema).optional(),
  variables: variablesSchema.optional(),
  resources: resourcesSchema.optional(),
  pool: poolSchema.optional(),
  stages: z.array(stageSchema).optional(),
  jobs: z.array(jobSchema).optional(),
  steps: z.array(stepSchema).optional(),
  extends: extendsSchema.optional(),
}).passthrough();
