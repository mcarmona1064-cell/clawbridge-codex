/**
 * Unified audio transcription.
 *
 * Priority chain (first available wins):
 *   1. Groq Whisper API  — if GROQ_API_KEY is set (fast, accurate, free tier)
 *   2. @xenova/transformers — local Whisper running in Node.js
 *      • Requires ffmpeg for OGG/MP3/M4A → WAV conversion (auto-detected)
 *      • Model is downloaded once on first use (~250 MB, cached)
 *      • Works on both Mac (Apple Silicon) and Linux
 *
 * Call `transcribeAudio` from any channel adapter. Returns null when
 * transcription is unavailable (logs a one-time warning).
 */

import { execFile } from 'child_process';
import { tmpdir } from 'os';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { promisify } from 'util';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Groq path
// ---------------------------------------------------------------------------

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

async function transcribeWithGroq(apiKey: string, data: Buffer, filename: string, mimeType: string): Promise<string> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(data)], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', GROQ_MODEL);
  form.append('response_format', 'text');

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq transcription failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

// ---------------------------------------------------------------------------
// Local path — ffmpeg + @xenova/transformers
// ---------------------------------------------------------------------------

let ffmpegAvailable: boolean | null = null;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    log.warn(
      '[transcription] ffmpeg not found — audio format conversion unavailable. Install ffmpeg to enable local transcription.',
    );
  }
  return ffmpegAvailable;
}

// Cached pipeline instance — loaded once, reused across calls.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: ((audio: string) => Promise<{ text: string }>) | null = null;
let pipelineLoadAttempted = false;

async function getLocalPipeline(): Promise<((audio: string) => Promise<{ text: string }>) | null> {
  if (pipelineLoadAttempted) return pipeline;
  pipelineLoadAttempted = true;
  try {
    // Dynamic import so the package is optional at startup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('@xenova/transformers' as any);
    pipeline = (await mod.pipeline('automatic-speech-recognition', 'Xenova/whisper-small', {
      quantized: true,
    })) as (audio: string) => Promise<{ text: string }>;
    log.info('[transcription] Local Whisper model ready (Xenova/whisper-small)');
  } catch (err) {
    log.warn('[transcription] @xenova/transformers unavailable — run: npm install @xenova/transformers', {
      err: (err as Error).message,
    });
    pipeline = null;
  }
  return pipeline;
}

async function transcribeLocal(data: Buffer, filename: string): Promise<string | null> {
  if (!(await hasFfmpeg())) return null;

  const localPipeline = await getLocalPipeline();
  if (!localPipeline) return null;

  const id = randomUUID();
  const ext = filename.split('.').pop() ?? 'ogg';
  const tempIn = join(tmpdir(), `cb-audio-${id}.${ext}`);
  const tempWav = join(tmpdir(), `cb-audio-${id}.wav`);

  try {
    await writeFile(tempIn, data);
    // Convert to 16 kHz mono WAV — the format Whisper expects
    await execFileAsync('ffmpeg', ['-i', tempIn, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tempWav]);
    const result = await localPipeline(tempWav);
    return result.text?.trim() ?? null;
  } finally {
    await unlink(tempIn).catch(() => {});
    await unlink(tempWav).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns true for MIME types that represent audio worth transcribing. */
export function isAudioLike(mimeType: string): boolean {
  return mimeType.startsWith('audio/') || mimeType === 'video/ogg' || mimeType === 'video/webm';
}

/**
 * Transcribe audio data to text. Reads GROQ_API_KEY from ~/.clawbridge/.env.
 * Falls back to local Whisper (via @xenova/transformers + ffmpeg) when no key is set.
 * Returns null when transcription is unavailable or fails.
 */
export async function transcribeAudio(data: Buffer, filename: string, mimeType: string): Promise<string | null> {
  const { GROQ_API_KEY: groqKey } = readEnvFile(['GROQ_API_KEY']);
  try {
    if (groqKey) return await transcribeWithGroq(groqKey, data, filename, mimeType);
    return await transcribeLocal(data, filename);
  } catch (err) {
    log.error('[transcription] failed', { err: (err as Error).message });
    return null;
  }
}
