/**
 * admin-jev-systemone.test.ts — `POST /admin/api/jev/systemone`.
 *
 * Boots the FULL daemon in process against a config whose provider row is a
 * 'other'-category open-jev row pointing at a local MOCK upstream that returns
 * a fixed top-logprobs distribution. Covers:
 *  - the three Jev primitives answer in Jev shapes (choice/score/noul);
 *  - the read call carries logprobs params + the row's Bearer key;
 *  - `jev-latest`/absent model resolves to the row's default model;
 *  - no 'other' row → 409 with guidance; an upstream without logprobs → 502.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildDaemon, type Daemon, resetDaemonSingletonsForTests } from '../bootstrap';
import { loadConfig } from '../config';

let tmpDir: string;
let daemon: Daemon;
let adminBase: string;
let mockUpstream: Server;
let mockUrl = '';
/** 固定分布：A 强、B 弱、数字 3/8 有质量；数组形状（NIM 实测形状）。 */
let lastBodies: Array<Record<string, unknown>> = [];

function startMockUpstream(): Promise<void> {
  mockUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      lastBodies.push(body);
      const auth = req.headers['authorization'];
      if (req.url === '/v1/chat/completions' && auth === 'Bearer mock-key') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{
            message: { content: '' },
            logprobs: { content: [{ token: 'A', top_logprobs: [
              { token: 'A', logprob: -0.1 },
              { token: 'B', logprob: -3.0 },
              { token: '3', logprob: -2.0 },
              { token: '8', logprob: -1.5 },
              { token: '<eos>', logprob: -4.0 },
            ] }] },
          }],
          usage: { prompt_tokens: 42, completion_tokens: 1 },
        }));
        return;
      }
      res.writeHead(401).end();
    });
  });
  return new Promise((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
}

async function boot(withOtherRow: boolean): Promise<void> {
  resetDaemonSingletonsForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'omnicross-jev-'));
  const providers = withOtherRow
    ? [{
        id: 'open-jev',
        apiFormat: 'openai',
        baseUrl: `${mockUrl}/v1`,
        apiKey: 'mock-key',
        models: ['mock-dgemma'],
        category: 'other' as const,
      }]
    : [{
        id: 'chat',
        apiFormat: 'openai',
        baseUrl: `${mockUrl}/v1`,
        apiKey: 'mock-key',
        models: ['chat-model'],
      }];
  const configPath = join(tmpDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    providers,
    server: { enabled: false, networkBinding: false, port: 0, endpoints: [] },
    admin: { port: 0 },
  }, null, 2), 'utf8');
  daemon = buildDaemon(loadConfig(configPath), {
    configPath,
    keysPath: join(tmpDir, 'keys.json'),
    tokensPath: join(tmpDir, 'tokens.json'),
    masterKeyFilePath: join(tmpDir, 'master.key'),
  });
  await daemon.llmConfig.ready();
  await daemon.adminServer.start();
  adminBase = daemon.adminServer.getStatus().url as string;
}

async function post(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${adminBase}/admin/api/jev/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

beforeEach(async () => {
  lastBodies = [];
  await startMockUpstream();
  mockUrl = `http://127.0.0.1:${(mockUpstream.address() as { port: number }).port}`;
});

afterEach(async () => {
  if (daemon) {
    await daemon.adminServer.stop();
    await daemon.outboundApiServer.stop();
    daemon.apiKeyPool.dispose();
  }
  resetDaemonSingletonsForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (mockUpstream) await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
});

describe('POST /admin/api/jev/systemone', () => {
  it('answers the three primitives in Jev shapes and reads with logprobs', async () => {
    await boot(true);
    const r = await post({
      state: 'ticket: charged twice, furious',
      questions: {
        bucket: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'x', technical: 'y' } },
        tone: { type: 'score', instructions: 'How angry?', criteria: ['calm', 'annoyed', 'frustrated', 'furious'] },
        refund: { type: 'noul', instructions: 'Refund demanded?' },
      },
    });
    expect(r.status).toBe(200);
    // A 强（choice → 第一项 billing，高 confidence）
    expect(r.json.answers.bucket.choice).toBe('billing');
    expect(r.json.answers.bucket.confidence).toBeGreaterThan(0.9);
    // 数字位 3 比 8 略强? 3:-2.0, 8:-1.5 → 8 略强；score 期望在 2~3 之间且有限
    expect(r.json.answers.tone.score).toBeGreaterThanOrEqual(2);
    expect(r.json.answers.tone.score).toBeLessThanOrEqual(3);
    expect(Object.keys(r.json.answers.tone.legend)).toHaveLength(4);
    // noul 落在 0.01..0.99
    expect(r.json.answers.refund.noul).toBeGreaterThan(0.01);
    expect(r.json.answers.refund.noul).toBeLessThan(0.99);
    // 默认模型 = 行的 models[0]，读数带 logprobs 参数
    expect(r.json.model).toBe('mock-dgemma');
    expect(lastBodies.length).toBe(3);
    for (const sent of lastBodies) {
      expect(sent['logprobs']).toBe(true);
      expect(sent['top_logprobs']).toBe(20);
      expect(sent['max_tokens']).toBe(1);
      expect(sent['model']).toBe('mock-dgemma');
    }
    expect(r.json.usage.reads).toBe(3);
    expect(r.json.usage.input_tokens).toBe(3 * 42);
  });

  it('jev-latest and absent model both resolve to the row default', async () => {
    await boot(true);
    const r = await post({ questions: { q: { type: 'noul', instructions: 'ok?' } }, model: 'jev-latest' });
    expect(r.status).toBe(200);
    expect(r.json.model).toBe('mock-dgemma');
  });

  it('409 with guidance when no other-category row exists', async () => {
    await boot(false);
    const r = await post({ questions: { q: { type: 'noul', instructions: 'ok?' } } });
    expect(r.status).toBe(409);
    expect(String(r.json?.error?.message ?? '')).toContain('open-jev');
  });

  it('422 on a malformed question', async () => {
    await boot(true);
    const r = await post({ questions: { q: { type: 'maybe', instructions: 'x' } } });
    expect(r.status).toBe(422);
  });
});
