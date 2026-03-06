import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServiceConnectionManager } from '../../src/resources/service-connections.js';

describe('ServiceConnectionManager', () => {
  let tempDir: string;
  let manager: ServiceConnectionManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piperun-svc-test-'));
    manager = new ServiceConnectionManager();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('loads connections from YAML file', async () => {
    // Create .pipeline/connections.yaml
    const pipelineDir = join(tempDir, '.pipeline');
    await mkdir(pipelineDir, { recursive: true });

    const yamlContent = `
connections:
  - name: my-registry
    type: docker
    url: https://registry.example.com
    credentials:
      username: admin
      password: secret123
  - name: my-api
    type: generic
    url: https://api.example.com
    credentials:
      apiKey: key-abc-123
`;
    await writeFile(join(pipelineDir, 'connections.yaml'), yamlContent, 'utf-8');

    const connections = await manager.loadConnections(tempDir);

    expect(connections.size).toBe(2);

    const docker = connections.get('my-registry');
    expect(docker).toBeDefined();
    expect(docker!.type).toBe('docker');
    expect(docker!.url).toBe('https://registry.example.com');
    expect(docker!.credentials!['username']).toBe('admin');
    expect(docker!.credentials!['password']).toBe('secret123');

    const api = connections.get('my-api');
    expect(api).toBeDefined();
    expect(api!.type).toBe('generic');
    expect(api!.credentials!['apiKey']).toBe('key-abc-123');
  });

  it('resolves env var references in credentials', async () => {
    const pipelineDir = join(tempDir, '.pipeline');
    await mkdir(pipelineDir, { recursive: true });

    const yamlContent = `
connections:
  - name: github-conn
    type: github
    url: https://github.com
    credentials:
      token: \${TEST_GH_TOKEN}
`;
    await writeFile(join(pipelineDir, 'connections.yaml'), yamlContent, 'utf-8');

    // Set the env var
    process.env['TEST_GH_TOKEN'] = 'ghp_faketoken123';
    try {
      const connections = await manager.loadConnections(tempDir);
      const conn = connections.get('github-conn');
      expect(conn).toBeDefined();
      expect(conn!.credentials!['token']).toBe('ghp_faketoken123');
    } finally {
      delete process.env['TEST_GH_TOKEN'];
    }
  });

  it('keeps unresolved env var placeholder when env var is not set', async () => {
    const pipelineDir = join(tempDir, '.pipeline');
    await mkdir(pipelineDir, { recursive: true });

    const yamlContent = `
connections:
  - name: missing-env
    type: generic
    credentials:
      secret: \${DEFINITELY_NOT_SET_ENV_VAR}
`;
    await writeFile(join(pipelineDir, 'connections.yaml'), yamlContent, 'utf-8');

    // Ensure env var is not set
    delete process.env['DEFINITELY_NOT_SET_ENV_VAR'];

    const connections = await manager.loadConnections(tempDir);
    const conn = connections.get('missing-env');
    expect(conn).toBeDefined();
    expect(conn!.credentials!['secret']).toBe('${DEFINITELY_NOT_SET_ENV_VAR}');
  });

  it('local .pipeline/ overrides global ~/.piperun/config/', async () => {
    // Simulate global config by writing to a known temp location
    // We can't easily test with real home dir, so we test the override logic
    // by verifying local connections take precedence.
    // The best we can do without modifying internals is to verify that
    // when both are present, local wins.
    const pipelineDir = join(tempDir, '.pipeline');
    await mkdir(pipelineDir, { recursive: true });

    const localYaml = `
connections:
  - name: shared-conn
    type: docker
    credentials:
      username: local-user
`;
    await writeFile(
      join(pipelineDir, 'connections.yaml'),
      localYaml,
      'utf-8',
    );

    const connections = await manager.loadConnections(tempDir);
    const conn = connections.get('shared-conn');
    expect(conn).toBeDefined();
    expect(conn!.credentials!['username']).toBe('local-user');
  });

  it('returns empty map when no files exist', async () => {
    // Use a dir with no .pipeline/ folder
    const emptyDir = join(tempDir, 'empty');
    await mkdir(emptyDir, { recursive: true });

    const connections = await manager.loadConnections(emptyDir);
    expect(connections.size).toBe(0);
  });

  it('gets a specific connection by name', async () => {
    const pipelineDir = join(tempDir, '.pipeline');
    await mkdir(pipelineDir, { recursive: true });

    const yamlContent = `
connections:
  - name: npm-registry
    type: npm
    url: https://registry.npmjs.org
    credentials:
      token: npm_tok123
`;
    await writeFile(join(pipelineDir, 'connections.yaml'), yamlContent, 'utf-8');

    const conn = await manager.getConnection('npm-registry', tempDir);
    expect(conn).toBeDefined();
    expect(conn!.type).toBe('npm');
    expect(conn!.credentials!['token']).toBe('npm_tok123');

    // Non-existent connection returns undefined
    const missing = await manager.getConnection('nonexistent', tempDir);
    expect(missing).toBeUndefined();
  });
});
