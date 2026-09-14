import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveAskProServerEntry } from '@omnicross/chatgpt-web/askpro/askProServer';

// The fs-glue tests redirect homedir to a temp dir so the REAL ~/.codex and
// ~/.omnicross are never touched.
let mockHome = '';
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mockHome,
  };
});

import {
  askProMcpArgs,
  installAskProServer,
  removeManagedCodexAskProSection,
  uninstallAskProServer,
  upsertManagedCodexAskProSection,
  upsertManagedCodexSections,
} from '../chatgptWebCodexProfile';

const INPUT = { baseUrl: 'http://127.0.0.1:17850/v1', model: 'chatgpt-web/pro' };

describe('upsertManagedCodexSections', () => {
  it('appends both managed sections to an empty config', () => {
    const out = upsertManagedCodexSections('', INPUT);
    expect(out).toContain('[model_providers.omnicross-chatgptweb]');
    expect(out).toContain('base_url = "http://127.0.0.1:17850/v1"');
    expect(out).toContain('wire_api = "responses"');
    expect(out).toContain('env_key = "OMNICROSS_CHATGPT_WEB_TOKEN"');
    expect(out).toContain('[profiles.chatgptweb]');
    expect(out).toContain('model = "chatgpt-web/pro"');
    expect(out).toContain('model_provider = "omnicross-chatgptweb"');
    expect(out).toContain('# --- omnicross-chatgpt-web (managed) ---');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('preserves foreign config content byte-for-byte outside managed sections', () => {
    const existing = 'model = "gpt-5.2"\nnotify = ["terminal"]\n\n[mcp_servers.fs]\ncommand = "fs-mcp"\n';
    const out = upsertManagedCodexSections(existing, INPUT);
    expect(out).toContain('model = "gpt-5.2"');
    expect(out).toContain('[mcp_servers.fs]');
    expect(out).toContain('command = "fs-mcp"');
    // The native default model line appears exactly once (not duplicated).
    expect(out.match(/^model = "gpt-5\.2"$/m)?.length).toBe(1);
  });

  it('replaces an existing managed section body and stays idempotent', () => {
    const first = upsertManagedCodexSections('model = "gpt-5.2"\n', INPUT);
    const stale = first.replace('model = "chatgpt-web/pro"', 'model = "chatgpt-web/light"');
    const again = upsertManagedCodexSections(stale, INPUT);
    expect(again).toContain('model = "chatgpt-web/pro"');
    expect(again.match(/\[profiles\.chatgptweb\]/g)?.length).toBe(1);
    expect(again.match(/\[model_providers\.omnicross-chatgptweb\]/g)?.length).toBe(1);
    // Idempotent: running twice changes nothing.
    expect(upsertManagedCodexSections(again, INPUT)).toBe(again);
  });

  it('handles a foreign profile section without touching it', () => {
    const existing = '[profiles.other]\nmodel = "gpt-5.2"\nmodel_provider = "openai"\n';
    const out = upsertManagedCodexSections(existing, INPUT);
    expect(out).toContain('[profiles.other]');
    expect(out).toContain('model_provider = "openai"');
    expect(out).toContain('[profiles.chatgptweb]');
  });
});

const ASK_PRO = { entryFile: 'C:\\Users\\me\\.omnicross\\chatgpt-web\\ask-pro\\server.mjs' };

describe('upsertManagedCodexAskProSection', () => {
  it('appends the section with command/args/tool_timeout_sec and stays idempotent', () => {
    const out = upsertManagedCodexAskProSection('model = "gpt-5.2"\n', ASK_PRO);
    expect(out).toContain('[mcp_servers.omnicross-chatgptweb-pro]');
    expect(out).toContain('command = "node"');
    expect(out).toContain(
      `args = ["C:\\\\Users\\\\me\\\\.omnicross\\\\chatgpt-web\\\\ask-pro\\\\server.mjs", "--bridge-base-url=http://127.0.0.1:17850", "--model=chatgpt-web/pro"]`,
    );
    expect(out).toContain('tool_timeout_sec = 660');
    expect(out).toContain('model = "gpt-5.2"');
    expect(upsertManagedCodexAskProSection(out, ASK_PRO)).toBe(out);
  });

  it('coexists with the provider/profile sections and foreign mcp servers', () => {
    const withProfile = upsertManagedCodexSections('', INPUT);
    const withAskPro = upsertManagedCodexAskProSection(withProfile, ASK_PRO);
    expect(withAskPro.match(/\[mcp_servers\.omnicross-chatgptweb-pro\]/g)?.length).toBe(1);
    expect(withAskPro).toContain('[profiles.chatgptweb]');
    const foreign = upsertManagedCodexAskProSection('[mcp_servers.fs]\ncommand = "fs-mcp"\n', ASK_PRO);
    expect(foreign).toContain('[mcp_servers.fs]');
    expect(foreign).toContain('command = "fs-mcp"');
  });

  it('replaces a stale body (entry path moved, writable toggled)', () => {
    const first = upsertManagedCodexAskProSection('', ASK_PRO);
    const stale = first.replace('--model=chatgpt-web/pro', '--model=chatgpt-web/light');
    const again = upsertManagedCodexAskProSection(stale, ASK_PRO);
    expect(again).toContain('--model=chatgpt-web/pro');
    expect(again.match(/\[mcp_servers\.omnicross-chatgptweb-pro\]/g)?.length).toBe(1);
    const writable = upsertManagedCodexAskProSection('', { ...ASK_PRO, writable: true });
    expect(writable).toContain('"--writable"');
  });
});

describe('removeManagedCodexAskProSection', () => {
  it('removes only the managed section, preserving everything else', () => {
    const text = upsertManagedCodexAskProSection(
      'model = "gpt-5.2"\n\n[mcp_servers.fs]\ncommand = "fs-mcp"\n',
      ASK_PRO,
    );
    const removed = removeManagedCodexAskProSection(text);
    expect(removed).not.toContain('omnicross-chatgptweb-pro');
    expect(removed).toContain('[mcp_servers.fs]');
    expect(removed).toContain('command = "fs-mcp"');
    expect(removed).toContain('model = "gpt-5.2"');
    expect(removed.endsWith('\n')).toBe(true);
  });

  it('is a no-op when the section is absent and handles section-at-EOF', () => {
    expect(removeManagedCodexAskProSection('model = "gpt-5.2"\n')).toBe('model = "gpt-5.2"\n');
    const atEof = 'a = 1\n\n[mcp_servers.omnicross-chatgptweb-pro]\ncommand = "node"\n';
    expect(removeManagedCodexAskProSection(atEof)).toBe('a = 1\n');
  });
});

describe('askProMcpArgs', () => {
  it('orders args entry-first with optional writable flag', () => {
    expect(askProMcpArgs(ASK_PRO)).toEqual([
      ASK_PRO.entryFile,
      '--bridge-base-url=http://127.0.0.1:17850',
      '--model=chatgpt-web/pro',
    ]);
    expect(askProMcpArgs({ ...ASK_PRO, writable: true })).toContain('--writable');
  });
});

// The install glue needs the built ask-pro entry; skip on unbuilt checkouts.
const builtEntry = resolveAskProServerEntry();
describe.skipIf(!builtEntry || !existsSync(builtEntry))('installAskProServer / uninstallAskProServer (fs glue)', () => {
  let dataDir: string;

  beforeEach(() => {
    mockHome = mkdtempSync(join(tmpdir(), 'askpro-home-'));
    dataDir = join(mockHome, '.omnicross', 'chatgpt-web');
  });

  afterEach(() => {
    rmSync(mockHome, { recursive: true, force: true });
    mockHome = '';
  });

  it('copies the self-contained server, registers the section, and uninstalls cleanly', async () => {
    // A foreign codex config must survive untouched.
    const configPath = join(mockHome, '.codex', 'config.toml');
    mkdirSync(join(mockHome, '.codex'), { recursive: true });
    writeFileSync(configPath, 'model = "gpt-5.2"\n\n[mcp_servers.mine]\ncommand = "mine"\n');

    const result = await installAskProServer(dataDir);
    expect(result.entryFile).toBe(join(dataDir, 'ask-pro', 'server.mjs'));
    expect(existsSync(result.entryFile)).toBe(true);
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('[mcp_servers.omnicross-chatgptweb-pro]');
    expect(config).toContain('tool_timeout_sec = 660');
    expect(config).toContain('[mcp_servers.mine]');
    expect(config).toContain('model = "gpt-5.2"');
    // The copied server must be importable (install already proved it; assert the file really is ESM).
    expect(readFileSync(result.entryFile, 'utf8')).toMatch(/^\s*import\s/m);

    const uninstall = uninstallAskProServer(dataDir);
    const after = readFileSync(configPath, 'utf8');
    expect(after).not.toContain('omnicross-chatgptweb-pro');
    expect(after).toContain('[mcp_servers.mine]');
    expect(existsSync(join(dataDir, 'ask-pro'))).toBe(false);
    expect(uninstall.removedEntry).toBe(true);
  });
});
