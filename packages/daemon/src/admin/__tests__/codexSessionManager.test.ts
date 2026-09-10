import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CodexSessionManager,
  replaceStructuredProviderFields,
} from '../codexSessionManager';

const SESSION_ID = '01a00000-0000-7000-8000-000000000001';
const OTHER_SESSION_ID = '01a00000-0000-7000-8000-000000000002';

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});
describe('CodexSessionManager', () => {
  it('lists project sessions and updates JSONL structured fields plus threads.model_provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omnicross-codex-session-'));
    tempRoots.push(root);
    const project = join(root, 'project');
    const otherProject = join(root, 'other-project');
    const codexHome = join(root, 'codex');
    const rolloutDir = join(codexHome, 'sessions', '2026', '01', '01');
    await mkdir(project, { recursive: true });
    await mkdir(otherProject, { recursive: true });
    await mkdir(rolloutDir, { recursive: true });

    const rolloutPath = join(rolloutDir, `rollout-2026-01-01T00-00-00-${SESSION_ID}.jsonl`);
    const otherRolloutPath = join(rolloutDir, `rollout-2026-01-01T00-00-01-${OTHER_SESSION_ID}.jsonl`);
    await writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        // The filename is the state_5.sqlite thread key. The payload can carry
        // a repeated parent id in historical Codex rollouts.
        payload: { session_id: OTHER_SESSION_ID, id: OTHER_SESSION_ID, cwd: project, model_provider: 'openai' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          thread_settings: { model: 'gpt-test', model_provider_id: 'openai' },
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', content: [{ text: 'keep the words model_provider=openai unchanged' }] },
      }),
      '',
    ].join('\n'), 'utf8');
    await writeFile(otherRolloutPath, `${JSON.stringify({
      type: 'session_meta',
      payload: { session_id: OTHER_SESSION_ID, cwd: otherProject, model_provider: 'sss' },
    })}\n`, 'utf8');

    const statePath = join(codexHome, 'state_5.sqlite');
    const database = new DatabaseSync(statePath);
    database.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        sandbox_policy TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        model TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER
      );
    `);
    const insert = database.prepare(`
      INSERT INTO threads
        (id, rollout_path, created_at, updated_at, source, model_provider, cwd,
         title, sandbox_policy, approval_mode, model, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      SESSION_ID,
      rolloutPath,
      1_767_225_600,
      1_767_225_601,
      'cli',
      'openai',
      project,
      'test',
      '{}',
      'never',
      'gpt-test',
      1_767_225_600_000,
      1_767_225_601_000,
    );
    insert.run(
      OTHER_SESSION_ID,
      otherRolloutPath,
      1_767_225_600,
      1_767_225_601,
      'cli',
      'sss',
      otherProject,
      'other',
      '{}',
      'never',
      'gpt-other',
      1_767_225_600_000,
      1_767_225_601_000,
    );
    database.close();

    const manager = new CodexSessionManager({ codexHome });
    const listed = await manager.list(project);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      id: SESSION_ID,
      provider: 'openai',
      model: 'gpt-test',
      inStateDatabase: true,
      status: 'ready',
    });

    const preview = await manager.preview({
      projectPath: project,
      sessionIds: [SESSION_ID],
      fromProvider: 'openai',
      toProvider: 'omnicross',
    });
    expect(preview.sessions[0]).toMatchObject({
      providers: ['openai'],
      matchingFields: 2,
      changedFields: 2,
      sqliteWillUpdate: true,
      action: 'update',
    });

    const result = await manager.apply({
      projectPath: project,
      sessionIds: [SESSION_ID],
      fromProvider: 'openai',
      toProvider: 'omnicross',
    });
    expect(result).toMatchObject({
      updatedSessions: 1,
      jsonlFiles: 1,
      jsonlFields: 2,
      sqliteRows: 1,
    });
    expect(result.backups).toHaveLength(2);

    const lines = (await readFile(rolloutPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
    expect(lines[0].payload.model_provider).toBe('omnicross');
    expect(lines[1].payload.thread_settings.model_provider_id).toBe('omnicross');
    expect(lines[2].payload.content[0].text).toBe('keep the words model_provider=openai unchanged');

    const verify = new DatabaseSync(statePath);
    const row = verify.prepare('SELECT model_provider, model FROM threads WHERE id = ?').get(SESSION_ID) as {
      model_provider: string;
      model: string;
    };
    verify.close();
    expect(row).toEqual({ model_provider: 'omnicross', model: 'gpt-test' });
  });

  it('changes only exact structured provider properties', () => {
    const value = {
      model_provider: 'openai',
      nested: { model_provider_id: 'sss' },
      message: 'model_provider=openai and model_provider_id=sss',
    };
    const result = replaceStructuredProviderFields(value, undefined, 'omnicross');
    expect(result).toEqual({ matchingFields: 2, changedFields: 2 });
    expect(value).toEqual({
      model_provider: 'omnicross',
      nested: { model_provider_id: 'omnicross' },
      message: 'model_provider=openai and model_provider_id=sss',
    });
  });
});
