import dotenv from 'dotenv';

dotenv.config();

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

        const data = (await response.json()) as { idMessage: string };
        return data;
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

    const results: SendBatchResult[] = [];
    for (const groupId of groups) {
      const groupResult = await this.sendBatchToChat(groupId, items);
      results.push(groupResult);
    }

    return results;
  }
}

export const greenApiService = new GreenApiService();
