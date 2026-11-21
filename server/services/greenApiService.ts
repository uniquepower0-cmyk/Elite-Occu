import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface SendImageOptions {
  chatId: string;
  fileBuffer: Buffer;
  fileName: string;
  caption?: string;
  mimeType?: string;
}

export interface SendBatchItem {
  fileBuffer: Buffer;
  fileName: string;
  caption?: string;
  mimeType?: string;
}

export interface SendBatchResult {
  chatId: string;
  success: boolean;
  sentCount: number;
  total: number;
  messageIds: string[];
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GreenApiService {
  private instanceId: string;
  private apiToken: string;
  private defaultGroupIds: string[];

  constructor() {
    this.instanceId = (process.env.GREEN_API_INSTANCE_ID || '').trim();
    this.apiToken = (process.env.GREEN_API_TOKEN || '').trim();
    const rawGroups = (process.env.GREEN_API_GROUP_IDS || '').trim();
    this.defaultGroupIds = rawGroups
      ? rawGroups.split(',').map((id) => id.trim()).filter(Boolean)
      : [];
  }

  public isConfigured(): boolean {
    return Boolean(this.instanceId && this.apiToken && this.defaultGroupIds.length > 0);
  }

  public getTargetGroups(): string[] {
    return this.defaultGroupIds;
  }

  /**
   * Checks whether the Green API WhatsApp instance is currently authorized and connected.
   */
  public async getStateInstance(): Promise<string> {
    if (!this.instanceId || !this.apiToken) {
      return 'notConfigured';
    }
    const url = `https://api.green-api.com/waInstance${this.instanceId}/getStateInstance/${this.apiToken}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Green API state check HTTP ${response.status}: ${errorText}`);
    }
    const data = (await response.json()) as { stateInstance?: string };
    return String(data?.stateInstance || 'unknown');
  }

  /**
   * Upload and send a single file/image to a WhatsApp chat/group.
   */
  public async sendFileByUpload(options: SendImageOptions, retries = 2): Promise<{ idMessage: string }> {
    if (!this.instanceId || !this.apiToken) {
      throw new Error('Green API is not configured: Missing GREEN_API_INSTANCE_ID or GREEN_API_TOKEN in server environment.');
    }

    const url = `https://api.green-api.com/waInstance${this.instanceId}/sendFileByUpload/${this.apiToken}`;

    const mimeType = options.mimeType || (
      options.fileName.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' :
      options.fileName.endsWith('.png') ? 'image/png' :
      options.fileName.endsWith('.pdf') ? 'application/pdf' :
      'image/jpeg'
    );

    const formData = new FormData();
    formData.append('chatId', options.chatId);
    formData.append(
      'file',
      new Blob([new Uint8Array(options.fileBuffer)], { type: mimeType }),
      options.fileName
    );
    if (options.caption) {
      formData.append('caption', options.caption);
    }

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Green API HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as { idMessage?: string };
        if (!data || !data.idMessage) {
          throw new Error(`Green API did not return idMessage for ${options.fileName}: ${JSON.stringify(data)}`);
        }
        return { idMessage: data.idMessage };
      } catch (err: any) {
        if (attempt <= retries) {
          console.warn(`[GreenApiService] Upload attempt ${attempt} failed for ${options.fileName}: ${err.message}. Retrying in 1s...`);
          await sleep(1000 * attempt);
        } else {
          throw err;
        }
      }
    }

    throw new Error(`Failed to upload ${options.fileName} after ${retries + 1} attempts.`);
  }

  /**
   * Send a sequential batch of images to a WhatsApp chat with strict pacing to preserve order.
   */
  public async sendBatchToChat(chatId: string, items: SendBatchItem[], delayBetweenMs = 600): Promise<SendBatchResult> {
    const result: SendBatchResult = {
      chatId,
      success: true,
      sentCount: 0,
      total: items.length,
      messageIds: [],
      errors: [],
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      try {
        const uploadRes = await this.sendFileByUpload({
          chatId,
          fileBuffer: item.fileBuffer,
          fileName: item.fileName,
          caption: item.caption,
          mimeType: item.mimeType,
        });
        result.sentCount++;
        result.messageIds.push(uploadRes.idMessage);
      } catch (err: any) {
        result.success = false;
        result.errors.push(`Failed to send ${item.fileName}: ${err.message}`);
        console.error(`[GreenApiService] Error sending ${item.fileName} to ${chatId}:`, err);
      }

      // Add pacing between images so WhatsApp receives and renders them sequentially
      if (i < items.length - 1) {
        await sleep(delayBetweenMs);
      }
    }

    return result;
  }

  /**
   * Broadcast a batch of images to all configured target groups.
   */
  public async broadcastBatch(items: SendBatchItem[]): Promise<SendBatchResult[]> {
    const groups = this.getTargetGroups();
    if (groups.length === 0) {
      throw new Error('No target WhatsApp group IDs configured in GREEN_API_GROUP_IDS.');
    }

    const state = await this.getStateInstance();
    if (state !== 'authorized') {
      throw new Error(
        `WhatsApp instance is not connected (Green API state: "${state}"). Please scan the QR code in your Green API dashboard to re-authorize WhatsApp.`
      );
    }

    const results: SendBatchResult[] = [];
    for (const groupId of groups) {
      const groupResult = await this.sendBatchToChat(groupId, items);
      results.push(groupResult);
    }

    return results;
  }

  /**
   * Send a plain/markdown WhatsApp text message to a single chat/group via Green API.
   */
  public async sendTextMessage(chatId: string, message: string, retries = 2): Promise<{ idMessage: string }> {
    if (!this.instanceId || !this.apiToken) {
      throw new Error('Green API is not configured: Missing GREEN_API_INSTANCE_ID or GREEN_API_TOKEN in server environment.');
    }

    const url = `https://api.green-api.com/waInstance${this.instanceId}/sendMessage/${this.apiToken}`;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chatId, message }),
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Green API HTTP ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as { idMessage?: string };
        if (!data || !data.idMessage) {
          throw new Error(`Green API did not return idMessage: ${JSON.stringify(data)}`);
        }
        return { idMessage: data.idMessage };
      } catch (err: any) {
        if (attempt <= retries) {
          console.warn(`[GreenApiService] sendTextMessage attempt ${attempt} failed for ${chatId}: ${err.message}. Retrying in ${attempt}s...`);
          await sleep(1000 * attempt);
        } else {
          throw err;
        }
      }
    }

    throw new Error(`Failed to send text message to ${chatId} after ${retries + 1} attempts.`);
  }

  /**
   * Broadcast a WhatsApp text message to customGroupIds or default GREEN_API_GROUP_IDS.
   */
  public async broadcastTextMessage(
    message: string,
    customGroupIds?: string[]
  ): Promise<{ chatId: string; success: boolean; idMessage?: string; error?: string }[]> {
    const groups = (customGroupIds && customGroupIds.length > 0)
      ? customGroupIds
      : this.getTargetGroups();
    if (groups.length === 0) {
      throw new Error('No target WhatsApp group IDs configured.');
    }

    const state = await this.getStateInstance();
    if (state !== 'authorized') {
      throw new Error(
        `WhatsApp instance is not connected (Green API state: "${state}").`
      );
    }

    const results: { chatId: string; success: boolean; idMessage?: string; error?: string }[] = [];
    for (let i = 0; i < groups.length; i++) {
      const groupId = groups[i];
      try {
        const res = await this.sendTextMessage(groupId, message);
        results.push({ chatId: groupId, success: true, idMessage: res.idMessage });
      } catch (err: any) {
        results.push({ chatId: groupId, success: false, error: err?.message || String(err) });
      }
      if (i < groups.length - 1) {
        await sleep(300);
      }
    }

    return results;
  }
}

export const greenApiService = new GreenApiService();
