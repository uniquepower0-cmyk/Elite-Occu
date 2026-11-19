import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TelegramBotService,
  normalizeTelegramCommand,
  type TelegramBotHandlers,
  type TelegramUpdate,
} from './services/telegramBotService';

function createUpdate(text: string, chatId = 123456, messageId = 10): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: messageId,
      from: { id: chatId, first_name: 'Tester' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

describe('normalizeTelegramCommand', () => {
  it('normalizes plain text, casing, slashes, and bot mentions', () => {
    expect(normalizeTelegramCommand('Refined')).toBe('refined');
    expect(normalizeTelegramCommand('  /refined  ')).toBe('refined');
    expect(normalizeTelegramCommand('/Refined@EliteHospitalBot')).toBe('refined');
    expect(normalizeTelegramCommand('Duty')).toBe('duty');
    expect(normalizeTelegramCommand('whatsapp')).toBe('whatsapp');
    expect(normalizeTelegramCommand('WhatsApp')).toBe('whatsapp');
    expect(normalizeTelegramCommand('image')).toBe('image');
    expect(normalizeTelegramCommand('/IMAGE')).toBe('image');
    expect(normalizeTelegramCommand('')).toBe('');
  });
});

describe('TelegramBotService.handleUpdate', () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let bot: TelegramBotService;
  let handlers: TelegramBotHandlers;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = '123456:TEST_TOKEN';
    bot = new TelegramBotService();

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, result: { message_id: 99 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    handlers = {
      onRefined: vi.fn().mockResolvedValue({
        buffer: Buffer.from('refined-xlsx-bytes'),
        fileName: 'Combined_Hospital_Refined_Report_2026-11-19.xlsx',
        dateLabel: '2026-11-19',
        caption: 'Refined Combined Sheet (2026-11-19)',
      }),
      onDuty: vi.fn().mockResolvedValue({
        buffer: Buffer.from('duty-xlsx-bytes'),
        fileName: 'Combined_Hospital_Report_2026-11-19.xlsx',
        dateLabel: '2026-11-19',
        caption: 'Combined Duty Manager Sheet (2026-11-19)',
      }),
      onWhatsapp: vi.fn().mockResolvedValue({
        success: true,
        sentCount: 1,
        fileName: 'Combined_Hospital_Refined_Report_2026-11-19.xlsx',
      }),
      onImage: vi.fn().mockResolvedValue({
        success: true,
        sentCount: 5,
        totalSheets: 5,
      }),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });

  it('handles "Refined" by fetching Refined Combined Sheet and replying with sendDocument', async () => {
    const result = await bot.handleUpdate(createUpdate('Refined', 55501, 42), handlers);
    expect(result).toEqual({ handled: true, command: 'refined' });
    expect(handlers.onRefined).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/sendChatAction');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      chat_id: 55501,
      action: 'upload_document',
    });

    expect(fetchMock.mock.calls[1][0]).toContain('/sendDocument');
    const formData = fetchMock.mock.calls[1][1].body as FormData;
    expect(formData.get('chat_id')).toBe('55501');
    const doc = formData.get('document') as File;
    expect(doc.name).toBe('Combined_Hospital_Refined_Report_2026-11-19.xlsx');
  });

  it('handles "Duty" by fetching Combined Duty Manager Sheet and replying with sendDocument', async () => {
    const result = await bot.handleUpdate(createUpdate('Duty', 55502, 43), handlers);
    expect(result).toEqual({ handled: true, command: 'duty' });
    expect(handlers.onDuty).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/sendDocument');
    const formData = fetchMock.mock.calls[1][1].body as FormData;
    expect(formData.get('chat_id')).toBe('55502');
    const doc = formData.get('document') as File;
    expect(doc.name).toBe('Combined_Hospital_Report_2026-11-19.xlsx');
  });

  it('handles "whatsapp" by triggering WhatsApp Excel automation and replying "Sent to Mazingers"', async () => {
    const result = await bot.handleUpdate(createUpdate('whatsapp', 77701, 50), handlers);
    expect(result).toEqual({ handled: true, command: 'whatsapp' });
    expect(handlers.onWhatsapp).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      chat_id: 77701,
      text: 'Sent to Mazingers',
      reply_parameters: { message_id: 50 },
    });
  });

  it('handles "image" by triggering WhatsApp Images automation and replying "Combined Images sent to Mazingers"', async () => {
    const result = await bot.handleUpdate(createUpdate('image', 88801, 51), handlers);
    expect(result).toEqual({ handled: true, command: 'image' });
    expect(handlers.onImage).toHaveBeenCalledTimes(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      chat_id: 88801,
      text: 'Combined Images sent to Mazingers',
      reply_parameters: { message_id: 51 },
    });
  });

  it('reports an error instead of success when WhatsApp broadcast fails', async () => {
    handlers.onWhatsapp = vi.fn().mockResolvedValue({
      success: false,
      error: 'WhatsApp instance is not connected',
    });

    await bot.handleUpdate(createUpdate('whatsapp', 99901, 60), handlers);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.text).toContain('Failed to send to WhatsApp');
    expect(body.text).toContain('WhatsApp instance is not connected');
  });
});
