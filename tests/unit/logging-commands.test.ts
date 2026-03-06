import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseLoggingCommand,
  formatLoggingCommand,
} from '../../src/logging/command-parser.js';
import {
  createCommandRegistry,
  type CommandContext,
} from '../../src/logging/commands/index.js';
import { VariableManager } from '../../src/variables/variable-manager.js';
import { SecretMasker } from '../../src/variables/secret-masker.js';

// ─── command-parser ─────────────────────────────────────────────────────────

describe('parseLoggingCommand', () => {
  it('parses setvariable command with all properties', () => {
    const result = parseLoggingCommand(
      '##pipeline[setvariable variable=myVar;isOutput=true;isSecret=false]hello world',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('setvariable');
    expect(result!.properties).toEqual({
      variable: 'myVar',
      isOutput: 'true',
      isSecret: 'false',
    });
    expect(result!.value).toBe('hello world');
  });

  it('parses logissue with type=warning', () => {
    const result = parseLoggingCommand(
      '##pipeline[logissue type=warning]This is a warning',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('logissue');
    expect(result!.properties['type']).toBe('warning');
    expect(result!.value).toBe('This is a warning');
  });

  it('parses logissue with type=error', () => {
    const result = parseLoggingCommand(
      '##pipeline[logissue type=error]Something broke',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('logissue');
    expect(result!.properties['type']).toBe('error');
    expect(result!.value).toBe('Something broke');
  });

  it('parses complete command', () => {
    const result = parseLoggingCommand(
      '##pipeline[complete result=Succeeded]Done',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('complete');
    expect(result!.properties['result']).toBe('Succeeded');
    expect(result!.value).toBe('Done');
  });

  it('parses setprogress command', () => {
    const result = parseLoggingCommand(
      '##pipeline[setprogress value=50]Halfway done',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('setprogress');
    expect(result!.properties['value']).toBe('50');
    expect(result!.value).toBe('Halfway done');
  });

  it('parses addbuildtag command', () => {
    const result = parseLoggingCommand('##pipeline[addbuildtag]my-tag');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('addbuildtag');
    expect(result!.properties).toEqual({});
    expect(result!.value).toBe('my-tag');
  });

  it('parses updatebuildnumber command', () => {
    const result = parseLoggingCommand('##pipeline[updatebuildnumber]1.2.3');
    expect(result).not.toBeNull();
    expect(result!.command).toBe('updatebuildnumber');
    expect(result!.properties).toEqual({});
    expect(result!.value).toBe('1.2.3');
  });

  it('parses prependpath command', () => {
    const result = parseLoggingCommand(
      '##pipeline[prependpath]/usr/local/bin',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('prependpath');
    expect(result!.properties).toEqual({});
    expect(result!.value).toBe('/usr/local/bin');
  });

  it('parses command with no properties', () => {
    const result = parseLoggingCommand(
      '##pipeline[uploadfile]/path/to/file.txt',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('uploadfile');
    expect(result!.properties).toEqual({});
    expect(result!.value).toBe('/path/to/file.txt');
  });

  it('parses command with no value', () => {
    const result = parseLoggingCommand(
      '##pipeline[complete result=Succeeded]',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('complete');
    expect(result!.properties['result']).toBe('Succeeded');
    expect(result!.value).toBe('');
  });

  it('returns null for non-command line', () => {
    expect(parseLoggingCommand('Just a regular log line')).toBeNull();
    expect(parseLoggingCommand('')).toBeNull();
    expect(parseLoggingCommand('## Not a command')).toBeNull();
    expect(parseLoggingCommand('##pipeline nope')).toBeNull();
  });

  it('parses logdetail with multiple properties', () => {
    const result = parseLoggingCommand(
      '##pipeline[logdetail id=abc123;parentId=def456;type=build]Building project',
    );
    expect(result).not.toBeNull();
    expect(result!.command).toBe('logdetail');
    expect(result!.properties).toEqual({
      id: 'abc123',
      parentId: 'def456',
      type: 'build',
    });
    expect(result!.value).toBe('Building project');
  });
});

describe('formatLoggingCommand', () => {
  it('round-trips a command with properties and value', () => {
    const original =
      '##pipeline[setvariable variable=myVar;isOutput=true]hello';
    const parsed = parseLoggingCommand(original);
    expect(parsed).not.toBeNull();
    const formatted = formatLoggingCommand(parsed!);
    // Re-parse the formatted string to verify equivalence
    const reparsed = parseLoggingCommand(formatted);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.command).toBe(parsed!.command);
    expect(reparsed!.properties).toEqual(parsed!.properties);
    expect(reparsed!.value).toBe(parsed!.value);
  });

  it('round-trips a command with no properties', () => {
    const cmd = { command: 'addbuildtag', properties: {}, value: 'release' };
    const formatted = formatLoggingCommand(cmd);
    expect(formatted).toBe('##pipeline[addbuildtag]release');
    const reparsed = parseLoggingCommand(formatted);
    expect(reparsed).toEqual(cmd);
  });

  it('round-trips a command with no value', () => {
    const cmd = {
      command: 'complete',
      properties: { result: 'Failed' },
      value: '',
    };
    const formatted = formatLoggingCommand(cmd);
    const reparsed = parseLoggingCommand(formatted);
    expect(reparsed).not.toBeNull();
    expect(reparsed!.command).toBe('complete');
    expect(reparsed!.properties['result']).toBe('Failed');
    expect(reparsed!.value).toBe('');
  });
});

// ─── Command handlers ───────────────────────────────────────────────────────

describe('Command handlers', () => {
  let variableManager: VariableManager;
  let secretMasker: SecretMasker;
  let context: CommandContext;
  let registry: Map<string, (cmd: ReturnType<typeof parseLoggingCommand> & object, ctx: CommandContext) => void>;

  beforeEach(() => {
    secretMasker = new SecretMasker();
    variableManager = new VariableManager(secretMasker);
    variableManager.enterScope('pipeline', 'pipeline');

    context = {
      variableManager,
      secretMasker,
      jobName: 'test-job',
      stepName: 'test-step',
      outputs: new Map(),
      tags: new Set(),
      runNumber: '1.0.0',
      progress: { percent: 0, description: '' },
      warnings: [],
      errors: [],
      uploadedFiles: [],
      uploadedSummaries: [],
      logDetails: [],
    };

    registry = createCommandRegistry();
  });

  it('setvariable sets variable in VariableManager', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[setvariable variable=buildVersion]2.0.0',
    )!;
    const handler = registry.get('setvariable')!;
    handler(cmd, context);

    expect(variableManager.get('buildVersion')).toBe('2.0.0');
  });

  it('setvariable with isOutput records as output variable', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[setvariable variable=result;isOutput=true]success',
    )!;
    const handler = registry.get('setvariable')!;
    handler(cmd, context);

    expect(context.outputs.get('result')).toBe('success');
    expect(variableManager.get('result')).toBe('success');
  });

  it('setvariable with isSecret registers with SecretMasker', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[setvariable variable=token;isSecret=true]my-secret-token',
    )!;
    const handler = registry.get('setvariable')!;
    handler(cmd, context);

    expect(variableManager.get('token')).toBe('my-secret-token');
    expect(secretMasker.mask('my-secret-token')).toBe('***');
  });

  it('logissue with type=warning adds to warnings', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[logissue type=warning]Deprecated API used',
    )!;
    const handler = registry.get('logissue')!;
    handler(cmd, context);

    expect(context.warnings).toContain('Deprecated API used');
    expect(context.errors).toHaveLength(0);
  });

  it('logissue with type=error adds to errors', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[logissue type=error]Build failed',
    )!;
    const handler = registry.get('logissue')!;
    handler(cmd, context);

    expect(context.errors).toContain('Build failed');
    expect(context.warnings).toHaveLength(0);
  });

  it('addbuildtag adds tag to context', () => {
    const cmd = parseLoggingCommand('##pipeline[addbuildtag]release-v2')!;
    const handler = registry.get('addbuildtag')!;
    handler(cmd, context);

    expect(context.tags.has('release-v2')).toBe(true);
  });

  it('updatebuildnumber updates run number', () => {
    const cmd = parseLoggingCommand('##pipeline[updatebuildnumber]3.1.4')!;
    const handler = registry.get('updatebuildnumber')!;
    handler(cmd, context);

    expect(context.runNumber).toBe('3.1.4');
  });

  it('setprogress updates progress', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[setprogress value=75]Almost done',
    )!;
    const handler = registry.get('setprogress')!;
    handler(cmd, context);

    expect(context.progress.percent).toBe(75);
    expect(context.progress.description).toBe('Almost done');
  });

  it('complete sets completion result', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[complete result=SucceededWithIssues]Mostly OK',
    )!;
    const handler = registry.get('complete')!;
    handler(cmd, context);

    expect(context.completionResult).toBe('SucceededWithIssues');
  });

  it('uploadfile records file path', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[uploadfile]/build/output.zip',
    )!;
    const handler = registry.get('uploadfile')!;
    handler(cmd, context);

    expect(context.uploadedFiles).toContain('/build/output.zip');
  });

  it('uploadsummary records summary file path', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[uploadsummary]/tmp/summary.md',
    )!;
    const handler = registry.get('uploadsummary')!;
    handler(cmd, context);

    expect(context.uploadedSummaries).toContain('/tmp/summary.md');
  });

  it('logdetail records timeline detail', () => {
    const cmd = parseLoggingCommand(
      '##pipeline[logdetail id=abc;parentId=root;type=build]Compiling',
    )!;
    const handler = registry.get('logdetail')!;
    handler(cmd, context);

    expect(context.logDetails).toHaveLength(1);
    expect(context.logDetails[0]).toEqual({
      id: 'abc',
      parentId: 'root',
      type: 'build',
      message: 'Compiling',
    });
  });
});
