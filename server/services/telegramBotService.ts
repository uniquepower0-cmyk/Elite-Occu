import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      first_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type?: string;
    };
    text?: string;
  };
}

export interface TelegramDocumentResult {
  buffer: Buffer;
  fileName: string;
  dateLabel?: string;
  caption?: string;
}

export interface TelegramWhatsAppResult {
  success: boolean;
  sentCount?: number;
  totalSheets?: number;
  fileName?: string;
  error?: string;
}

export interface TelegramBotHandlers {
  onRefined: () => Promise<TelegramDocumentResult>;
  onDuty: () => Promise<TelegramDocumentResult>;
  onWhatsapp: () => Promise<TelegramWhatsAppResult>;
  onImage: () => Promise<TelegramWhatsAppResult>;
}

export interface SendDocumentOptions {
  chatId: number | string;
  fileBuffer: Buffer;
  fileName: string;
  caption?: string;
  replyToMessageId?: number;
  mimeType?: string;
}

const EXCEL_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function normalizeTelegramCommand(rawText: string): string {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return '';
  // Take first token if there are extra args, strip leading slashes and @bot_username suffix
  const firstToken = trimmed.split(/\s+/)[0] || '';
  const withoutSlash = firstToken.replace(/^\/+/, '');
  const withoutMention = withoutSlash.split('@')[0] || '';
  return withoutMention.trim().toLowerCase();
}

export class TelegramBotService {
  private pollingActive = false;
  private pollingOffset = 0;

  private getToken(): string {
    return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  }

  public getWebhookSecret(): string {
    return (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  }

  public isConfigured(): boolean {
    return Boolean(this.getToken());
  }

  private getApiUrl(method: string): string {
    const token = this.getToken();
    if (!token) {
      throw new Error(
        'Telegram Bot is not configured: Missing TELEGRAM_BOT_TOKEN in environment variables.'
      );
    }
    return `https://api.telegram.org/bot${token}/${method}`;
  }

  private async callJsonApi<T = any>(
    method: string,
    payload?: Record<string, any>
  ): Promise<T> {
    const url = this.getApiUrl(method);
    const response = await fetch(url, {
      method: payload ? 'POST' : 'GET',
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });

    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };

    if (!response.ok || !data.ok) {
      throw new Error(
        `Telegram API ${method} failed (HTTP ${response.status}): ${
          data.description || response.statusText || 'Unknown error'
        }`
      );
    }

    return data.result as T;
  }

  public async getMe(): Promise<{
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
  }> {
    return this.callJsonApi('getMe');
  }

  public async getWebhookInfo(): Promise<{
    url: string;
    has_custom_certificate?: boolean;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
  }> {
    return this.callJsonApi('getWebhookInfo');
  }

  public async setWebhook(
    webhookUrl: string,
    secretToken?: string
  ): Promise<boolean> {
    const payload: Record<string, any> = {
      url: webhookUrl,
      allowed_updates: ['message'],
    };
    const secret = (secretToken ?? this.getWebhookSecret()).trim();
    if (secret) {
      payload.secret_token = secret;
    }
    return this.callJsonApi<boolean>('setWebhook', payload);
  }

  public async setMyCommands(): Promise<boolean> {
    return this.callJsonApi<boolean>('setMyCommands', {
      commands: [
        { command: 'refined', description: 'Get Refined Combined Sheet (.xlsx)' },
        { command: 'duty', description: 'Get Combined Duty Manager Sheet (.xlsx)' },
        {
          command: 'whatsapp',
          description: 'Send Refined Combined Sheet (.xlsx) to WhatsApp',
        },
        {
          command: 'image',
          description: 'Send Refined Combined Sheet Images to WhatsApp',
        },
      ],
    });
  }

  public async sendChatAction(
    chatId: number | string,
    action: 'typing' | 'upload_document'
  ): Promise<void> {
    try {
      await this.callJsonApi('sendChatAction', {
        chat_id: chatId,
        action,
      });
    } catch (err: any) {
      // Non-fatal UX indicator failure
      console.warn('[TelegramBotService] sendChatAction warning:', err?.message || err);
    }
  }

  public async sendMessage(
    chatId: number | string,
    text: string,
    replyToMessageId?: number
  ): Promise<any> {
    const payload: Record<string, any> = {
      chat_id: chatId,
      text,
    };
    if (replyToMessageId !== undefined) {
      payload.reply_parameters = { message_id: replyToMessageId };
    }
    return this.callJsonApi('sendMessage', payload);
  }

  public async sendDocument(options: SendDocumentOptions): Promise<any> {
    const url = this.getApiUrl('sendDocument');
    const mimeType = options.mimeType || EXCEL_MIME_TYPE;

    const formData = new FormData();
    formData.append('chat_id', String(options.chatId));
    formData.append(
      'document',
      new Blob([new Uint8Array(options.fileBuffer)], { type: mimeType }),
      options.fileName
    );
    if (options.caption) {
      formData.append('caption', options.caption);
    }
    if (options.replyToMessageId !== undefined) {
      formData.append(
        'reply_parameters',
        JSON.stringify({ message_id: options.replyToMessageId })
      );
    }

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: any;
      description?: string;
    };

    if (!response.ok || !data.ok) {
      throw new Error(
        `Telegram API sendDocument failed (HTTP ${response.status}): ${
          data.description || response.statusText || 'Unknown error'
        }`
      );
    }

    return data.result;
  }

  public async handleUpdate(
    update: TelegramUpdate,
    handlers: TelegramBotHandlers
  ): Promise<{ handled: boolean; command?: string }> {
    const message = update?.message;
    if (!message || !message.chat?.id || typeof message.text !== 'string') {
      return { handled: false };
    }

    const chatId = message.chat.id;
    const messageId = message.message_id;
    const command = normalizeTelegramCommand(message.text);

    if (!command) {
      return { handled: false };
    }

    try {
      if (command === 'refined') {
        await this.sendChatAction(chatId, 'upload_document');
        const doc = await handlers.onRefined();
        await this.sendDocument({
          chatId,
          fileBuffer: doc.buffer,
          fileName: doc.fileName,
          caption: doc.caption,
          replyToMessageId: messageId,
        });
        return { handled: true, command: 'refined' };
      }

      if (command === 'duty') {
        await this.sendChatAction(chatId, 'upload_document');
        const doc = await handlers.onDuty();
        await this.sendDocument({
          chatId,
          fileBuffer: doc.buffer,
          fileName: doc.fileName,
          caption: doc.caption,
          replyToMessageId: messageId,
        });
        return { handled: true, command: 'duty' };
      }

      if (command === 'whatsapp') {
        await this.sendChatAction(chatId, 'typing');
        const result = await handlers.onWhatsapp();
        if (result.success) {
          await this.sendMessage(chatId, 'Sent to Mazingers', messageId);
        } else {
          await this.sendMessage(
            chatId,
            `Failed to send to WhatsApp: ${result.error || 'Unknown error'}`,
            messageId
          );
        }
        return { handled: true, command: 'whatsapp' };
      }

      if (command === 'image') {
        await this.sendChatAction(chatId, 'typing');
        const result = await handlers.onImage();
        if (result.success) {
          await this.sendMessage(
            chatId,
            'Combined Images sent to Mazingers',
            messageId
          );
        } else {
          await this.sendMessage(
            chatId,
            `Failed to send Combined Images to WhatsApp: ${
              result.error || 'Unknown error'
            }`,
            messageId
          );
        }
        return { handled: true, command: 'image' };
      }

      if (command === 'start' || command === 'help') {
        await this.sendMessage(
          chatId,
          [
            'Hospital Occupancy Bot is ready. Send one of the following:',
            '• Refined — Get Refined Combined Sheet (.xlsx)',
            '• Duty — Get Combined Duty Manager Sheet (.xlsx)',
            '• whatsapp — Send Refined Combined Sheet (.xlsx) to WhatsApp',
            '• image — Send Refined Combined Sheet Images to WhatsApp',
          ].join('\n'),
          messageId
        );
        return { handled: true, command };
      }

      return { handled: false, command };
    } catch (err: any) {
      console.error(`[TelegramBotService] Error handling "${command}":`, err);
      try {
        await this.sendMessage(
          chatId,
          `Error processing "${command}": ${err?.message || 'Internal error'}`,
          messageId
        );
      } catch (replyErr: any) {
        console.error(
          '[TelegramBotService] Failed to send error reply:',
          replyErr?.message || replyErr
        );
      }
      return { handled: true, command };
    }
  }

  /**
   * Starts background long-polling ONLY when running locally (non-Vercel)
   * and when no production webhook URL is currently registered on the bot.
   */
  public async startPollingIfLocal(handlers: TelegramBotHandlers): Promise<void> {
    if (process.env.VERCEL || !this.isConfigured() || this.pollingActive) {
      return;
    }

    try {
      const info = await this.getWebhookInfo();
      if (info.url) {
        console.log(
          `[TelegramBot] Webhook already active (${info.url}). Skipping local long-polling.`
        );
        return;
      }

      this.pollingActive = true;
      console.log('[TelegramBot] No webhook active. Starting local long-polling...');

      const pollLoop = async () => {
        while (this.pollingActive) {
          try {
            const updates = await this.callJsonApi<TelegramUpdate[]>('getUpdates', {
              offset: this.pollingOffset,
              timeout: 25,
              allowed_updates: ['message'],
            });

            if (Array.isArray(updates) && updates.length > 0) {
              for (const upd of updates) {
                if (typeof upd.update_id === 'number') {
                  this.pollingOffset = Math.max(this.pollingOffset, upd.update_id + 1);
                }
                await this.handleUpdate(upd, handlers);
              }
            }
          } catch (err: any) {
            console.warn(
              '[TelegramBot] Polling error (retrying in 5s):',
              err?.message || err
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      };

      void pollLoop();
    } catch (err: any) {
      console.warn(
        '[TelegramBot] Failed to initialize local polling:',
        err?.message || err
      );
    }
  }

  public stopPolling(): void {
    this.pollingActive = false;
  }
}

export const telegramBotService = new TelegramBotService();
