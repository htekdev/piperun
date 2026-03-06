import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EnvironmentManager,
  type DeploymentRecord,
} from '../../src/environments/environment-manager.js';
import {
  DeploymentHistoryWriter,
  type RunHistory,
} from '../../src/environments/deployment-history.js';

// ─── EnvironmentManager ─────────────────────────────────────────────────────

describe('EnvironmentManager', () => {
  let tempDir: string;
  let manager: EnvironmentManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piperun-env-test-'));
    manager = new EnvironmentManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createRecord(overrides?: Partial<DeploymentRecord>): DeploymentRecord {
    return {
      runId: 'run-001',
      runNumber: 1,
      pipelineName: 'test-pipeline',
      timestamp: new Date().toISOString(),
      status: 'succeeded',
      strategy: 'runOnce',
      duration: 5000,
      ...overrides,
    };
  }

  it('records and retrieves deployment history', async () => {
    const record = createRecord();
    await manager.recordDeployment('production', record);

    const history = await manager.getHistory('production');
    expect(history).toHaveLength(1);
    expect(history[0].runId).toBe('run-001');
    expect(history[0].pipelineName).toBe('test-pipeline');
  });

  it('stores history as JSON on disk', async () => {
    const record = createRecord();
    await manager.recordDeployment('staging', record);

    const filePath = join(tempDir, 'staging', 'history.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('appends multiple deployments to same environment', async () => {
    await manager.recordDeployment('prod', createRecord({ runId: 'run-001', runNumber: 1 }));
    await manager.recordDeployment('prod', createRecord({ runId: 'run-002', runNumber: 2 }));
    await manager.recordDeployment('prod', createRecord({ runId: 'run-003', runNumber: 3 }));

    const history = await manager.getHistory('prod');
    expect(history).toHaveLength(3);
  });

  it('returns history in reverse chronological order', async () => {
    await manager.recordDeployment(
      'env',
      createRecord({ runId: 'old', timestamp: '2024-01-01T00:00:00Z' }),
    );
    await manager.recordDeployment(
      'env',
      createRecord({ runId: 'new', timestamp: '2024-06-01T00:00:00Z' }),
    );
    await manager.recordDeployment(
      'env',
      createRecord({ runId: 'mid', timestamp: '2024-03-01T00:00:00Z' }),
    );

    const history = await manager.getHistory('env');
    expect(history[0].runId).toBe('new');
    expect(history[1].runId).toBe('mid');
    expect(history[2].runId).toBe('old');
  });

  it('respects limit parameter in getHistory', async () => {
    for (let i = 0; i < 5; i++) {
      await manager.recordDeployment(
        'env',
        createRecord({
          runId: `run-${i}`,
          timestamp: new Date(2024, 0, i + 1).toISOString(),
        }),
      );
    }

    const history = await manager.getHistory('env', 2);
    expect(history).toHaveLength(2);
  });

  it('lists known environments', async () => {
    await manager.recordDeployment('production', createRecord());
    await manager.recordDeployment('staging', createRecord());
    await manager.recordDeployment('dev', createRecord());

    const envs = await manager.listEnvironments();
    expect(envs).toHaveLength(3);
    expect(envs.sort()).toEqual(['dev', 'production', 'staging']);
  });

  it('returns empty array when no environments exist', async () => {
    const envs = await manager.listEnvironments();
    expect(envs).toHaveLength(0);
  });

  it('gets the latest deployment for an environment', async () => {
    await manager.recordDeployment(
      'prod',
      createRecord({ runId: 'first', timestamp: '2024-01-01T00:00:00Z' }),
    );
    await manager.recordDeployment(
      'prod',
      createRecord({ runId: 'latest', timestamp: '2024-12-01T00:00:00Z' }),
    );

    const latest = await manager.getLatestDeployment('prod');
    expect(latest).not.toBeNull();
    expect(latest!.runId).toBe('latest');
  });

  it('returns null for latest deployment on unknown environment', async () => {
    const latest = await manager.getLatestDeployment('nonexistent');
    expect(latest).toBeNull();
  });

  it('returns empty history for unknown environment', async () => {
    const history = await manager.getHistory('nonexistent');
    expect(history).toHaveLength(0);
  });
});

// ─── DeploymentHistoryWriter ────────────────────────────────────────────────

describe('DeploymentHistoryWriter', () => {
  let tempDir: string;
  let writer: DeploymentHistoryWriter;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piperun-runs-test-'));
    writer = new DeploymentHistoryWriter(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createRunHistory(overrides?: Partial<RunHistory>): RunHistory {
    return {
      runId: 'run-001',
      runNumber: 1,
      pipelineName: 'test-pipeline',
      startTime: '2024-06-01T10:00:00Z',
      endTime: '2024-06-01T10:05:00Z',
      status: 'succeeded',
      stages: [{ name: 'Build', status: 'succeeded', duration: 30000 }],
      parameters: {},
      deployments: [],
      ...overrides,
    };
  }

  it('writes and reads run history', async () => {
    const history = createRunHistory();
    await writer.writeRunHistory(history);

    const retrieved = await writer.readRunHistory('run-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.runId).toBe('run-001');
    expect(retrieved!.pipelineName).toBe('test-pipeline');
    expect(retrieved!.status).toBe('succeeded');
  });

  it('stores history file at correct path', async () => {
    await writer.writeRunHistory(createRunHistory({ runId: 'xyz-123' }));

    const filePath = join(tempDir, 'xyz-123', 'history.json');
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.runId).toBe('xyz-123');
  });

  it('returns null for unknown run ID', async () => {
    const result = await writer.readRunHistory('unknown');
    expect(result).toBeNull();
  });

  it('lists recent runs sorted by startTime', async () => {
    await writer.writeRunHistory(
      createRunHistory({
        runId: 'old',
        startTime: '2024-01-01T00:00:00Z',
      }),
    );
    await writer.writeRunHistory(
      createRunHistory({
        runId: 'new',
        startTime: '2024-12-01T00:00:00Z',
      }),
    );
    await writer.writeRunHistory(
      createRunHistory({
        runId: 'mid',
        startTime: '2024-06-01T00:00:00Z',
      }),
    );

    const runs = await writer.listRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0].runId).toBe('new');
    expect(runs[1].runId).toBe('mid');
    expect(runs[2].runId).toBe('old');
  });

  it('respects limit in listRuns', async () => {
    for (let i = 0; i < 5; i++) {
      await writer.writeRunHistory(
        createRunHistory({
          runId: `run-${i}`,
          startTime: new Date(2024, 0, i + 1).toISOString(),
        }),
      );
    }

    const runs = await writer.listRuns(2);
    expect(runs).toHaveLength(2);
  });

  it('returns empty array when no runs exist', async () => {
    const runs = await writer.listRuns();
    expect(runs).toHaveLength(0);
  });

  it('preserves deployment records in run history', async () => {
    const history = createRunHistory({
      deployments: [
        { environment: 'prod', status: 'succeeded', strategy: 'runOnce' },
        { environment: 'staging', status: 'failed', strategy: 'canary' },
      ],
    });

    await writer.writeRunHistory(history);
    const retrieved = await writer.readRunHistory(history.runId);

    expect(retrieved!.deployments).toHaveLength(2);
    expect(retrieved!.deployments[0].environment).toBe('prod');
    expect(retrieved!.deployments[1].strategy).toBe('canary');
  });
});
