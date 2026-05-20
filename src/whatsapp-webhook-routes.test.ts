import crypto from 'crypto';

import express from 'express';
import inject from 'light-my-request';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config-store.js', () => ({
  getConfiguredChannelInstances: vi.fn(async () => [
    {
      id: 'default',
      type: 'whatsapp',
      enabled: true,
      config: {
        appSecret: 'app-secret',
        verifyToken: 'verify-token',
      },
    },
  ]),
}));

vi.mock('./channels/whatsapp.js', () => ({
  dispatchWhatsAppWebhook: vi.fn(async () => 1),
}));

import { dispatchWhatsAppWebhook } from './channels/whatsapp.js';
import {
  captureWhatsAppWebhookRawBody,
  registerWhatsAppWebhookRoutes,
} from './routes/whatsapp-webhook-routes.js';

function signatureFor(rawBody: string): string {
  return (
    'sha256=' +
    crypto.createHmac('sha256', 'app-secret').update(rawBody).digest('hex')
  );
}

function createApp(): express.Express {
  const app = express();
  app.use(
    express.json({
      verify: captureWhatsAppWebhookRawBody,
    }),
  );
  registerWhatsAppWebhookRoutes(app);
  return app;
}

describe('WhatsApp webhook routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies signatures using the raw body captured by the global JSON parser', async () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
    const response = await inject(createApp(), {
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signatureFor(rawBody),
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true, handled: 1 });
    expect(dispatchWhatsAppWebhook).toHaveBeenCalledWith({
      object: 'whatsapp_business_account',
      entry: [],
    });
  });

  it('rejects WhatsApp webhooks with invalid signatures', async () => {
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
    const response = await inject(createApp(), {
      method: 'POST',
      url: '/webhooks/whatsapp/default',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=bad',
      },
      payload: rawBody,
    });

    expect(response.statusCode).toBe(403);
    expect(dispatchWhatsAppWebhook).not.toHaveBeenCalled();
  });
});
