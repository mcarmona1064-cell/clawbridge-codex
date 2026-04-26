export type MemorySegment =
  | 'identity'
  | 'preference'
  | 'correction'
  | 'relationship'
  | 'knowledge'
  | 'behavioral'
  | 'context'

export interface Memory {
  id: string // uuid
  clientId: string // which client this belongs to (or 'global')
  segment: MemorySegment
  content: string // plain english fact
  importance: number // 0.0 - 1.0
  decayRate: number // daily decay rate (0 = never decays)
  createdAt: string // ISO
  lastAccessedAt: string // ISO
  expiresAt?: string // ISO, optional for short-term
}

export interface MemoryQueryResult {
  memories: Memory[]
  totalTokensEstimate: number
}

export const SEGMENT_DEFAULTS: Record<MemorySegment, { importance: number; decayRate: number }> = {
  identity: { importance: 0.9, decayRate: 0 },
  preference: { importance: 0.7, decayRate: 0.002 },
  correction: { importance: 0.8, decayRate: 0.001 },
  relationship: { importance: 0.65, decayRate: 0.002 },
  knowledge: { importance: 0.6, decayRate: 0.003 },
  behavioral: { importance: 0.55, decayRate: 0.002 },
  context: { importance: 0.4, decayRate: 0.08 },
}
