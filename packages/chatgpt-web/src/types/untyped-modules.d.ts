/**
 * untyped-modules.d.ts — ambient declarations for optional/untyped deps.
 *
 * `ws` is an OPTIONAL peer dependency (native WebSocket covers Node >= 22);
 * `turndown-plugin-gfm` ships no types of its own.
 */

declare module 'ws' {
  export default class WebSocket {
    constructor(url: string);
    readyState: number;
    send(data: string): void;
    close(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  }
}

declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
