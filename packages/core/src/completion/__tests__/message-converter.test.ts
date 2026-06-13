/**
 * message-converter tests — focused on the OpenRouter multimodal-input gap fix.
 * Verifies video_url + input_audio block emission and the 25 MB cap.
 */

import type { OpenAIContentPart, SimpleChatMessage } from '@omnicross/contracts/completion-types';
import { describe, expect, it } from 'vitest';

import { convertMessageToOpenAI } from '../message-converter';

function smallBase64(byteLen: number): string {
  // 4 base64 chars encode 3 bytes; round up.
  const charCount = Math.ceil(byteLen / 3) * 4;
  return 'A'.repeat(charCount);
}

describe('convertMessageToOpenAI', () => {
  it('returns plain string content when no media is attached', () => {
    const msg: SimpleChatMessage = {
      id: '1',
      role: 'user',
      content: 'hello',
      timestamp: 0,
    };
    const result = convertMessageToOpenAI(msg);
    expect(result.content).toBe('hello');
  });

  it('emits text + video_url + input_audio in attachment order', () => {
    const audioData = smallBase64(64);
    const videoData = smallBase64(128);
    const msg: SimpleChatMessage = {
      id: '2',
      role: 'user',
      content: 'describe both',
      timestamp: 0,
      videos: [{ url: `data:video/mp4;base64,${videoData}`, mimeType: 'video/mp4' }],
      audios: [{ url: `data:audio/wav;base64,${audioData}`, mimeType: 'audio/wav' }],
    };

    const result = convertMessageToOpenAI(msg);
    expect(Array.isArray(result.content)).toBe(true);
    const parts = result.content as OpenAIContentPart[];
    // text, then audios (added before videos in the converter), then videos.
    // The spec scenario "text + video + audio" only requires that all three appear;
    // assert the set of types here.
    const types = parts.map(p => p.type).sort();
    expect(types).toEqual(['input_audio', 'text', 'video_url']);

    const audioPart = parts.find(p => p.type === 'input_audio')!;
    expect(audioPart.input_audio).toEqual({ data: audioData, format: 'wav' });

    const videoPart = parts.find(p => p.type === 'video_url')!;
    expect(videoPart.video_url?.url.startsWith('data:video/mp4;base64,')).toBe(true);
  });

  it('passes YouTube URLs through verbatim as video_url blocks', () => {
    const msg: SimpleChatMessage = {
      id: '3',
      role: 'user',
      content: '',
      timestamp: 0,
      videos: [{ url: 'https://www.youtube.com/watch?v=abc123', mimeType: 'video/mp4' }],
    };
    const result = convertMessageToOpenAI(msg);
    const parts = result.content as OpenAIContentPart[];
    const videoPart = parts.find(p => p.type === 'video_url')!;
    expect(videoPart.video_url).toEqual({ url: 'https://www.youtube.com/watch?v=abc123' });
  });

  it('rejects videos larger than 25 MB before sending', () => {
    // 26 MB = 27262976 bytes. Use 'A' * (~27262976 * 4 / 3) base64 chars.
    const bigBase64 = 'A'.repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3));
    const msg: SimpleChatMessage = {
      id: '4',
      role: 'user',
      content: 'too big',
      timestamp: 0,
      videos: [{ url: `data:video/mp4;base64,${bigBase64}`, mimeType: 'video/mp4' }],
    };
    expect(() => convertMessageToOpenAI(msg)).toThrowError(/Video too large/i);
  });

  it('rejects unmapped audio mime types with a clear error', () => {
    const audioData = smallBase64(32);
    const msg: SimpleChatMessage = {
      id: '5',
      role: 'user',
      content: '',
      timestamp: 0,
      audios: [{ url: `data:audio/amr;base64,${audioData}`, mimeType: 'audio/amr' }],
    };
    expect(() => convertMessageToOpenAI(msg)).toThrowError(/Unsupported audio format/i);
  });

  it('maps wav audio to input_audio with format wav', () => {
    const audioData = smallBase64(64);
    const msg: SimpleChatMessage = {
      id: '6',
      role: 'user',
      content: '',
      timestamp: 0,
      audios: [{ url: `data:audio/wav;base64,${audioData}`, mimeType: 'audio/wav' }],
    };
    const result = convertMessageToOpenAI(msg);
    const parts = result.content as OpenAIContentPart[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('input_audio');
    expect(parts[0].input_audio?.format).toBe('wav');
  });
});
