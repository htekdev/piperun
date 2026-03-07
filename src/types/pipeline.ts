// Core pipeline structure types for the piperun local pipeline runner.
// Inspired by ADO YAML pipelines but is its own format — not ADO-compatible.

import type { VariableDefinition } from './variables';
import type { ResourcesDefinition } from './resources';

// The complete pipeline definition
export interface PipelineDefinition {
  name?: string;
  appendCommitMessageToRunName?: boolean;
  lockBehavior?: 'sequential' | 'runLatest';
  parameters?: ParameterDefinition[];
  variables?: VariableDefinition[];
  resources?: ResourcesDefinition;
  stages?: StageDefinition[];
  jobs?: JobDefinition[]; // shorthand when there's only one stage
  steps?: StepDefinition[]; // shorthand when there's only one job
  extends?: ExtendsDefinition;
  pool?: PoolDefinition;
}

export interface ExtendsDefinition {
  template: string;
  parameters?: Record<string, unknown>;
}

// Parameter types
export interface ParameterDefinition {
  name: string;
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'object'
    | 'step'
    | 'stepList'
    | 'job'
    | 'jobList'
    | 'stage'
    | 'stageList';
  default?: unknown;
  displayName?: string;
  values?: unknown[];
}

// Stage
export interface StageDefinition {
  stage: string;
  displayName?: string;
  dependsOn?: string | string[];
  condition?: string;
  variables?: VariableDefinition[];
  jobs?: JobDefinition[];
  lockBehavior?: 'sequential' | 'runLatest';
  template?: string;
  templateContext?: Record<string, unknown>;
}

// Jobs — support regular, deployment, and template
export type JobDefinition =
  | RegularJobDefinition
  | DeploymentJobDefinition
  | JobTemplateReference;

export interface RegularJobDefinition {
  job: string;
  displayName?: string;
  dependsOn?: string | string[];
  condition?: string;
  continueOnError?: boolean;
  timeoutInMinutes?: number;
  cancelTimeoutInMinutes?: number;
  variables?: VariableDefinition[];
  pool?: PoolDefinition;
  container?: string | ContainerReference;
  strategy?: JobStrategy;
  workspace?: WorkspaceDefinition;
  uses?: UsesDefinition;
  steps: StepDefinition[];
}

export interface DeploymentJobDefinition {
  deployment: string;
  displayName?: string;
  dependsOn?: string | string[];
  condition?: string;
  continueOnError?: boolean;
  timeoutInMinutes?: number;
  cancelTimeoutInMinutes?: number;
  variables?: VariableDefinition[];
  pool?: PoolDefinition;
  environment: string | EnvironmentReference;
  strategy: DeploymentStrategy;
}

export interface JobTemplateReference {
  template: string;
  parameters?: Record<string, unknown>;
}

// Steps — pwsh, node, python, task, or template reference
export type StepDefinition =
  | PwshStep
  | NodeStep
  | PythonStep
  | TaskStep
  | StepTemplateReference;

interface BaseStep {
  displayName?: string;
  name?: string;
  condition?: string;
  enabled?: boolean;
  continueOnError?: boolean;
  timeoutInMinutes?: number;
  retryCountOnTaskFailure?: number;
  env?: Record<string, string>;
  target?: StepTarget;
}

export interface PwshStep extends BaseStep {
  pwsh: string;
}

export interface NodeStep extends BaseStep {
  node: string;
}

export interface PythonStep extends BaseStep {
  python: string;
}

export interface TaskStep extends BaseStep {
  task: string;
  inputs?: Record<string, string>;
}

export interface StepTemplateReference {
  template: string;
  parameters?: Record<string, unknown>;
}

export interface StepTarget {
  container?: string;
  settableVariables?: string[] | { none: boolean };
}

// Strategies
export interface JobStrategy {
  matrix?: Record<string, Record<string, string>> | string;
  parallel?: number;
  maxParallel?: number;
}

export interface DeploymentStrategy {
  runOnce?: DeploymentLifecycle;
  rolling?: RollingStrategy;
  canary?: CanaryStrategy;
}

export interface DeploymentLifecycle {
  preDeploy?: LifecycleHook;
  deploy?: LifecycleHook;
  routeTraffic?: LifecycleHook;
  postRouteTraffic?: LifecycleHook;
  on?: {
    success?: LifecycleHook;
    failure?: LifecycleHook;
  };
}

export interface RollingStrategy extends DeploymentLifecycle {
  maxParallel?: number | string;
}

export interface CanaryStrategy extends DeploymentLifecycle {
  increments?: number[];
}

export interface LifecycleHook {
  steps: StepDefinition[];
  pool?: PoolDefinition;
}

// Pool
export interface PoolDefinition {
  name?: string;
  vmImage?: string;
  demands?: string | string[];
}

// Container
export interface ContainerReference {
  image: string;
  options?: string;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  mountReadOnly?: MountReadOnly;
}

export interface MountReadOnly {
  work?: boolean;
  externals?: boolean;
  tools?: boolean;
  tasks?: boolean;
}

// Workspace
export interface WorkspaceDefinition {
  clean?: 'outputs' | 'resources' | 'all';
}

// Uses
export interface UsesDefinition {
  repositories?: string[];
  pools?: string[];
}

// Environment
export interface EnvironmentReference {
  name: string;
  resourceName?: string;
  resourceType?: string;
}

// Run context (runtime state)
export interface PipelineRunContext {
  runId: string;
  runNumber: number;
  pipelineName: string;
  startTime: Date;
  status: PipelineStatus;
  stages: Map<string, StageRunContext>;
}

export interface StageRunContext {
  name: string;
  status: PipelineStatus;
  jobs: Map<string, JobRunContext>;
}

export interface JobRunContext {
  name: string;
  status: PipelineStatus;
  outputs: Map<string, string>;
  steps: StepRunContext[];
}

export interface StepRunContext {
  name: string;
  displayName: string;
  status: PipelineStatus;
  startTime?: Date;
  endTime?: Date;
  exitCode?: number;
}

export type PipelineStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'succeededWithIssues'
  | 'canceled'
  | 'skipped';
