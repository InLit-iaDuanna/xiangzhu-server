import { describe, expect, it } from 'vitest';
import { parseAssistantImages } from '../server/assistant';

describe('assistant image attachments', () => {
  it('decodes valid images and rejects malformed payloads', () => {
    expect(parseAssistantImages([
      { kind: 'image', mime: 'image/jpeg', data: Buffer.from('synthetic').toString('base64') },
    ])).toEqual([
      { mime: 'image/jpeg', bytes: Buffer.from('synthetic') },
    ]);

    expect(() => parseAssistantImages([{ kind: 'image', data: 'not base64!' }]))
      .toThrow('图片附件数据无效');
  });

  it('rejects a single chat image larger than 8 MB before decoding it', () => {
    const oversized = Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64');
    expect(() => parseAssistantImages([{ kind: 'image', mime: 'image/png', data: oversized }]))
      .toThrow('单张对话图片不能超过 8 MB');
  });

  it('rejects chat image batches larger than 24 MB', () => {
    const sixMiB = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    const attachments = Array.from({ length: 5 }, () => ({
      kind: 'image',
      mime: 'image/png',
      data: sixMiB,
    }));
    expect(() => parseAssistantImages(attachments))
      .toThrow('本轮对话图片合计不能超过 24 MB');
  });
});
