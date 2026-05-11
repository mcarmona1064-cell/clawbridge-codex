/**
 * Agent-to-agent message routing.
 *
 * Outbound messages with `channel_type === 'agent'` target another agent
 * group rather than a channel. Permission is enforced via `agent_destinations` —
 * the source agent must have a row for the target. Content is copied into the
 * target's inbound DB; if the source message had `files` (from `send_file`),
 * the actual bytes are copied from the source's outbox into the target's
 * `inbox/<a2a-msg-id>/` directory and surfaced to the target agent as
 * `attachments` (existing formatter convention — see formatter.ts:230).
 * The target agent can then forward the file onward via its own `send_file`
 * call using the absolute `/workspace/inbox/<a2a-msg-id>/<filename>` path.
 *
 * Self-messages are always allowed (used for system notes injected back into
 * an agent's own session, e.g. post-approval follow-up prompts).
 *
 * Core delivery.ts dispatches into this via a dynamic import guarded by a
 * `channel_type === 'agent'` check. When the module is absent the check in
 * core throws with a "module not installed" message so retry → mark failed.
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { inboundDbPath, resolveSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import { openInboundDb as openInboundDbWriter } from '../../db/session-db.js';
import type { Session } from '../../types.js';
import { hasDestination } from './db/agent-destinations.js';

export interface ForwardedAttachment {
  name: string;
  filename: string;
  type: 'file';
  localPath: string;
}

/**
 * Is `name` safe to use as the last segment of a path inside the target
 * agent's inbox directory? Filenames arrive in messages_out content from
 * the source agent — under a multi-agent setup with heterogenous providers
 * (or a compromised / hallucinating sub-agent) they can't be trusted.
 *
 * Rejects:
 *   - empty string
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * Copy file attachments from the source agent's outbox into the target
 * agent's inbox. Returns attachments using the formatter's existing
 * `{name, type, localPath}` convention — target agent reads `localPath`
 * as relative to `/workspace/`, matching how channel-inbound attachments
 * are surfaced today.
 *
 * Missing source files and unsafe (path-traversal) filenames are skipped
 * with a warning rather than failing the whole route — a bad filename
 * reference shouldn't kill the accompanying text.
 */
export function forwardAttachedFiles(
  source: { agentGroupId: string; sessionId: string; messageId: string; filenames: string[] },
  target: { agentGroupId: string; sessionId: string; messageId: string },
): ForwardedAttachment[] {
  if (source.filenames.length === 0) return [];

  const sourceDir = path.join(sessionDir(source.agentGroupId, source.sessionId), 'outbox', source.messageId);
  if (!fs.existsSync(sourceDir)) {
    log.warn('agent-route: source outbox dir missing, no files forwarded', {
      sourceMsgId: source.messageId,
      sourceDir,
    });
    return [];
  }

  const targetInboxDir = path.join(sessionDir(target.agentGroupId, target.sessionId), 'inbox', target.messageId);
  try {
    fs.mkdirSync(targetInboxDir, { recursive: true });
  } catch (err) {
    log.warn('agent-route: failed to create target inbox dir, no files forwarded', { targetInboxDir, err });
    return [];
  }

  const attachments: ForwardedAttachment[] = [];
  for (const filename of source.filenames) {
    if (!isSafeAttachmentName(filename)) {
      log.warn('agent-route: rejecting unsafe attachment filename (path traversal attempt?)', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const src = path.join(sourceDir, filename);
    if (!fs.existsSync(src)) {
      log.warn('agent-route: referenced file missing in source outbox, skipped', {
        sourceMsgId: source.messageId,
        filename,
      });
      continue;
    }
    const dst = path.join(targetInboxDir, filename);
    fs.copyFileSync(src, dst);
    attachments.push({
      name: filename,
      filename,
      type: 'file',
      localPath: `inbox/${target.messageId}/${filename}`,
    });
  }
  return attachments;
}

export interface RoutableAgentMessage {
  id: string;
  platform_id: string | null;
  content: string;
}

export async function routeAgentMessage(msg: RoutableAgentMessage, session: Session): Promise<void> {
  const targetAgentGroupId = msg.platform_id;
  if (!targetAgentGroupId) {
    throw new Error(`agent-to-agent message ${msg.id} is missing a target agent group id`);
  }
  if (
    targetAgentGroupId !== session.agent_group_id &&
    !hasDestination(session.agent_group_id, 'agent', targetAgentGroupId)
  ) {
    throw new Error(
      `unauthorized agent-to-agent: ${session.agent_group_id} has no destination for ${targetAgentGroupId}`,
    );
  }
  if (!getAgentGroup(targetAgentGroupId)) {
    throw new Error(`target agent group ${targetAgentGroupId} not found for message ${msg.id}`);
  }
  // Step 3b: if the outbound message carries reply_to_session (set by the child
  // agent's MCP send_message tool when it knows it's replying to a parent),
  // route directly to that session instead of the agent-shared session. This
  // ensures the reply lands in the exact parent session that originated the
  // request, even when the parent agent has multiple concurrent sessions.
  let targetSession: Session;
  let replyToSessionId: string | null = null;
  try {
    const parsedContent = JSON.parse(msg.content) as Record<string, unknown>;
    if (typeof parsedContent.reply_to_session === 'string') {
      replyToSessionId = parsedContent.reply_to_session;
    }
  } catch {
    // non-JSON content — fall through to agent-shared
  }

  if (replyToSessionId) {
    const directSession = getSession(replyToSessionId);
    if (directSession && directSession.agent_group_id === targetAgentGroupId) {
      targetSession = directSession;
      log.info('agent-route: reply_to_session found, routing directly to parent session', {
        replyToSession: replyToSessionId,
        targetAgentGroupId,
      });
    } else {
      log.warn('agent-route: reply_to_session points to unknown/mismatched session, falling back to agent-shared', {
        replyToSessionId,
        targetAgentGroupId,
      });
      ({ session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared'));
    }
  } else {
    ({ session: targetSession } = resolveSession(targetAgentGroupId, null, null, 'agent-shared'));
  }
  const a2aMsgId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // If the source message references files (via `send_file`), forward the
  // bytes from the source's outbox into the target's inbox so the target
  // agent can actually see and re-send them. Without this, agent-to-agent
  // file attachments look like they arrive but the target has no way to
  // read the bytes — they live in a session dir it doesn't mount.
  const forwardedContent = forwardFileAttachments(msg, a2aMsgId, session, targetAgentGroupId, targetSession.id);

  writeSessionMessage(targetAgentGroupId, targetSession.id, {
    id: a2aMsgId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: forwardedContent,
    // Step 3a: stamp the parent session so the child knows where to reply.
    replyToSession: session.id,
  });

  // Step 5: upsert a2a_context in the child's inbound.db so MCP tools can
  // read reply_to_session without it being threaded through every call.
  upsertA2aContext(targetAgentGroupId, targetSession.id, session.id, session.agent_group_id);

  log.info('Agent message routed', {
    from: session.agent_group_id,
    to: targetAgentGroupId,
    targetSession: targetSession.id,
    a2aMsgId,
    forwardedFileCount: countForwardedFiles(forwardedContent),
  });
  const fresh = getSession(targetSession.id);
  if (fresh) await wakeContainer(fresh);
}

/**
 * Parse source content, copy any referenced `files` from source outbox to
 * target inbox, and return a JSON string with an `attachments` array added
 * (formatter.ts:223 already knows how to render this shape).
 *
 * If the source content isn't JSON or has no files, returns the original
 * content string unchanged — this is safe to call on every route.
 */
function forwardFileAttachments(
  msg: RoutableAgentMessage,
  a2aMsgId: string,
  sourceSession: Session,
  targetAgentGroupId: string,
  targetSessionId: string,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(msg.content);
  } catch {
    return msg.content;
  }
  const files = parsed.files as unknown;
  if (!Array.isArray(files) || files.length === 0) return msg.content;
  const filenames = files.filter((f): f is string => typeof f === 'string');
  if (filenames.length === 0) return msg.content;

  const attachments = forwardAttachedFiles(
    {
      agentGroupId: sourceSession.agent_group_id,
      sessionId: sourceSession.id,
      messageId: msg.id,
      filenames,
    },
    {
      agentGroupId: targetAgentGroupId,
      sessionId: targetSessionId,
      messageId: a2aMsgId,
    },
  );

  // Merge into any existing `attachments` (unlikely in a2a context but safe).
  const existing = Array.isArray(parsed.attachments) ? (parsed.attachments as Record<string, unknown>[]) : [];
  parsed.attachments = [...existing, ...attachments];

  return JSON.stringify(parsed);
}

/**
 * Upsert the a2a_context singleton row in the target session's inbound.db.
 * The container's MCP tools read this to include reply_to_session in outbound
 * messages without needing it threaded through every function call.
 *
 * Must open-write-close per the cross-mount invariant (see session-manager.ts).
 */
function upsertA2aContext(
  targetAgentGroupId: string,
  targetSessionId: string,
  replyToSession: string,
  parentAgentGroupId: string,
): void {
  const dbPath = inboundDbPath(targetAgentGroupId, targetSessionId);
  const db = openInboundDbWriter(dbPath);
  try {
    db.pragma('journal_mode = DELETE');
    db.exec(`CREATE TABLE IF NOT EXISTS a2a_context (
      id                     INTEGER PRIMARY KEY CHECK (id = 1),
      reply_to_session       TEXT,
      parent_agent_group_id  TEXT,
      updated_at             INTEGER NOT NULL
    )`);
    db.prepare(
      `INSERT INTO a2a_context (id, reply_to_session, parent_agent_group_id, updated_at)
       VALUES (1, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         reply_to_session      = excluded.reply_to_session,
         parent_agent_group_id = excluded.parent_agent_group_id,
         updated_at            = excluded.updated_at`,
    ).run(replyToSession, parentAgentGroupId);
  } finally {
    db.close();
  }
  log.debug('a2a_context upserted', { targetSessionId, replyToSession, parentAgentGroupId });
}

function countForwardedFiles(contentStr: string): number {
  try {
    const parsed = JSON.parse(contentStr);
    return Array.isArray(parsed.attachments) ? parsed.attachments.length : 0;
  } catch {
    return 0;
  }
}
