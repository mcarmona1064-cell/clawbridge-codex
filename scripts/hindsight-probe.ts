/**
 * Hindsight live probe — verifies retain, recall, and reflect end-to-end
 * against the local Hindsight server using the same client/config the host
 * process uses. Run from the repo root:
 *
 *   pnpm tsx scripts/hindsight-probe.ts
 */
import { hindsightRetain, hindsightRecall, hindsightReflect, isHindsightAvailable } from '../src/memory/index.js';

const CLIENT = 'global';
const CANARY = `clawbridge-probe-${Date.now()}`;

async function main(): Promise<void> {
  console.log(`[probe] Hindsight URL: ${process.env['HINDSIGHT_URL'] ?? 'http://localhost:8888'}`);
  const available = await isHindsightAvailable();
  console.log(`[probe] available: ${available}`);
  if (!available) process.exit(1);

  console.log(`\n[probe] retain — canary=${CANARY}`);
  await hindsightRetain(
    CLIENT,
    `Canary fact for ${CANARY}: the user's favorite test phrase is mango skylight 47.`,
    { context: 'clawbridge-probe', sessionId: CANARY, async: false },
  );
  console.log('[probe] retain OK');

  console.log('\n[probe] recall — query="favorite test phrase"');
  const recalled = await hindsightRecall(CLIENT, 'favorite test phrase', { maxTokens: 1500 });
  console.log(`[probe] recall returned ${recalled.length} chars`);
  if (recalled) console.log('---\n' + recalled.slice(0, 800) + (recalled.length > 800 ? '\n...[truncated]' : '') + '\n---');

  console.log('\n[probe] reflect — query="key user preferences and facts"');
  const reflected = await hindsightReflect(CLIENT, 'key user preferences and facts', { budget: 'low', maxTokens: 1500 });
  console.log(`[probe] reflect returned ${reflected.length} chars`);
  if (reflected) console.log('---\n' + reflected.slice(0, 800) + (reflected.length > 800 ? '\n...[truncated]' : '') + '\n---');

  console.log('\n[probe] DONE');
}

main().catch((err) => {
  console.error('[probe] FAILED:', err);
  process.exit(1);
});
