import type { Request, Response, NextFunction } from 'express';
import { getLocaleFromReq } from './index.js';

// Augment Express Request type
declare global {
  namespace Express {
    interface Request {
      locale: string;
    }
  }
}

/**
 * Express middleware that extracts locale from X-Locale header
 * or Accept-Language and attaches it to req.locale.
 */
export function localeMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.locale = getLocaleFromReq(req);
  next();
}
