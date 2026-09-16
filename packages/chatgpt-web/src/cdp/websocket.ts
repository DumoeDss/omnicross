/**
 * websocket.ts — minimal WebSocket client shim for the CDP transport.
 *
 * Prefers the runtime's native WebSocket (Node >= 22 / Bun / browsers) and
 * falls back to a lazy `ws` module import. Normalizes both event APIs behind
 * one tiny interface with string-frame semantics only — the CDP wire is text.
 *
 * Adapted from the chrome-use CDP proxy's WebSocket compatibility layer.
 *
 * @module @omnicross/chatgpt-web/cdp/websocket
 */

/// <reference path="../types/untyped-modules.d.ts" />

/** The normalized surface this package needs from a WebSocket client. */
export interface CdpWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onError(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
}

export const WS_OPEN = 1;

type NativeWebSocketCtor = new (url: string) => {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

type WsModuleSocket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
};

let wsModuleCtor: (new (url: string) => WsModuleSocket) | undefined;
let wsModuleAttempted = false;

/** Resolve a WebSocket constructor, native first, `ws` fallback second. */
export async function resolveWebSocketConstructor(): Promise<
  NativeWebSocketCtor | (new (url: string) => WsModuleSocket)
> {
  const native = (globalThis as { WebSocket?: NativeWebSocketCtor }).WebSocket;
  if (typeof native === 'function') return native;
  if (!wsModuleAttempted) {
    wsModuleAttempted = true;
    try {
      const mod = (await import('ws')) as unknown as { default?: new (url: string) => WsModuleSocket };
      wsModuleCtor = mod.default ?? (mod as unknown as new (url: string) => WsModuleSocket);
    } catch {
      wsModuleCtor = undefined;
    }
  }
  if (wsModuleCtor) return wsModuleCtor;
  throw new Error(
    'No WebSocket transport available: this Node runtime has no native WebSocket ' +
      '(Node >= 22 required) and the optional "ws" package is not installed. ' +
      'Upgrade Node or run `npm install ws`.',
  );
}

/** Open a WebSocket and expose the normalized event surface. */
export async function openCdpWebSocket(url: string): Promise<CdpWebSocket> {
  const Ctor = await resolveWebSocketConstructor();
  const socket = new Ctor(url);
  // Both transports carry addEventListener in practice; detect by shape.
  if (typeof (socket as unknown as WebSocketLike).addEventListener === 'function') {
    const native = socket as unknown as WebSocketLike;
    return {
      get readyState() {
        return native.readyState;
      },
      send: (data) => native.send(data),
      close: () => native.close(),
      onOpen(handler) {
        native.addEventListener('open', () => handler());
      },
      onError(handler) {
        native.addEventListener('error', (event) => {
          handler(errorMessage(event));
        });
      },
      onClose(handler) {
        native.addEventListener('close', () => handler());
      },
      onMessage(handler) {
        native.addEventListener('message', (event) => {
          const data = (event as MessageEvent).data;
          if (typeof data === 'string') handler(data);
          else if (data instanceof Buffer) handler(data.toString('utf8'));
          else if (ArrayBuffer.isView(data)) {
            const view = data as Uint8Array;
            handler(Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString('utf8'));
          } else if (data instanceof ArrayBuffer) {
            handler(Buffer.from(data).toString('utf8'));
          } else if (typeof (data as { toString?: () => string }).toString === 'function') {
            handler((data as { toString: () => string }).toString());
          }
        });
      },
    };
  }
  const wsSocket = socket as unknown as WsModuleSocket;
  return {
    get readyState() {
      return wsSocket.readyState;
    },
    send: (data) => wsSocket.send(data),
    close: () => wsSocket.close(),
    onOpen(handler) {
      wsSocket.on('open', () => handler());
    },
    onError(handler) {
      wsSocket.on('error', (err) => handler(errorMessage(err)));
    },
    onClose(handler) {
      wsSocket.on('close', () => handler());
    },
    onMessage(handler) {
      wsSocket.on('message', (data) => {
        if (typeof data === 'string') handler(data);
        else handler(Buffer.from(data as ArrayBufferLike).toString('utf8'));
      });
    },
  };
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function errorMessage(event: unknown): string {
  if (event && typeof event === 'object') {
    const candidate = event as { message?: unknown; error?: { message?: unknown } };
    if (typeof candidate.message === 'string') return candidate.message;
    if (typeof candidate.error?.message === 'string') return candidate.error.message;
  }
  return 'WebSocket connection failed';
}
