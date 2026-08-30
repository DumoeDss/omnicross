import { describe, expect, it } from 'vitest';

import type {
  ResponseImageGenCallCompletedEvent,
  ResponseImageGenCallPartialImageEvent,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import type {
  ResponsesImageCompletedRecord,
  ResponsesImageGenerationCallItem,
  ResponsesImagePartialEvent,
} from '../types';

type OpenAIImageSpecificFailedEvent = Extract<
  ResponseStreamEvent,
  { readonly type: 'response.image_generation_call.failed' }
>;

describe('OpenAI Responses image SDK contract', () => {
  it('keeps official partial/item shapes SDK-compatible and terminal records unmistakably internal', () => {
    const partial: ResponsesImagePartialEvent = {
      type: 'response.image_generation_call.partial_image',
      output_index: 4,
      item_id: 'ig_aaaaaaaaaaaaaaaa',
      sequence_number: 11,
      partial_image_index: 0,
      partial_image_b64: 'AQI=',
    };
    const sdkPartial: ResponseImageGenCallPartialImageEvent = partial;
    expect(Object.keys(sdkPartial).sort()).toEqual([
      'item_id',
      'output_index',
      'partial_image_b64',
      'partial_image_index',
      'sequence_number',
      'type',
    ]);

    const item: ResponsesImageGenerationCallItem = {
      id: 'ig_aaaaaaaaaaaaaaaa',
      type: 'image_generation_call',
      status: 'completed',
      result: 'AQI=',
    };
    const sdkItem: ResponseOutputItem.ImageGenerationCall = item;
    expect(sdkItem).toMatchObject({ type: 'image_generation_call', result: 'AQI=' });

    const internal: ResponsesImageCompletedRecord = {
      kind: 'completed',
      outputIndex: 4,
      item,
    };
    expect(internal).not.toHaveProperty('type');
    const sdkCompleted: ResponseImageGenCallCompletedEvent = {
      type: 'response.image_generation_call.completed',
      item_id: item.id,
      output_index: internal.outputIndex,
      sequence_number: 12,
    };
    expect(Object.keys(sdkCompleted).sort()).toEqual([
      'item_id', 'output_index', 'sequence_number', 'type',
    ]);
    const noImageSpecificFailedEvent: OpenAIImageSpecificFailedEvent extends never ? true : false = true;
    expect(noImageSpecificFailedEvent).toBe(true);
  });
});
