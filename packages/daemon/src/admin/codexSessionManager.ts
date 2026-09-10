/**
 * Codex session discovery and provider migration.
 *
 * Codex stores the human-readable rollout in JSONL files and keeps the index
 * used by `codex resume` in state_5.sqlite.  These two stores must move
 * together: changing only one of them makes a session either appear under the
 * wrong provider or disappear from resume entirely.
 *
 * This module deliberately exposes metadata only.  It never returns a JSONL
 * line, prompt, tool output, or response body to the admin API.
 */

import { homedir } from 'node:os';
import { basename, join, resolve, win32 } from 'node:path';
import {
  copyFile,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

const PROVIDER_PROPERTY_NAMES = new Set(['model_provider', 'model_provider_id']);
const FIRST_LINE_LIMIT = 4 * 1024 * 1024;
const PROVIDER_ID_LIMIT = 256;

type SqliteModule = typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;
type SqliteRow = Record<string, unknown>;

export interface CodexSessionManagerOptions {
  /** Defaults to CODEX_HOME or the current user's `.codex` directory. */
  codexHome?: string;
  /** Defaults to `<codexHome>/state_5.sqlite`. */
  stateDatabasePath?: string;
}

export interface CodexStateDatabaseStatus {
  path: string;
  available: boolean;
  reason?: string;
}

export type CodexSessionStatus = 'ready' | 'missing_rollout' | 'unreadable_rollout';

export interface CodexSessionSummary {
  id: string;
  cwd: string;
  rolloutPath: string;
  provider: string | null;
  /** Provider from the JSONL session_meta record, when available. */
  jsonlProvider: string | null;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  fileSize: number | null;
  fileModifiedAt: string | null;
  status: CodexSessionStatus;
  /** True when the session has a row in state_5.sqlite. */
  inStateDatabase: boolean;
}

export interface CodexSessionListResult {
  projectPath: string;
  codexHome: string;
  stateDatabase: CodexStateDatabaseStatus;
  sessions: CodexSessionSummary[];
  warnings: string[];
}

export interface CodexSessionProviderPlan {
  id: string;
  provider: string | null;
  model: string | null;
  rolloutPath: string;
  status: CodexSessionStatus | 'blocked';
  /** All provider values found in structured JSON properties. */
  providers: string[];
  /** Number of structured provider properties matching fromProvider. */
  matchingFields: number;
  /** Number of structured provider properties that would change. */
  changedFields: number;
  sqliteWillUpdate: boolean;
  action: 'update' | 'no_change' | 'blocked';
  reason?: string;
}

export interface CodexSessionProviderPreview {
  projectPath: string;
  fromProvider: string | null;
  toProvider: string;
  stateDatabase: CodexStateDatabaseStatus;
  sessions: CodexSessionProviderPlan[];
  warnings: string[];
}

export interface ApplyCodexSessionProviderInput {
  projectPath: string;
  sessionIds: string[];
  toProvider: string;
  fromProvider?: string;
}

export interface CodexSessionProviderApplyResult {
  ok: true;
  projectPath: string;
  fromProvider: string | null;
  toProvider: string;
  updatedSessions: number;
  jsonlFiles: number;
  jsonlFields: number;
  sqliteRows: number;
  backups: string[];
}

interface SessionFileRecord {
  id: string;
  filePath: string;
  cwd: string | null;
  jsonlProvider: string | null;
  timestamp: string | null;
  size: number;
  mtimeMs: number;
  status: Extract<CodexSessionStatus, 'ready' | 'unreadable_rollout'>;
}

interface StateThreadRow {
  id: string;
  rolloutPath: string;
  cwd: string;
  modelProvider: string;
  model: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface StateReadResult {
  status: CodexStateDatabaseStatus;
  rows: StateThreadRow[];
}

interface FileProviderInspection {
  transformedText: string;
  providers: string[];
  matchingFields: number;
  changedFields: number;
}

interface PlannedFileChange {
  id: string;
  filePath: string;
  before: { size: number; mtimeMs: number };
  transformedText: string;
  changedFields: number;
}

export class CodexSessionManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexSessionManagerError';
  }
}

/**
 * The manager serializes mutations in one daemon process.  This does not try
 * to lock Codex itself; the file snapshot check below still refuses to replace
 * a rollout that changed while it was being prepared.
 */
export class CodexSessionManager {
  readonly codexHome: string;
  readonly stateDatabasePath: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: CodexSessionManagerOptions = {}) {
    const configuredHome = options.codexHome?.trim() || process.env['CODEX_HOME']?.trim();
    this.codexHome = configuredHome || join(homedir(), '.codex');
    this.stateDatabasePath = options.stateDatabasePath?.trim() || join(this.codexHome, 'state_5.sqlite');
  }

  async list(projectPath: string): Promise<CodexSessionListResult> {
    const project = await validateProjectPath(projectPath);
    const [files, state] = await Promise.all([
      scanSessionFiles(join(this.codexHome, 'sessions')),
      readStateThreads(this.stateDatabasePath),
    ]);
    return mergeSessionMetadata(project.displayPath, this.codexHome, files, state);
  }

  async preview(
    input: Omit<ApplyCodexSessionProviderInput, 'toProvider'> & { toProvider: string },
  ): Promise<CodexSessionProviderPreview> {
    const normalized = normalizeApplyInput(input);
    const project = await validateProjectPath(normalized.projectPath);
    const [files, state] = await Promise.all([
      scanSessionFiles(join(this.codexHome, 'sessions')),
      readStateThreads(this.stateDatabasePath),
    ]);
    const snapshot = mergeSessionMetadata(project.displayPath, this.codexHome, files, state);
    const plans = await buildProviderPlans(normalized, snapshot, state.rows);
    return {
      projectPath: project.displayPath,
      fromProvider: normalized.fromProvider ?? null,
      toProvider: normalized.toProvider,
      stateDatabase: state.status,
      sessions: plans,
      warnings: snapshot.warnings,
    };
  }

  async apply(input: ApplyCodexSessionProviderInput): Promise<CodexSessionProviderApplyResult> {
    return this.withMutationLock(() => this.applyLocked(input));
  }

  private async applyLocked(input: ApplyCodexSessionProviderInput): Promise<CodexSessionProviderApplyResult> {
    const normalized = normalizeApplyInput(input);
    const project = await validateProjectPath(normalized.projectPath);
    const [files, state] = await Promise.all([
      scanSessionFiles(join(this.codexHome, 'sessions')),
      readStateThreads(this.stateDatabasePath),
    ]);

    if (!state.status.available) {
      throw new CodexSessionManagerError(
        state.status.reason || `Codex state database is unavailable: ${state.status.path}`,
      );
    }

    const snapshot = mergeSessionMetadata(project.displayPath, this.codexHome, files, state);
    const plans = await buildProviderPlans(normalized, snapshot, state.rows);
    const selected = plans.filter((plan) => plan.action !== 'no_change');
    const blocked = selected.filter((plan) => plan.action === 'blocked');
    if (blocked.length > 0) {
      const details = blocked.map((plan) => `${plan.id}: ${plan.reason || 'blocked'}`).join('; ');
      throw new CodexSessionManagerError(`cannot update selected Codex sessions: ${details}`);
    }
    if (selected.length === 0) {
      return {
        ok: true,
        projectPath: project.displayPath,
        fromProvider: normalized.fromProvider ?? null,
        toProvider: normalized.toProvider,
        updatedSessions: 0,
        jsonlFiles: 0,
        jsonlFields: 0,
        sqliteRows: 0,
        backups: [],
      };
    }

    const fileChanges: PlannedFileChange[] = [];
    for (const plan of selected) {
      const file = files.get(plan.id);
      if (!file || file.status !== 'ready') {
        throw new CodexSessionManagerError(
          `rollout for session '${plan.id}' is unavailable; no files were changed`,
        );
      }
      const before = await snapshotFile(file.filePath);
      const inspection = await inspectAndTransformFile(file.filePath, normalized.fromProvider, normalized.toProvider);
      const after = await snapshotFile(file.filePath);
      if (!sameFileSnapshot(before, after)) {
        throw new CodexSessionManagerError(
          `rollout '${file.filePath}' changed while it was being read; no files were changed`,
        );
      }
      if (inspection.changedFields > 0) {
        fileChanges.push({
          id: plan.id,
          filePath: file.filePath,
          before,
          transformedText: inspection.transformedText,
          changedFields: inspection.changedFields,
        });
      }
    }

    const stateRowsById = new Map(state.rows.map((row) => [row.id, row]));
    const dbChanges = plans
      .filter((plan) => plan.action === 'update')
      .map((plan) => stateRowsById.get(plan.id))
      .filter((row): row is StateThreadRow => {
        if (!row) return false;
        if (normalized.fromProvider && row.modelProvider !== normalized.fromProvider) return false;
        return row.modelProvider !== normalized.toProvider;
      });

    const temporaryFiles: string[] = [];
    const backups: string[] = [];
    let database: DatabaseSync | undefined;
    let committed = false;
    try {
      for (const change of fileChanges) {
        const tempPath = `${change.filePath}.provider-switch-${randomUUID()}.tmp`;
        await writeFile(tempPath, change.transformedText, 'utf8');
        temporaryFiles.push(tempPath);
      }

      if (dbChanges.length > 0) {
        const sqlite = await loadSqlite();
        database = openDatabase(sqlite, this.stateDatabasePath, false);
        const databaseBackup = await createDatabaseBackup(sqlite, database, this.stateDatabasePath);
        backups.push(databaseBackup);
        database.exec('BEGIN IMMEDIATE');
        assertDatabaseRowsUnchanged(database, dbChanges);
      }

      for (let index = 0; index < fileChanges.length; index += 1) {
        const change = fileChanges[index];
        const tempPath = temporaryFiles[index];
        const current = await snapshotFile(change.filePath);
        if (!sameFileSnapshot(change.before, current)) {
          throw new CodexSessionManagerError(
            `rollout '${change.filePath}' changed before replacement; no files were changed`,
          );
        }
        const backupPath = await createUniqueBackupPath(change.filePath);
        await copyFile(change.filePath, backupPath);
        backups.push(backupPath);
        await replaceFileAtomically(tempPath, change.filePath);
        temporaryFiles[index] = '';
      }

      if (database && dbChanges.length > 0) {
        const update = database.prepare('UPDATE threads SET model_provider = ? WHERE id = ?');
        for (const row of dbChanges) update.run(normalized.toProvider, row.id);
        database.exec('COMMIT');
        committed = true;
      } else {
        committed = true;
      }

      return {
        ok: true,
        projectPath: project.displayPath,
        fromProvider: normalized.fromProvider ?? null,
        toProvider: normalized.toProvider,
        updatedSessions: new Set([...fileChanges.map((change) => change.id), ...dbChanges.map((row) => row.id)]).size,
        jsonlFiles: fileChanges.length,
        jsonlFields: fileChanges.reduce((total, change) => total + change.changedFields, 0),
        sqliteRows: dbChanges.length,
        backups,
      };
    } catch (error) {
      if (database?.isTransaction) {
        try {
          database.exec('ROLLBACK');
        } catch {
          // The original error is more useful to the caller; restoration below
          // still attempts to recover the JSONL files.
        }
      }
      if (!committed) {
        try {
          await restoreBackups(backups.filter((path) => /\.jsonl\.provider-switch-[^/\\]+\.bak$/iu.test(path)));
        } catch (restoreError) {
          const original = error instanceof Error ? error.message : String(error);
          const restoration = restoreError instanceof Error ? restoreError.message : String(restoreError);
          throw new CodexSessionManagerError(
            `${original}; JSONL restoration also failed: ${restoration}`,
          );
        }
      }
      throw error;
    } finally {
      if (database?.isOpen) database.close();
      for (const tempPath of temporaryFiles) {
        if (!tempPath) continue;
        await unlinkIfPresent(tempPath);
      }
    }
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function normalizeApplyInput(input: ApplyCodexSessionProviderInput): ApplyCodexSessionProviderInput & {
  fromProvider?: string;
} {
  const projectPath = typeof input.projectPath === 'string' ? input.projectPath.trim() : '';
  const toProvider = typeof input.toProvider === 'string' ? input.toProvider.trim() : '';
  const fromProvider = typeof input.fromProvider === 'string' ? input.fromProvider.trim() : undefined;
  if (!projectPath) throw new CodexSessionManagerError('projectPath must be a non-empty string');
  validateProviderId(toProvider, 'toProvider');
  if (fromProvider) validateProviderId(fromProvider, 'fromProvider');
  if (!Array.isArray(input.sessionIds) || input.sessionIds.length === 0) {
    throw new CodexSessionManagerError('sessionIds must contain at least one session id');
  }
  const sessionIds = [
    ...new Set(
      input.sessionIds
        .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id) => id.trim()),
    ),
  ];
  if (sessionIds.length === 0) throw new CodexSessionManagerError('sessionIds must contain at least one session id');
  if (sessionIds.length > 10_000) throw new CodexSessionManagerError('too many sessionIds');
  return { projectPath, sessionIds, toProvider, ...(fromProvider ? { fromProvider } : {}) };
}

function validateProviderId(value: string, name: string): void {
  if (!value) throw new CodexSessionManagerError(`${name} must be a non-empty string`);
  if (value.length > PROVIDER_ID_LIMIT || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CodexSessionManagerError(`${name} is invalid`);
  }
}

async function validateProjectPath(projectPath: string): Promise<{ displayPath: string }> {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new CodexSessionManagerError('projectPath must be a non-empty string');
  }
  const displayPath = resolve(projectPath.trim());
  let info;
  try {
    info = await stat(displayPath);
  } catch {
    throw new CodexSessionManagerError(`project path does not exist: ${displayPath}`);
  }
  if (!info.isDirectory()) throw new CodexSessionManagerError(`project path is not a directory: ${displayPath}`);
  return { displayPath };
}

async function scanSessionFiles(sessionsRoot: string): Promise<Map<string, SessionFileRecord>> {
  const files = await collectJsonlFiles(sessionsRoot);
  const records = new Map<string, SessionFileRecord>();
  for (const filePath of files) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
      const firstLine = await readFirstLine(filePath);
      const parsed = parseSessionMetadata(firstLine, filePath);
      if (!parsed.id) continue;
      const record: SessionFileRecord = {
        id: parsed.id,
        filePath,
        cwd: parsed.cwd,
        jsonlProvider: parsed.provider,
        timestamp: parsed.timestamp,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        status: 'ready',
      };
      const existing = records.get(record.id);
      if (!existing || record.mtimeMs > existing.mtimeMs) records.set(record.id, record);
    } catch {
      const id = sessionIdFromRolloutPath(filePath);
      if (!id) continue;
      let fallbackStat;
      try {
        fallbackStat = await stat(filePath);
      } catch {
        continue;
      }
      const existing = records.get(id);
      if (!existing || fallbackStat.mtimeMs > existing.mtimeMs) {
        records.set(id, {
          id,
          filePath,
          cwd: null,
          jsonlProvider: null,
          timestamp: null,
          size: fallbackStat.size,
          mtimeMs: fallbackStat.mtimeMs,
          status: 'unreadable_rollout',
        });
      }
    }
  }
  return records;
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) result.push(fullPath);
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await open(filePath, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < FIRST_LINE_LIMIT) {
      const chunk = Buffer.allocUnsafe(Math.min(128 * 1024, FIRST_LINE_LIMIT - total));
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      const used = chunk.subarray(0, result.bytesRead);
      const lineEnd = findLineEnd(used);
      if (lineEnd >= 0) {
        chunks.push(used.subarray(0, lineEnd));
        return decodeUtf8(Buffer.concat(chunks));
      }
      chunks.push(used);
      total += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
    if (total > 0 && total < FIRST_LINE_LIMIT) return decodeUtf8(Buffer.concat(chunks));
    throw new CodexSessionManagerError(`session metadata line is too large or incomplete: ${filePath}`);
}

function findLineEnd(buffer: Buffer): number {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a || buffer[index] === 0x0d) return index;
  }
  return -1;
}

function parseSessionMetadata(line: string, filePath: string): {
  id: string | null;
  cwd: string | null;
  provider: string | null;
  timestamp: string | null;
} {
  const value = JSON.parse(line.replace(/^\uFEFF/u, '')) as unknown;
  if (!isRecord(value)) throw new Error('metadata is not an object');
  const payload = isRecord(value['payload']) ? value['payload'] : {};
  const id = firstString(payload['session_id'], payload['id']) || sessionIdFromRolloutPath(filePath);
  return {
    id,
    cwd: firstString(payload['cwd']),
    provider: firstString(payload['model_provider']),
    timestamp: firstString(payload['timestamp']) || firstString(value['timestamp']),
  };
}

function sessionIdFromRolloutPath(filePath: string): string | null {
  const match = basename(filePath).match(/([0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12})\.jsonl$/iu);
  return match?.[1] ?? null;
}

async function readStateThreads(databasePath: string): Promise<StateReadResult> {
  const unavailable = (reason: string): StateReadResult => ({
    status: { path: databasePath, available: false, reason },
    rows: [],
  });
  if (!existsSync(databasePath)) return unavailable(`Codex state database not found: ${databasePath}`);
  let sqlite: SqliteModule;
  try {
    sqlite = await loadSqlite();
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(sqlite, databasePath, true);
    const columns = new Set(
      (database.prepare("PRAGMA table_info('threads')").all() as SqliteRow[])
        .map((row) => String(row['name'] ?? '')),
    );
    for (const required of ['id', 'rollout_path', 'cwd', 'model_provider']) {
      if (!columns.has(required)) return unavailable(`state_5.sqlite is missing threads.${required}`);
    }
    const selected = ['id', 'rollout_path', 'cwd', 'model_provider', 'model', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms']
      .filter((column) => columns.has(column));
    const rows = database.prepare(`SELECT ${selected.join(', ')} FROM threads`).all() as SqliteRow[];
    return {
      status: { path: databasePath, available: true },
      rows: rows.map(toStateThreadRow),
    };
  } catch (error) {
    return unavailable(`could not read Codex state database: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (database?.isOpen) database.close();
  }
}

async function loadSqlite(): Promise<SqliteModule> {
  try {
    return await import('node:sqlite');
  } catch {
    throw new CodexSessionManagerError(
      'Codex session SQLite support requires Node.js 22.16 or newer (node:sqlite)',
    );
  }
}

function openDatabase(sqlite: SqliteModule, databasePath: string, readOnly: boolean): DatabaseSync {
  const database = new sqlite.DatabaseSync(databasePath, { readOnly, timeout: 5_000 });
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

function toStateThreadRow(row: SqliteRow): StateThreadRow {
  return {
    id: String(row['id'] ?? ''),
    rolloutPath: String(row['rollout_path'] ?? ''),
    cwd: String(row['cwd'] ?? ''),
    modelProvider: String(row['model_provider'] ?? ''),
    model: row['model'] == null ? null : String(row['model']),
    createdAt: timestampFromSqlite(row['created_at_ms'] ?? row['created_at']),
    updatedAt: timestampFromSqlite(row['updated_at_ms'] ?? row['updated_at']),
  };
}

function timestampFromSqlite(value: unknown): string | null {
  const numeric = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mergeSessionMetadata(
  projectPath: string,
  codexHome: string,
  files: Map<string, SessionFileRecord>,
  state: StateReadResult,
): CodexSessionListResult {
  const stateRows = new Map(state.rows.map((row) => [row.id, row]));
  const ids = new Set<string>();
  for (const [id, file] of files) {
    if (file.cwd && isPathInside(projectPath, file.cwd)) ids.add(id);
  }
  for (const row of state.rows) {
    if (isPathInside(projectPath, row.cwd)) ids.add(row.id);
  }

  const sessions: CodexSessionSummary[] = [];
  for (const id of ids) {
    const file = files.get(id);
    const row = stateRows.get(id);
    const cwd = row?.cwd || file?.cwd || projectPath;
    if (!isPathInside(projectPath, cwd)) continue;
    // Prefer the path discovered under CODEX_HOME. SQLite can retain an old
    // spelling (for example, a `\\?\`-prefixed Windows path) while the actual
    // rollout file is still the same session.
    const rolloutPath = file?.filePath || row?.rolloutPath || '';
    const provider = row?.modelProvider || file?.jsonlProvider || null;
    sessions.push({
      id,
      cwd,
      rolloutPath,
      provider,
      jsonlProvider: file?.jsonlProvider ?? null,
      model: row?.model ?? null,
      createdAt: row?.createdAt ?? file?.timestamp ?? null,
      updatedAt: row?.updatedAt ?? (file ? new Date(file.mtimeMs).toISOString() : null),
      fileSize: file?.size ?? null,
      fileModifiedAt: file ? new Date(file.mtimeMs).toISOString() : null,
      status: file?.status ?? 'missing_rollout',
      inStateDatabase: Boolean(row),
    });
  }
  sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const warnings: string[] = [];
  if (!state.status.available) warnings.push(state.status.reason || 'state database unavailable');
  return { projectPath, codexHome, stateDatabase: state.status, sessions, warnings };
}

async function buildProviderPlans(
  input: ApplyCodexSessionProviderInput & { fromProvider?: string },
  snapshot: CodexSessionListResult,
  stateRows: StateThreadRow[],
): Promise<CodexSessionProviderPlan[]> {
  const byId = new Map(snapshot.sessions.map((session) => [session.id, session]));
  const stateById = new Map(stateRows.map((row) => [row.id, row]));
  const plans: CodexSessionProviderPlan[] = [];
  for (const id of input.sessionIds) {
    const session = byId.get(id);
    const row = stateById.get(id);
    if (!session) {
      plans.push({
        id,
        provider: null,
        model: null,
        rolloutPath: '',
        status: 'blocked',
        providers: [],
        matchingFields: 0,
        changedFields: 0,
        sqliteWillUpdate: false,
        action: 'blocked',
        reason: 'session is not associated with the requested project',
      });
      continue;
    }
    if (session.status !== 'ready') {
      plans.push({
        id,
        provider: session.provider,
        model: session.model,
        rolloutPath: session.rolloutPath,
        status: session.status,
        providers: [],
        matchingFields: 0,
        changedFields: 0,
        sqliteWillUpdate: false,
        action: 'blocked',
        reason: 'rollout file is missing or unreadable',
      });
      continue;
    }
    // Prefer the path discovered under CODEX_HOME.  SQLite can retain an old
    // spelling (for example, a `\\?\`-prefixed Windows path) while the actual
    // rollout file is still the same session.
    const inspection = await inspectAndTransformFile(session.rolloutPath, input.fromProvider, input.toProvider);
    const sqliteWillUpdate = Boolean(
      row &&
      (!input.fromProvider || row.modelProvider === input.fromProvider) &&
      row.modelProvider !== input.toProvider,
    );
    const changed = inspection.changedFields > 0 || sqliteWillUpdate;
    plans.push({
      id,
      provider: session.provider,
      model: session.model,
      rolloutPath: session.rolloutPath,
      status: 'ready',
      providers: inspection.providers,
      matchingFields: inspection.matchingFields,
      changedFields: inspection.changedFields,
      sqliteWillUpdate,
      action: changed ? 'update' : 'no_change',
    });
  }
  return plans;
}

async function inspectAndTransformFile(
  filePath: string,
  fromProvider: string | undefined,
  toProvider: string,
): Promise<FileProviderInspection> {
  const bytes = await readFile(filePath);
  const originalText = decodeUtf8(bytes);
  const parts = originalText.split(/(\r\n|\n|\r)/u);
  const providers = new Set<string>();
  let matchingFields = 0;
  let changedFields = 0;
  const hasBom = parts[0].startsWith('\uFEFF');

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.replace(index === 0 ? /^\uFEFF/u : /^/u, '')) as unknown;
    } catch (error) {
      throw new CodexSessionManagerError(
        `invalid JSONL at ${filePath}:${Math.floor(index / 2) + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = replaceStructuredProviderFields(value, fromProvider, toProvider, providers);
    matchingFields += result.matchingFields;
    changedFields += result.changedFields;
    if (result.changedFields > 0) {
      parts[index] = `${index === 0 && hasBom ? '\uFEFF' : ''}${JSON.stringify(value)}`;
    }
  }

  return {
    transformedText: parts.join(''),
    providers: [...providers].sort(),
    matchingFields,
    changedFields,
  };
}

export function replaceStructuredProviderFields(
  value: unknown,
  fromProvider: string | undefined,
  toProvider: string,
  providers = new Set<string>(),
): { matchingFields: number; changedFields: number } {
  let matchingFields = 0;
  let changedFields = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (PROVIDER_PROPERTY_NAMES.has(key) && typeof child === 'string') {
        providers.add(child);
        if (!fromProvider || child === fromProvider) {
          matchingFields += 1;
          if (child !== toProvider) {
            node[key] = toProvider;
            changedFields += 1;
          }
        }
      }
      visit(node[key]);
    }
  };
  visit(value);
  return { matchingFields, changedFields };
}

async function snapshotFile(filePath: string): Promise<{ size: number; mtimeMs: number }> {
  const info = await stat(filePath);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

function sameFileSnapshot(
  a: { size: number; mtimeMs: number },
  b: { size: number; mtimeMs: number },
): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function createUniqueBackupPath(filePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[.:]/gu, '-');
  let candidate = `${filePath}.provider-switch-${stamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${filePath}.provider-switch-${stamp}-${suffix}.bak`;
    suffix += 1;
  }
  return candidate;
}

async function createDatabaseBackup(
  sqlite: SqliteModule,
  database: DatabaseSync,
  databasePath: string,
): Promise<string> {
  const backupPath = await createUniqueBackupPath(databasePath);
  if (typeof sqlite.backup !== 'function') {
    throw new CodexSessionManagerError(
      'Codex session updates require the node:sqlite backup API (Node.js 22.16 or newer)',
    );
  }
  await sqlite.backup(database, backupPath);
  return backupPath;
}

function assertDatabaseRowsUnchanged(database: DatabaseSync, rows: StateThreadRow[]): void {
  const read = database.prepare('SELECT model_provider FROM threads WHERE id = ?');
  for (const row of rows) {
    const current = read.get(row.id) as SqliteRow | undefined;
    if (!current || String(current['model_provider'] ?? '') !== row.modelProvider) {
      throw new CodexSessionManagerError(
        `SQLite session '${row.id}' changed while the update was prepared; no files were changed`,
      );
    }
  }
}

async function replaceFileAtomically(tempPath: string, targetPath: string): Promise<void> {
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    // Node maps the Windows replace operation differently across versions.  A
    // same-directory rename is atomic where supported; the copy fallback is
    // only used when Windows refuses to replace an existing destination.
    if (process.platform !== 'win32') throw error;
    await copyFile(tempPath, targetPath);
    await unlinkIfPresent(tempPath);
  }
}

async function restoreBackups(backupPaths: string[]): Promise<void> {
  for (const backupPath of backupPaths.reverse()) {
    if (!existsSync(backupPath)) continue;
    const targetPath = backupPath.replace(/\.provider-switch-[^.]+(?:-[0-9]+)?\.bak$/u, '');
    if (targetPath === backupPath) continue;
    const tempPath = `${targetPath}.provider-restore-${randomUUID()}.tmp`;
    try {
      await copyFile(backupPath, tempPath);
      await replaceFileAtomically(tempPath, targetPath);
    } finally {
      await unlinkIfPresent(tempPath);
    }
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // best effort cleanup
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CodexSessionManagerError('Codex session contains invalid UTF-8');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return null;
}

function normalizeComparablePath(value: string): string {
  const stripped = value.trim().replace(/^\\\\\?\\/u, '');
  if (process.platform === 'win32') {
    const normalized = win32.normalize(stripped).replace(/[\\/]+$/u, '');
    return normalized.toLowerCase();
  }
  return stripped.replace(/\/+$/u, '') || '/';
}

function isPathInside(projectPath: string, candidatePath: string): boolean {
  const project = normalizeComparablePath(projectPath);
  const candidate = normalizeComparablePath(candidatePath);
  if (project === candidate) return true;
  const separator = process.platform === 'win32' ? '\\' : '/';
  return candidate.startsWith(`${project}${separator}`);
}
