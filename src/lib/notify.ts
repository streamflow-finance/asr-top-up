import axios from 'axios';
import type { NotifyMessage } from './types.js';

export async function notify(title: string, message: string, logger: Console): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('WEBHOOK_URL is not set, skipping notification');
    return;
  }

  const notifyMessage: NotifyMessage = {
    title,
    message,
    workflow: process.env.GITHUB_WORKFLOW,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  };

  logger.debug('Sending notification:', notifyMessage);

  try {
    await axios.post(webhookUrl, notifyMessage, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    logger.error('Failed to notify:', error instanceof Error ? error.message : 'Unknown error');
  }
}
