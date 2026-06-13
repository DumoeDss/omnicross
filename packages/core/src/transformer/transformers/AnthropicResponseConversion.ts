/**
 * AnthropicResponseConversion - Non-streaming RESPONSE-DIRECTION conversions
 * between Anthropic and OpenAI/unified message shapes.
 *
 * Internal helper of AnthropicConversion; do not import the facade here.
 *
 * @module transformer/transformers/AnthropicResponseConversion
 */

/**
 * Convert Anthropic non-streaming response to OpenAI-compatible format.
 * Reverse of `convertOpenAIResponseToAnthropic`.
 */
export function convertAnthropicResponseToOpenAI(
  anthropicResponse: Record<string, unknown>
): Record<string, unknown> {
  const content = (anthropicResponse.content as Array<Record<string, unknown>>) || [];
  const textParts = content.filter(c => c.type === 'text').map(c => c.text as string);
  // Include both regular tool_use and server_tool_use blocks
  const toolUses = content.filter(c => c.type === 'tool_use' || c.type === 'server_tool_use');
  const thinkingBlock = content.find(c => c.type === 'thinking') as Record<string, unknown> | undefined;

  // Extract web_search_tool_result content and append to text
  const searchResults = content.filter(c => c.type === 'web_search_tool_result');
  for (const sr of searchResults) {
    const searches = sr.content as Array<Record<string, unknown>> | undefined;
    if (searches?.length) {
      const formatted = searches
        .map((s: Record<string, unknown>) => `[${s.title}](${s.url}): ${s.page_content || s.snippet || ''}`)
        .join('\n');
      textParts.push(`\n\n**Search Results:**\n${formatted}`);
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: textParts.join('') || null,
  };

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.input || {}),
      },
    }));
  }

  if (thinkingBlock) {
    message.thinking = {
      content: thinkingBlock.thinking,
      signature: thinkingBlock.signature,
    };
  }

  const stopReasonMapping: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool_calls',
    stop_sequence: 'stop',
  };

  const usage = anthropicResponse.usage as Record<string, number> | undefined;

  return {
    id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: stopReasonMapping[anthropicResponse.stop_reason as string] || 'stop',
    }],
    usage: usage ? {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : undefined,
  };
}

/**
 * Convert OpenAI non-streaming response to Anthropic format.
 */
export function convertOpenAIResponseToAnthropic(
  openaiResponse: Record<string, unknown>
): Record<string, unknown> {
  const choice = (openaiResponse.choices as Array<Record<string, unknown>>)?.[0];
  if (!choice) {
    throw new Error('No choices found in OpenAI response');
  }

  const message = choice.message as Record<string, unknown>;
  const content: Array<Record<string, unknown>> = [];

  // Handle text content
  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  // Handle tool calls
  const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls?.length) {
    for (const toolCall of toolCalls) {
      const func = toolCall.function as Record<string, unknown>;
      let parsedInput: Record<string, unknown> = {};
      try {
        const args = func.arguments as string;
        parsedInput = typeof args === 'string' ? JSON.parse(args) : args;
      } catch {
        parsedInput = { text: func.arguments || '' };
      }

      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: func.name,
        input: parsedInput,
      });
    }
  }

  // Handle thinking
  const thinking = message.thinking as Record<string, unknown> | undefined;
  if (thinking?.content) {
    content.push({
      type: 'thinking',
      thinking: thinking.content,
      signature: thinking.signature,
    });
  }

  // Map finish reason
  const finishReason = choice.finish_reason as string;
  const stopReasonMapping: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
  };

  const usage = openaiResponse.usage as Record<string, unknown> | undefined;
  const usageDetails = usage?.prompt_tokens_details as Record<string, unknown> | undefined;

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model,
    content,
    stop_reason: stopReasonMapping[finishReason] || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ((usage?.prompt_tokens as number) || 0) -
        ((usageDetails?.cached_tokens as number) || 0),
      output_tokens: (usage?.completion_tokens as number) || 0,
      cache_read_input_tokens: (usageDetails?.cached_tokens as number) || 0,
    },
  };
}
