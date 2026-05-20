import crypto from 'crypto';

import type { Express, Request, RequestHandler } from 'express';
import express from 'express';

import { getConfiguredChannelInstances } from '../config-store.js';
import {
  dispatchWhatsAppWebhook,
  type WhatsAppWebhookPayload,
} from '../channels/whatsapp.js';
import { logger } from '../logger.js';

type RawBodyRequest = Request & { rawBody?: string };

function isWhatsAppWebhookPath(path: string): boolean {
  return (
    path === '/webhooks/whatsapp' || path.startsWith('/webhooks/whatsapp/')
  );
}

export function captureWhatsAppWebhookRawBody(
  req: Request,
  _res: unknown,
  buf: Buffer,
): void {
  const rawPath = req.originalUrl || req.url || '';
  const path = rawPath.split('?')[0] || '';
  if (isWhatsAppWebhookPath(path)) {
    (req as RawBodyRequest).rawBody = buf.toString('utf8');
  }
}

const webhookJsonBodyParser = express.raw({
  type: ['application/json', 'application/*+json', 'text/json'],
  limit: '2mb',
});

const captureRawWebhookJsonBody: RequestHandler = (req, res, next) => {
  const rawReq = req as RawBodyRequest;
  if (typeof rawReq.rawBody === 'string' || req.body !== undefined) {
    next();
    return;
  }
  webhookJsonBodyParser(req, res, next);
};

const parseRawWebhookJsonBody: RequestHandler = (req, res, next) => {
  if (!Buffer.isBuffer(req.body)) {
    next();
    return;
  }

  const rawBody = req.body.toString('utf8');
  (req as RawBodyRequest).rawBody = rawBody;
  try {
    req.body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }
  next();
};

async function resolveWhatsAppVerifyToken(instanceId: string): Promise<string> {
  const normalizedInstanceId = instanceId.trim() || 'default';
  const instance = (await getConfiguredChannelInstances()).find(
    (entry) =>
      entry.enabled &&
      entry.type === 'whatsapp' &&
      entry.id === normalizedInstanceId,
  );
  return String(instance?.config.verifyToken || '').trim();
}

async function resolveWhatsAppWebhookSigningSecret(
  instanceId: string,
): Promise<string> {
  const normalizedInstanceId = instanceId.trim() || 'default';
  const instance = (await getConfiguredChannelInstances()).find(
    (entry) =>
      entry.enabled &&
      entry.type === 'whatsapp' &&
      entry.id === normalizedInstanceId,
  );
  const fromInstance = String(instance?.config.appSecret || '').trim();
  if (fromInstance) return fromInstance;
  return String(process.env.META_APP_SECRET || '').trim();
}

function verifyWhatsAppWebhookSignature(input: {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  secret: string;
}): boolean {
  const header = (name: string) => {
    const value = input.headers[name] || input.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] || '' : value || '';
  };
  const signature = header('x-hub-signature-256');
  if (!signature.startsWith('sha256=')) return false;
  const digest =
    'sha256=' +
    crypto
      .createHmac('sha256', input.secret)
      .update(input.rawBody)
      .digest('hex');
  if (signature.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export function registerWhatsAppWebhookRoutes(app: Express): void {
  const handleWhatsAppVerification: RequestHandler = async (req, res) => {
    const instanceId =
      typeof req.params.instanceId === 'string'
        ? req.params.instanceId
        : 'default';
    const mode = String(req.query['hub.mode'] || '').trim();
    const token = String(req.query['hub.verify_token'] || '').trim();
    const challenge = String(req.query['hub.challenge'] || '');
    const expectedToken = await resolveWhatsAppVerifyToken(instanceId);

    if (!expectedToken) {
      res
        .status(404)
        .send('WhatsApp instance not found or verify token missing');
      return;
    }
    if (mode !== 'subscribe' || token !== expectedToken) {
      res.status(403).send('Verification failed');
      return;
    }

    res.type('text/plain').send(challenge);
  };

  const handleWhatsAppWebhook: RequestHandler = async (req, res) => {
    try {
      const instanceId =
        typeof req.params.instanceId === 'string'
          ? req.params.instanceId
          : 'default';
      const rawReq = req as RawBodyRequest;
      const rawBody = typeof rawReq.rawBody === 'string' ? rawReq.rawBody : '';
      const secret = await resolveWhatsAppWebhookSigningSecret(instanceId);

      if (!secret) {
        logger.error(
          { instanceId },
          'WhatsApp webhook: no app secret configured (instance appSecret or META_APP_SECRET) — rejecting request',
        );
        res.status(403).json({
          error:
            'Webhook signature verification not possible: no app secret configured. ' +
            'Set META_APP_SECRET or configure appSecret on the channel instance.',
        });
        return;
      } else {
        if (!rawBody) {
          res.status(400).json({
            error:
              'Raw request body not available; cannot verify webhook signature. ' +
              'Ensure the server is configured to capture raw bodies.',
          });
          return;
        }
        if (
          !verifyWhatsAppWebhookSignature({
            headers: req.headers,
            rawBody,
            secret,
          })
        ) {
          res
            .status(403)
            .json({ error: 'Webhook signature verification failed' });
          return;
        }
      }

      const handled = await dispatchWhatsAppWebhook(
        (req.body || {}) as WhatsAppWebhookPayload,
      );
      res.json({ ok: true, handled });
    } catch (err) {
      logger.error({ err }, 'Failed to dispatch WhatsApp webhook');
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Internal error' });
    }
  };

  app.get('/webhooks/whatsapp', handleWhatsAppVerification);
  app.get('/webhooks/whatsapp/:instanceId', handleWhatsAppVerification);
  app.post(
    '/webhooks/whatsapp',
    captureRawWebhookJsonBody,
    parseRawWebhookJsonBody,
    handleWhatsAppWebhook,
  );
  app.post(
    '/webhooks/whatsapp/:instanceId',
    captureRawWebhookJsonBody,
    parseRawWebhookJsonBody,
    handleWhatsAppWebhook,
  );
}
