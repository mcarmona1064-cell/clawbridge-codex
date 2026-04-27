export { MemoryManager } from './manager.js';
export { extractMemories } from './extractor.js';
export { initMemoryDb } from './db.js';
export { runReflectionAgent } from './reflection-agent.js';
export { generateCrossClientReport } from './cross-client.js';
export { embed, keywordSimilarity, cosineSimilarity } from './embeddings.js';
export type { Memory, MemorySegment, MemoryQueryResult } from './types.js';

// Hindsight integration
export {
  hindsightRetain,
  hindsightRecall,
  hindsightReflect,
  ensureClientBank,
  isHindsightAvailable,
  bankId,
} from './hindsight.js';
