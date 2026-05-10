import { logger } from '../logger.js';
import { dba } from '../db.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Scan for documents stuck in 'processing' state and reset them.
 * Called periodically (e.g. every 5 minutes).
 */
export async function recoverStuckLlmJobs(): Promise<{ reset: number; failed: number }> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS).toISOString();
  const now = new Date().toISOString();

  // Find stuck processing docs
  const stuck = await dba.prepare(
    `SELECT id, llm_status FROM knowledge_documents WHERE llm_status = 'processing' AND updated_at < ?`
  ).all(cutoff) as Array<{ id: string; llm_status: string }>;

  let reset = 0;
  let failed = 0;

  for (const doc of stuck) {
    const result = await dba.prepare(
      `UPDATE knowledge_documents SET llm_status = 'pending', updated_at = ? WHERE id = ? AND llm_status = 'processing' AND updated_at < ?`
    ).run(now, doc.id, cutoff);
    if ((result as any)?.changes > 0) {
      reset++;
      logger.info({ docId: doc.id }, 'Reset stuck LLM processing job to pending');
    }
  }

  const longPendingCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const longPending = await dba.prepare(
    `SELECT id FROM knowledge_documents WHERE llm_status = 'pending' AND updated_at < ?`
  ).all(longPendingCutoff) as Array<{ id: string }>;

  for (const doc of longPending) {
    const failResult = await dba.prepare(
      `UPDATE knowledge_documents SET llm_status = 'failed', updated_at = ? WHERE id = ? AND llm_status = 'pending' AND updated_at < ?`
    ).run(now, doc.id, longPendingCutoff);
    if ((failResult as any)?.changes > 0) {
      failed++;
      logger.warn({ docId: doc.id }, 'Marked long-pending LLM job as failed');
    }
  }

  if (reset > 0 || failed > 0) {
    logger.info({ reset, failed }, 'LLM recovery sweep completed');
  }
  return { reset, failed };
}
