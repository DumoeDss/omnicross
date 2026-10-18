/** Local Codex thread-delivery receipts have no upstream tool call to answer. */
export function isCodexThreadDeliveryReceipt(item: Record<string, unknown>): boolean {
  return item.type === 'function_call_output'
    && item.call_id === undefined
    && item.namespace === 'codex_tui'
    && item.name === 'send_message_to_thread'
    && typeof item.output === 'string';
}
