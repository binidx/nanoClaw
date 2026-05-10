export {
  buildSoulPrompt,
  getSoul,
  upsertSoul,
  applySoulPreset,
  removeSoul,
  detectSoulSettingIntent,
  extractSoulDescription,
  listUnifiedMemories,
} from './soul-service.js';
export type { UpsertSoulInput, AddUnifiedMemoryInput } from './soul-service.js';
export {
  shouldRunConsolidation,
  runConsolidation,
  promoteObservationById,
} from './soul-consolidation.js';
export { SOUL_PRESETS } from './soul-presets.js';
export {
  analyzeEmotion,
  isEmotionEnabled,
  getAvailableEmotionProviders,
} from './emotion-service.js';
export type { EmotionLabel } from './emotion-service.js';
