/**
 * connection.ts — a small raw CDP client bound to the user's own Chrome.
 *
 * One browser-scoped WebSocket (`/devtools/browser` or the DevToolsActivePort
 * path), flattened per-target sessions, and a Fetch-domain guard that fails
 * page attempts to probe the local debug port (anti-detection parity with the
 * chrome-use proxy). All page work goes through `attach()`, which yields a
 * `CdpTarget` with evaluate/navigate/input helpers.
 *
 * Reconnect policy: the connection is re-discovered and re-opened lazily on
 * demand after a close; attached session state is dropped on close.
 *
 * @module @omnicross/chatgpt-web/cdp/connection
 */

import {
  browserWebSocketUrl,
  discoverChromeEndpoint,
  type DiscoveredChromeEndpoint,
} from './discovery';
import { openCdpWebSocket, WS_OPEN, type CdpWebSocket } from './websocket';
import { CdpTarget } from './target';

export interface CdpConnectionOptions {
  /** Explicit debug port; skips discovery when it answers a TCP probe. */
  explicitPort?: number;
  /**
   * Fully explicit endpoint (dedicated browser host, e.g. our Electron
   * child): connect straight to this port+wsPath, no discovery at all.
   */
  endpoint?: { port: number; wsPath: string | null };
  /** Per-command timeout (default 30s). */
  commandTimeoutMs?: number;
}

interface PendingCommand {
  resolve: (value: CdpCommandResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CdpCommandResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string; data?: unknown };
}

interface CdpEvent {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpConnectionError extends Error {
  constructor(
    message: string,
    readonly guidance?: string,
  ) {
    super(message);
    this.name = 'CdpConnectionError';
  }
}

export const CHROME_DEBUG_SETUP_GUIDANCE =
  'Open chrome://inspect/#remote-debugging in your Chrome, enable ' +
  '"Allow remote debugging for this browser instance" (a restart may be required), ' +
  'then retry. Alternatively start Chrome with --remote-debugging-port=9222.';

/** One live connection to the user's Chrome over the CDP WebSocket. */
export class CdpConnection {
  private socket: CdpWebSocket | null = null;
  private endpoint: DiscoveredChromeEndpoint | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly sessions = new Map<string, string>(); // targetId -> sessionId
  private readonly guardedSessions = new Set<string>();
  private connecting: Promise<void> | null = null;
  private closedByUser = false;

  constructor(private readonly options: CdpConnectionOptions = {}) {}

  /** Human-readable endpoint description for diagnostics. */
  describeEndpoint(): string {
    return this.endpoint ? `127.0.0.1:${this.endpoint.port}` : '<not connected>';
  }

  /** Ensure a live browser WebSocket, (re)discovering the endpoint on demand. */
  async ensureConnected(): Promise<void> {
    if (this.socket && this.socket.readyState === WS_OPEN) return;
    if (this.closedByUser) throw new CdpConnectionError('CdpConnection was closed');
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const endpoint = this.options.endpoint
      ? { port: this.options.endpoint.port, wsPath: this.options.endpoint.wsPath }
      : await discoverChromeEndpoint({ explicitPort: this.options.explicitPort });
    if (!endpoint) {
      throw new CdpConnectionError(
        'Chrome remote debugging is not reachable (no DevToolsActivePort file and no debug port answering).',
        CHROME_DEBUG_SETUP_GUIDANCE,
      );
    }
    const socket = await openCdpWebSocket(browserWebSocketUrl(endpoint));
    socket.onMessage((data) => this.handleMessage(data));
    socket.onClose(() => this.handleClose());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpConnectionError(`Chrome CDP WebSocket timed out opening on port ${endpoint.port}`));
      }, 15_000);
      socket.onError((message) => {
        clearTimeout(timer);
        reject(new CdpConnectionError(`Chrome CDP WebSocket failed: ${message}`, CHROME_DEBUG_SETUP_GUIDANCE));
      });
      socket.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.endpoint = endpoint;
    this.socket = socket;
  }

  private handleMessage(data: string): void {
    let message: CdpEvent;
    try {
      message = JSON.parse(data) as CdpEvent;
    } catch {
      return;
    }
    if (message.method === 'Target.attachedToTarget' && message.params) {
      const { sessionId, targetInfo } = message.params as { sessionId?: string; targetInfo?: { targetId?: string } };
      if (sessionId && targetInfo?.targetId) {
        this.sessions.set(targetInfo.targetId, sessionId);
      }
      return;
    }
    if (message.method === 'Fetch.requestPaused' && message.params) {
      const { requestId, sessionId } = message.params as { requestId?: string; sessionId?: string };
      if (requestId) {
        void this.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sessionId).catch(
          () => undefined,
        );
      }
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message as CdpCommandResponse);
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.endpoint = null;
    this.sessions.clear();
    this.guardedSessions.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpConnectionError('Chrome CDP WebSocket closed'));
    }
    this.pending.clear();
  }

  /** Send one CDP command; resolves with the raw response envelope. */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<CdpCommandResponse> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket) throw new CdpConnectionError('Chrome CDP WebSocket is not open');
    const id = ++this.nextId;
    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    return new Promise<CdpCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload['sessionId'] = sessionId;
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Send one command and require a non-error result. */
  async sendOk(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const response = await this.send(method, params, sessionId);
    if (response.error) {
      throw new Error(`CDP ${method} failed: ${response.error.message ?? JSON.stringify(response.error)}`);
    }
    return response.result ?? {};
  }

  /** Create a background tab and return its attached target handle. */
  async openTab(url: string): Promise<CdpTarget> {
    await this.ensureConnected();
    const created = await this.sendOk('Target.createTarget', { url, background: true });
    const targetId = created['targetId'];
    if (typeof targetId !== 'string') throw new Error('Target.createTarget returned no targetId');
    return this.attach(targetId);
  }

  /** Attach to a page target, installing the debug-port Fetch guard. */
  async attach(targetId: string): Promise<CdpTarget> {
    await this.ensureConnected();
    let sessionId = this.sessions.get(targetId);
    if (!sessionId) {
      const attached = await this.sendOk('Target.attachToTarget', { targetId, flatten: true });
      sessionId = (attached['sessionId'] as string | undefined) ?? this.sessions.get(targetId);
      if (!sessionId) throw new Error(`Failed to attach to target ${targetId}`);
    }
    if (this.endpoint && !this.guardedSessions.has(sessionId)) {
      this.guardedSessions.add(sessionId);
      const port = this.endpoint.port;
      try {
        await this.sendOk(
          'Fetch.enable',
          {
            patterns: [
              { urlPattern: `http://127.0.0.1:${port}/*`, requestStage: 'Request' },
              { urlPattern: `http://localhost:${port}/*`, requestStage: 'Request' },
            ],
          },
          sessionId,
        );
      } catch {
        this.guardedSessions.delete(sessionId);
        // The guard is best-effort; page functionality continues without it.
      }
    }
    return new CdpTarget(this, targetId, sessionId!);
  }

  /** Close a target tab, ignoring errors for already-closed tabs. */
  async closeTab(targetId: string): Promise<void> {
    this.sessions.delete(targetId);
    try {
      await this.sendOk('Target.closeTarget', { targetId });
    } catch {
      // Tab already gone.
    }
  }

  /** List current page targets. */
  async listTargets(): Promise<Array<{ targetId: string; url: string; title: string }>> {
    const result = await this.sendOk('Target.getTargets');
    const infos = (result['targetInfos'] as Array<Record<string, unknown>>) ?? [];
    return infos
      .filter((info) => info['type'] === 'page')
      .map((info) => ({
        targetId: String(info['targetId']),
        url: String(info['url'] ?? ''),
        title: String(info['title'] ?? ''),
      }));
  }

  /** Drop the WebSocket (tabs are left alone). */
  close(): void {
    this.closedByUser = true;
    this.socket?.close();
    this.handleClose();
    this.closedByUser = true;
  }
}
