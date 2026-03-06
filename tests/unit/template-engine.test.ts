import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';

import {
  createTemplateExpressionProcessor,
  TemplateExpressionError,
  type TemplateExpansionContext,
  type TemplateExpressionProcessor,
} from '../../src/compiler/template-expressions.js';
import {
  TemplateEngine,
  TemplateError,
} from '../../src/compiler/template-engine.js';
import {
  PipelineCompiler,
  PipelineCompilationError,
} from '../../src/compiler/pipeline-compiler.js';
import {
  createExpressionEngine,
  type ExpressionEngine,
} from '../../src/compiler/expression-engine.js';
import { createFunctionRegistry } from '../../src/functions/index.js';
import type { ExpressionContext } from '../../src/types/expressions.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

function createTestExpressionContext(
  overrides: Partial<ExpressionContext> = {},
): ExpressionContext {
  return {
    variables: {},
    parameters: {},
    dependencies: {},
    pipeline: {},
    ...overrides,
  };
}

function createTestContext(
  params: Record<string, unknown> = {},
  vars: Record<string, string> = {},
): TemplateExpansionContext {
  return {
    parameters: params,
    variables: vars,
    expressionContext: createTestExpressionContext({
      parameters: params,
      variables: vars,
    }),
  };
}

function createTestProcessor(): {
  processor: TemplateExpressionProcessor;
  engine: ExpressionEngine;
} {
  const registry = createFunctionRegistry();
  const engine = createExpressionEngine(registry);
  const processor = createTemplateExpressionProcessor(engine);
  return { processor, engine };
}

/** Write a YAML file to disk */
async function writeYaml(
  filePath: string,
  content: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, yaml.dump(content), 'utf-8');
}

// ─── Template Expression Processor Tests ────────────────────────────────────

describe('TemplateExpressionProcessor', () => {
  let processor: TemplateExpressionProcessor;

  beforeEach(() => {
    const result = createTestProcessor();
    processor = result.processor;
  });

  // ── if directive ──────────────────────────────────────────────────────

  describe('if directive', () => {
    it('includes content when condition is truthy', () => {
      const context = createTestContext({ debug: true });
      const items = [
        { pwsh: 'echo "always"' },
        { '${{ if eq(parameters.debug, true) }}': [{ pwsh: 'echo "debug"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ pwsh: 'echo "always"' });
      expect(result[1]).toEqual({ pwsh: 'echo "debug"' });
    });

    it('excludes content when condition is falsy', () => {
      const context = createTestContext({ debug: false });
      const items = [
        { pwsh: 'echo "always"' },
        { '${{ if eq(parameters.debug, true) }}': [{ pwsh: 'echo "debug"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "always"' });
    });

    it('handles if/else chain — if is truthy', () => {
      const context = createTestContext({ env: 'production' });
      const items = [
        {
          "${{ if eq(parameters.env, 'production') }}": [
            { pwsh: 'echo "prod"' },
          ],
        },
        { '${{ else }}': [{ pwsh: 'echo "non-prod"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "prod"' });
    });

    it('handles if/else chain — if is falsy', () => {
      const context = createTestContext({ env: 'staging' });
      const items = [
        {
          "${{ if eq(parameters.env, 'production') }}": [
            { pwsh: 'echo "prod"' },
          ],
        },
        { '${{ else }}': [{ pwsh: 'echo "non-prod"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "non-prod"' });
    });

    it('handles if/elseif/else chain — elseif matches', () => {
      const context = createTestContext({ env: 'staging' });
      const items = [
        {
          "${{ if eq(parameters.env, 'production') }}": [
            { pwsh: 'echo "prod"' },
          ],
        },
        {
          "${{ elseif eq(parameters.env, 'staging') }}": [
            { pwsh: 'echo "staging"' },
          ],
        },
        { '${{ else }}': [{ pwsh: 'echo "other"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "staging"' });
    });

    it('handles if/elseif/else chain — else matches', () => {
      const context = createTestContext({ env: 'dev' });
      const items = [
        {
          "${{ if eq(parameters.env, 'production') }}": [
            { pwsh: 'echo "prod"' },
          ],
        },
        {
          "${{ elseif eq(parameters.env, 'staging') }}": [
            { pwsh: 'echo "staging"' },
          ],
        },
        { '${{ else }}': [{ pwsh: 'echo "other"' }] },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "other"' });
    });

    it('throws on elseif without preceding if', () => {
      const context = createTestContext({});
      const items = [
        { '${{ elseif eq(true, true) }}': [{ pwsh: 'echo "bad"' }] },
      ];

      expect(() => processor.processArray(items, context)).toThrow(
        TemplateExpressionError,
      );
    });

    it('throws on else without preceding if', () => {
      const context = createTestContext({});
      const items = [{ '${{ else }}': [{ pwsh: 'echo "bad"' }] }];

      expect(() => processor.processArray(items, context)).toThrow(
        TemplateExpressionError,
      );
    });

    it('resets if-chain after a non-directive item', () => {
      const context = createTestContext({ flag: false });
      const items = [
        { '${{ if eq(parameters.flag, true) }}': [{ pwsh: 'echo "a"' }] },
        { pwsh: 'echo "break"' },
        // This else is now orphaned — should throw
        { '${{ else }}': [{ pwsh: 'echo "b"' }] },
      ];

      expect(() => processor.processArray(items, context)).toThrow(
        TemplateExpressionError,
      );
    });
  });

  // ── each directive ────────────────────────────────────────────────────

  describe('each directive', () => {
    it('expands for each array element', () => {
      const context = createTestContext({
        platforms: ['linux', 'windows', 'macos'],
      });
      const items = [
        {
          '${{ each platform in parameters.platforms }}': [
            { pwsh: 'echo "${{ platform }}"' },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ pwsh: 'echo "linux"' });
      expect(result[1]).toEqual({ pwsh: 'echo "windows"' });
      expect(result[2]).toEqual({ pwsh: 'echo "macos"' });
    });

    it('provides key/value for object iteration', () => {
      const context = createTestContext({
        envVars: { NODE_ENV: 'test', DEBUG: 'true' },
      });
      const items = [
        {
          '${{ each pair in parameters.envVars }}': [
            { pwsh: 'echo "${{ pair.key }}=${{ pair.value }}"' },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ pwsh: 'echo "NODE_ENV=test"' });
      expect(result[1]).toEqual({ pwsh: 'echo "DEBUG=true"' });
    });

    it('handles empty collection gracefully', () => {
      const context = createTestContext({ items: [] });
      const items = [
        {
          '${{ each item in parameters.items }}': [
            { pwsh: 'echo "${{ item }}"' },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(0);
    });

    it('handles non-iterable collection gracefully', () => {
      const context = createTestContext({ value: 42 });
      const items = [
        {
          '${{ each item in parameters.value }}': [
            { pwsh: 'echo "${{ item }}"' },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(0);
    });

    it('interpolates loop variable in object properties', () => {
      const context = createTestContext({
        platforms: ['linux', 'windows'],
      });
      const items = [
        {
          '${{ each platform in parameters.platforms }}': [
            {
              job: 'test_${{ platform }}',
              pool: { vmImage: '${{ platform }}-latest' },
            },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        job: 'test_linux',
        pool: { vmImage: 'linux-latest' },
      });
      expect(result[1]).toEqual({
        job: 'test_windows',
        pool: { vmImage: 'windows-latest' },
      });
    });
  });

  // ── Nested directives ─────────────────────────────────────────────────

  describe('nested directives', () => {
    it('handles if inside each', () => {
      const context = createTestContext({
        platforms: ['linux', 'windows'],
        includeDebug: true,
      });
      const items = [
        {
          '${{ each platform in parameters.platforms }}': [
            { pwsh: 'echo "build on ${{ platform }}"' },
            {
              '${{ if eq(parameters.includeDebug, true) }}': [
                { pwsh: 'echo "debug on ${{ platform }}"' },
              ],
            },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ pwsh: 'echo "build on linux"' });
      expect(result[1]).toEqual({ pwsh: 'echo "debug on linux"' });
      expect(result[2]).toEqual({ pwsh: 'echo "build on windows"' });
      expect(result[3]).toEqual({ pwsh: 'echo "debug on windows"' });
    });

    it('handles each inside if', () => {
      const context = createTestContext({
        runTests: true,
        testSuites: ['unit', 'integration'],
      });
      const items = [
        {
          '${{ if eq(parameters.runTests, true) }}': [
            {
              '${{ each suite in parameters.testSuites }}': [
                { pwsh: 'npm run test:${{ suite }}' },
              ],
            },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ pwsh: 'npm run test:unit' });
      expect(result[1]).toEqual({ pwsh: 'npm run test:integration' });
    });

    it('skips each inside falsy if', () => {
      const context = createTestContext({
        runTests: false,
        testSuites: ['unit', 'integration'],
      });
      const items = [
        {
          '${{ if eq(parameters.runTests, true) }}': [
            {
              '${{ each suite in parameters.testSuites }}': [
                { pwsh: 'npm run test:${{ suite }}' },
              ],
            },
          ],
        },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(0);
    });
  });

  // ── Expression interpolation ──────────────────────────────────────────

  describe('expression interpolation', () => {
    it('interpolates expressions in string values', () => {
      const context = createTestContext({ config: 'Release' });
      const items = [
        { pwsh: 'dotnet build --configuration ${{ parameters.config }}' },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pwsh: 'dotnet build --configuration Release',
      });
    });

    it('interpolates expressions in nested objects', () => {
      const context = createTestContext({
        image: 'ubuntu-latest',
        jobName: 'build',
      });

      const result = processor.processValue(
        {
          job: '${{ parameters.jobName }}',
          pool: { vmImage: '${{ parameters.image }}' },
        },
        context,
      );

      expect(result).toEqual({
        job: 'build',
        pool: { vmImage: 'ubuntu-latest' },
      });
    });

    it('preserves non-string values', () => {
      const context = createTestContext({});

      const result = processor.processValue(
        { timeout: 30, enabled: true, name: null },
        context,
      );

      expect(result).toEqual({ timeout: 30, enabled: true, name: null });
    });

    it('evaluates expression-only values to native types', () => {
      const context = createTestContext({ count: 5 });

      const result = processor.processValue(
        '${{ parameters.count }}',
        context,
      );

      expect(result).toBe(5);
    });
  });

  // ── Object-level directives ───────────────────────────────────────────

  describe('object-level directives', () => {
    it('conditionally includes object properties', () => {
      const context = createTestContext({ useHosted: true });
      const obj = {
        '${{ if eq(parameters.useHosted, true) }}': {
          vmImage: 'ubuntu-latest',
        },
        '${{ else }}': { name: 'self-hosted' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ vmImage: 'ubuntu-latest' });
    });

    it('returns null when all directive conditions are false', () => {
      const context = createTestContext({ flag: false });
      const obj = {
        '${{ if eq(parameters.flag, true) }}': { key: 'value' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toBeNull();
    });

    it('processes expression keys in objects', () => {
      const context = createTestContext({});
      // Simulate: context has pair.key and pair.value through a parent each
      const pairContext = createTestContext({
        pair: { key: 'displayName', value: 'My Step' },
      });
      const obj = {
        '${{ pair.key }}': '${{ pair.value }}',
      };

      const result = processor.processObject(obj, pairContext);

      expect(result).toEqual({ displayName: 'My Step' });
    });

    it('handles elseif in object context when if is false and elseif is true', () => {
      const context = createTestContext({ env: 'staging' });
      const obj = {
        "${{ if eq(parameters.env, 'production') }}": { pool: 'prod-pool' },
        "${{ elseif eq(parameters.env, 'staging') }}": { pool: 'staging-pool' },
        '${{ else }}': { pool: 'dev-pool' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ pool: 'staging-pool' });
    });

    it('handles elseif in object context when if already matched (skips elseif)', () => {
      const context = createTestContext({ env: 'production' });
      const obj = {
        "${{ if eq(parameters.env, 'production') }}": { pool: 'prod-pool' },
        "${{ elseif eq(parameters.env, 'staging') }}": { pool: 'staging-pool' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ pool: 'prod-pool' });
    });

    it('throws on elseif without preceding if in object context', () => {
      const context = createTestContext({});
      const obj = {
        "${{ elseif eq(true, true) }}": { key: 'value' },
      };

      expect(() => processor.processObject(obj, context)).toThrow(
        TemplateExpressionError,
      );
    });

    it('throws on else without preceding if in object context', () => {
      const context = createTestContext({});
      const obj = {
        '${{ else }}': { key: 'value' },
      };

      expect(() => processor.processObject(obj, context)).toThrow(
        TemplateExpressionError,
      );
    });

    it('handles else in object context when if is false', () => {
      const context = createTestContext({ flag: false });
      const obj = {
        '${{ if eq(parameters.flag, true) }}': { fromIf: true },
        '${{ else }}': { fromElse: true },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ fromElse: true });
    });

    it('handles else in object context when if is true (skips else)', () => {
      const context = createTestContext({ flag: true });
      const obj = {
        '${{ if eq(parameters.flag, true) }}': { fromIf: true },
        '${{ else }}': { fromElse: true },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ fromIf: true });
    });

    it('handles each directive in object context with array', () => {
      const context = createTestContext({
        envs: ['dev', 'staging'],
      });
      const obj = {
        '${{ each env in parameters.envs }}': {
          '${{ env }}': true,
        },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ dev: true, staging: true });
    });

    it('handles each directive in object context with object', () => {
      const context = createTestContext({
        vars: { NODE_ENV: 'test', DEBUG: '1' },
      });
      const obj = {
        '${{ each pair in parameters.vars }}': {
          '${{ pair.key }}': '${{ pair.value }}',
        },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ NODE_ENV: 'test', DEBUG: '1' });
    });

    it('handles each directive with non-iterable (skips silently)', () => {
      const context = createTestContext({ val: 42 });
      const obj = {
        '${{ each item in parameters.val }}': { key: 'value' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toBeNull();
    });

    it('handles mix of directives and regular keys', () => {
      const context = createTestContext({ flag: true });
      const obj = {
        staticKey: 'staticValue',
        '${{ if eq(parameters.flag, true) }}': { dynamicKey: 'dynamicValue' },
      };

      const result = processor.processObject(obj, context);

      expect(result).toEqual({ staticKey: 'staticValue', dynamicKey: 'dynamicValue' });
    });

    it('processValue handles null and undefined', () => {
      const context = createTestContext({});

      expect(processor.processValue(null, context)).toBeNull();
      expect(processor.processValue(undefined, context)).toBeUndefined();
    });

    it('processValue handles number (passes through)', () => {
      const context = createTestContext({});

      expect(processor.processValue(42, context)).toBe(42);
    });

    it('processValue handles boolean (passes through)', () => {
      const context = createTestContext({});

      expect(processor.processValue(true, context)).toBe(true);
    });

    it('processValue processes array items', () => {
      const context = createTestContext({ name: 'World' });
      const result = processor.processValue(
        ['${{ parameters.name }}', 'static', 42],
        context,
      );

      expect(result).toEqual(['World', 'static', 42]);
    });

    it('handles directive value that is not an array (single value in body)', () => {
      const context = createTestContext({ flag: true });
      const items = [
        { '${{ if eq(parameters.flag, true) }}': { pwsh: 'echo ok' } },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(1);
    });

    it('handles directive value that is null (empty body)', () => {
      const context = createTestContext({ flag: true });
      const items = [
        { '${{ if eq(parameters.flag, true) }}': null },
      ];

      const result = processor.processArray(items, context);

      expect(result).toHaveLength(0);
    });

    it('handles mergeDirectiveValueIntoObject with array value (not merged)', () => {
      const context = createTestContext({ flag: true });
      const obj = {
        '${{ if eq(parameters.flag, true) }}': ['not', 'an', 'object'],
      };

      const result = processor.processObject(obj, context);

      // Array is not merged into object, so result is empty (only directives)
      expect(result).toBeNull();
    });

    it('handles mergeDirectiveValueIntoObject with null value', () => {
      const context = createTestContext({ flag: true });
      const obj = {
        '${{ if eq(parameters.flag, true) }}': null,
      };

      const result = processor.processObject(obj, context);

      expect(result).toBeNull();
    });
  });
});

// ─── Template Engine Tests ──────────────────────────────────────────────────

describe('TemplateEngine', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Template loading & resolution ─────────────────────────────────────

  describe('template loading & resolution', () => {
    it('loads a step template and expands it into steps', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'build-steps.yaml');
      await writeYaml(templatePath, {
        parameters: [
          { name: 'config', type: 'string', default: 'Debug' },
        ],
        steps: [
          { pwsh: 'dotnet build --configuration ${{ parameters.config }}' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [
        { template: 'templates/build-steps.yaml', parameters: { config: 'Release' } },
      ];

      const result = await engine.expandSteps(steps, pipelinePath, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        pwsh: 'dotnet build --configuration Release',
      });
    });

    it('loads a job template and expands it into jobs', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'test-jobs.yaml');
      await writeYaml(templatePath, {
        parameters: [
          { name: 'jobName', type: 'string', default: 'test' },
        ],
        jobs: [
          {
            job: '${{ parameters.jobName }}',
            steps: [{ pwsh: 'npm test' }],
          },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const jobs = [
        { template: 'templates/test-jobs.yaml', parameters: { jobName: 'myTest' } },
      ];

      const result = await engine.expandJobs(jobs, pipelinePath, context);

      expect(result).toHaveLength(1);
      const resultJob = result[0] as Record<string, unknown>;
      expect(resultJob.job).toBe('myTest');
    });

    it('loads a stage template and expands it into stages', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'deploy-stages.yaml');
      await writeYaml(templatePath, {
        parameters: [
          { name: 'env', type: 'string', default: 'dev' },
        ],
        stages: [
          {
            stage: 'deploy_${{ parameters.env }}',
            jobs: [
              {
                job: 'deploy',
                steps: [{ pwsh: 'echo "deploying to ${{ parameters.env }}"' }],
              },
            ],
          },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const stages = [
        { template: 'templates/deploy-stages.yaml', parameters: { env: 'prod' } },
      ];

      const result = await engine.expandStages(stages, pipelinePath, context);

      expect(result).toHaveLength(1);
      const stage = result[0] as Record<string, unknown>;
      expect(stage.stage).toBe('deploy_prod');
    });

    it('loads a variable template', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'common-vars.yaml');
      await writeYaml(templatePath, {
        variables: [
          { name: 'buildVersion', value: '1.0.0' },
          { name: 'env', value: 'production' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const variables = [
        { template: 'templates/common-vars.yaml' },
      ];

      const result = await engine.expandVariables(variables, pipelinePath, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'buildVersion', value: '1.0.0' });
    });

    it('uses default parameter values when not provided', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'build.yaml');
      await writeYaml(templatePath, {
        parameters: [
          { name: 'config', type: 'string', default: 'Debug' },
        ],
        steps: [
          { pwsh: 'dotnet build -c ${{ parameters.config }}' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [{ template: 'templates/build.yaml' }];

      const result = await engine.expandSteps(steps, pipelinePath, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'dotnet build -c Debug' });
    });

    it('overrides default parameter values with provided ones', async () => {
      const templatePath = path.join(tmpDir, 'templates', 'build.yaml');
      await writeYaml(templatePath, {
        parameters: [
          { name: 'config', type: 'string', default: 'Debug' },
        ],
        steps: [
          { pwsh: 'dotnet build -c ${{ parameters.config }}' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [
        { template: 'templates/build.yaml', parameters: { config: 'Release' } },
      ];

      const result = await engine.expandSteps(steps, pipelinePath, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'dotnet build -c Release' });
    });

    it('resolves cross-directory template paths', async () => {
      // Template in ../shared relative to the pipeline
      const sharedDir = path.join(tmpDir, 'shared');
      const pipelineDir = path.join(tmpDir, 'pipelines');
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.mkdir(pipelineDir, { recursive: true });

      await writeYaml(path.join(sharedDir, 'common-steps.yaml'), {
        steps: [{ pwsh: 'echo "shared step"' }],
      });

      const pipelinePath = path.join(pipelineDir, 'main.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [{ template: '../shared/common-steps.yaml' }];

      const result = await engine.expandSteps(steps, pipelinePath, context);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ pwsh: 'echo "shared step"' });
    });

    it('handles nested templates (template includes another template)', async () => {
      // Inner template
      await writeYaml(path.join(tmpDir, 'templates', 'inner.yaml'), {
        steps: [{ pwsh: 'echo "inner step"' }],
      });

      // Outer template references inner
      await writeYaml(path.join(tmpDir, 'templates', 'outer.yaml'), {
        steps: [
          { pwsh: 'echo "outer step"' },
          { template: 'inner.yaml' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [{ template: 'templates/outer.yaml' }];

      const result = await engine.expandSteps(steps, pipelinePath, context);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ pwsh: 'echo "outer step"' });
      expect(result[1]).toEqual({ pwsh: 'echo "inner step"' });
    });

    it('throws when template file does not exist', async () => {
      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const steps = [{ template: 'nonexistent.yaml' }];

      await expect(
        engine.expandSteps(steps, pipelinePath, context),
      ).rejects.toThrow(TemplateError);
    });

    it('throws when max files limit is exceeded', async () => {
      // Create a template
      await writeYaml(path.join(tmpDir, 'template.yaml'), {
        steps: [{ pwsh: 'echo "step"' }],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine({ maxFiles: 2 });
      const context = createTestContext();

      // Try to load 3 templates (exceeds limit of 2)
      const steps = [
        { template: 'template.yaml' },
        { template: 'template.yaml' },
        { template: 'template.yaml' },
      ];

      await expect(
        engine.expandSteps(steps, pipelinePath, context),
      ).rejects.toThrow(/file limit exceeded/i);
    });

    it('throws when max nesting depth is exceeded', async () => {
      // Create a self-referencing template chain that exceeds depth
      await writeYaml(path.join(tmpDir, 'a.yaml'), {
        steps: [{ template: 'b.yaml' }],
      });
      await writeYaml(path.join(tmpDir, 'b.yaml'), {
        steps: [{ template: 'c.yaml' }],
      });
      await writeYaml(path.join(tmpDir, 'c.yaml'), {
        steps: [{ pwsh: 'echo "deep"' }],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine({ maxNestingDepth: 1 });
      const context = createTestContext();

      const steps = [{ template: 'a.yaml' }];

      await expect(
        engine.expandSteps(steps, pipelinePath, context),
      ).rejects.toThrow(/nesting depth exceeded/i);
    });
  });

  // ── Template with expressions ─────────────────────────────────────────

  describe('template expressions in templates', () => {
    it('expands each directive inside a template', async () => {
      await writeYaml(path.join(tmpDir, 'templates', 'multi-platform.yaml'), {
        parameters: [
          { name: 'platforms', type: 'object', default: ['linux'] },
        ],
        jobs: [
          {
            '${{ each platform in parameters.platforms }}': [
              {
                job: 'test_${{ platform }}',
                steps: [{ pwsh: 'echo "${{ platform }}"' }],
              },
            ],
          },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      const jobs = [
        {
          template: 'templates/multi-platform.yaml',
          parameters: { platforms: ['linux', 'windows'] },
        },
      ];

      const result = await engine.expandJobs(jobs, pipelinePath, context);

      expect(result).toHaveLength(2);
      expect((result[0] as Record<string, unknown>).job).toBe('test_linux');
      expect((result[1] as Record<string, unknown>).job).toBe('test_windows');
    });

    it('expands if directive inside a template', async () => {
      await writeYaml(path.join(tmpDir, 'templates', 'conditional.yaml'), {
        parameters: [
          { name: 'includeTests', type: 'boolean', default: false },
        ],
        steps: [
          { pwsh: 'echo "build"' },
          {
            '${{ if eq(parameters.includeTests, true) }}': [
              { pwsh: 'npm test' },
            ],
          },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      // With tests
      const stepsWithTests = [
        {
          template: 'templates/conditional.yaml',
          parameters: { includeTests: true },
        },
      ];
      const resultWith = await engine.expandSteps(
        stepsWithTests,
        pipelinePath,
        context,
      );
      expect(resultWith).toHaveLength(2);

      // Without tests (new engine to reset state)
      const engine2 = new TemplateEngine();
      const stepsWithout = [
        {
          template: 'templates/conditional.yaml',
          parameters: { includeTests: false },
        },
      ];
      const resultWithout = await engine2.expandSteps(
        stepsWithout,
        pipelinePath,
        context,
      );
      expect(resultWithout).toHaveLength(1);
    });
  });

  // ── Extends ───────────────────────────────────────────────────────────

  describe('extends', () => {
    it('extends template wraps pipeline content', async () => {
      await writeYaml(path.join(tmpDir, 'templates', 'secure.yaml'), {
        parameters: [
          { name: 'buildSteps', type: 'object', default: [] },
        ],
        stages: [
          {
            stage: 'Build',
            jobs: [
              {
                job: 'build',
                steps: '${{ parameters.buildSteps }}',
              },
            ],
          },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();

      const result = await engine.expandExtends(
        {
          template: 'templates/secure.yaml',
          parameters: {
            buildSteps: [{ pwsh: 'echo "building"' }],
          },
        },
        pipelinePath,
      );

      const resultObj = result as Record<string, unknown>;
      expect(resultObj.stages).toBeDefined();
      const stages = resultObj.stages as Record<string, unknown>[];
      expect(stages).toHaveLength(1);
      expect((stages[0] as Record<string, unknown>).stage).toBe('Build');
    });

    it('extends with parameter passing', async () => {
      await writeYaml(path.join(tmpDir, 'templates', 'base.yaml'), {
        parameters: [
          { name: 'appName', type: 'string', default: 'myapp' },
        ],
        steps: [
          { pwsh: 'echo "Building ${{ parameters.appName }}"' },
        ],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();

      const result = await engine.expandExtends(
        {
          template: 'templates/base.yaml',
          parameters: { appName: 'coolapp' },
        },
        pipelinePath,
      );

      const resultObj = result as Record<string, unknown>;
      const steps = resultObj.steps as Record<string, unknown>[];
      expect(steps).toHaveLength(1);
      expect(steps[0]).toEqual({ pwsh: 'echo "Building coolapp"' });
    });
  });

  // ── Stats tracking ────────────────────────────────────────────────────

  describe('stats', () => {
    it('tracks files loaded', async () => {
      await writeYaml(path.join(tmpDir, 'template.yaml'), {
        steps: [{ pwsh: 'echo "step"' }],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      await engine.expandSteps(
        [{ template: 'template.yaml' }],
        pipelinePath,
        context,
      );

      const stats = engine.getStats();
      expect(stats.filesLoaded).toBe(1);
    });

    it('tracks memory usage', async () => {
      await writeYaml(path.join(tmpDir, 'template.yaml'), {
        steps: [{ pwsh: 'echo "step"' }],
      });

      const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
      const engine = new TemplateEngine();
      const context = createTestContext();

      await engine.expandSteps(
        [{ template: 'template.yaml' }],
        pipelinePath,
        context,
      );

      const stats = engine.getStats();
      expect(stats.memoryUsed).toBeGreaterThan(0);
    });
  });
});

// ─── Pipeline Compiler Tests ────────────────────────────────────────────────

describe('PipelineCompiler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-compiler-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('compiles a simple pipeline with no templates', async () => {
    const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
    await writeYaml(pipelinePath, {
      name: 'simple',
      steps: [{ pwsh: 'echo "hello"' }],
    });

    const compiler = new PipelineCompiler({ basePath: tmpDir });
    const result = await compiler.compile('pipeline.yaml');

    const pipeline = result.pipeline as Record<string, unknown>;
    expect(pipeline.name).toBe('simple');
    const steps = pipeline.steps as unknown[];
    expect(steps).toHaveLength(1);
  });

  it('compiles a pipeline with step template reference', async () => {
    await writeYaml(path.join(tmpDir, 'templates', 'build.yaml'), {
      parameters: [
        { name: 'config', type: 'string', default: 'Debug' },
      ],
      steps: [
        { pwsh: 'dotnet build -c ${{ parameters.config }}' },
      ],
    });

    const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
    await writeYaml(pipelinePath, {
      name: 'with-template',
      steps: [
        {
          template: 'templates/build.yaml',
          parameters: { config: 'Release' },
        },
      ],
    });

    const compiler = new PipelineCompiler({ basePath: tmpDir });
    const result = await compiler.compile('pipeline.yaml');

    const pipeline = result.pipeline as Record<string, unknown>;
    const steps = pipeline.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ pwsh: 'dotnet build -c Release' });
  });

  it('compiles a pipeline with extends', async () => {
    await writeYaml(path.join(tmpDir, 'templates', 'base.yaml'), {
      parameters: [
        { name: 'appName', type: 'string', default: 'app' },
      ],
      steps: [
        { pwsh: 'echo "Building ${{ parameters.appName }}"' },
      ],
    });

    const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
    await writeYaml(pipelinePath, {
      extends: {
        template: 'templates/base.yaml',
        parameters: { appName: 'myapp' },
      },
    });

    const compiler = new PipelineCompiler({ basePath: tmpDir });
    const result = await compiler.compile('pipeline.yaml');

    const pipeline = result.pipeline as Record<string, unknown>;
    const steps = pipeline.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ pwsh: 'echo "Building myapp"' });
  });

  it('compiles with CLI parameters overriding defaults', async () => {
    const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
    await writeYaml(pipelinePath, {
      name: 'parameterized',
      parameters: [
        { name: 'env', type: 'string', default: 'dev' },
      ],
      steps: [
        { pwsh: 'echo "deploying to ${{ parameters.env }}"' },
      ],
    });

    const compiler = new PipelineCompiler({ basePath: tmpDir });
    const result = await compiler.compile('pipeline.yaml', {
      env: 'production',
    });

    const pipeline = result.pipeline as Record<string, unknown>;
    const steps = pipeline.steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ pwsh: 'echo "deploying to production"' });
  });

  it('reports accurate compilation stats', async () => {
    await writeYaml(path.join(tmpDir, 'templates', 'steps.yaml'), {
      steps: [{ pwsh: 'echo "from template"' }],
    });

    const pipelinePath = path.join(tmpDir, 'pipeline.yaml');
    await writeYaml(pipelinePath, {
      steps: [
        { template: 'templates/steps.yaml' },
        { template: 'templates/steps.yaml' },
      ],
    });

    const compiler = new PipelineCompiler({ basePath: tmpDir });
    const result = await compiler.compile('pipeline.yaml');

    expect(result.stats.filesLoaded).toBe(2);
    expect(result.stats.templatesExpanded).toBe(2);
  });

  it('throws on invalid pipeline (non-object)', async () => {
    const compiler = new PipelineCompiler({ basePath: tmpDir });

    await expect(
      compiler.compileFromObject(null, 'test.yaml'),
    ).rejects.toThrow(PipelineCompilationError);

    await expect(
      compiler.compileFromObject([], 'test.yaml'),
    ).rejects.toThrow(PipelineCompilationError);
  });
});
