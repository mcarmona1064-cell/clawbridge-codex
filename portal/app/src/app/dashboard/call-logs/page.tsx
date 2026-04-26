'use client';

import { useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { api } from '@/lib/api';
import {
  PhoneIncoming,
  PhoneOutgoing,
  CheckCircle,
  AlertCircle,
  Play,
  ChevronDown,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';

interface CallLog {
  id: string;
  client_id: string;
  call_id: string;
  agent_id: string | null;
  from_number: string | null;
  to_number: string | null;
  direction: 'inbound' | 'outbound';
  status: string;
  duration_seconds: number | null;
  recording_url: string | null;
  transcript: string | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  resolved: number;
  created_at: string;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function SentimentBadge({ sentiment }: { sentiment: CallLog['sentiment'] }) {
  if (!sentiment) return null;
  const map: Record<string, { label: string; cls: string }> = {
    positive: { label: 'Positive', cls: 'bg-green-500/10 text-green-400' },
    neutral:  { label: 'Neutral',  cls: 'bg-white/[0.06] text-[rgba(245,245,247,0.5)]' },
    negative: { label: 'Negative', cls: 'bg-red-500/10 text-red-400' },
  };
  const { label, cls } = map[sentiment] ?? map.neutral;
  return (
    <span className={clsx('px-2 py-0.5 rounded-full text-[12px] font-semibold', cls)}>
      {label}
    </span>
  );
}

function StatusBadge({ resolved, status }: { resolved: number; status: string }) {
  if (status === 'in_progress') {
    return <span className="px-2 py-0.5 rounded-full text-[12px] font-semibold bg-yellow-500/10 text-yellow-400">Live</span>;
  }
  return resolved ? (
    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-semibold bg-green-500/10 text-green-400">
      <CheckCircle size={11} /> Resolved
    </span>
  ) : (
    <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-semibold bg-orange-500/10 text-orange-400">
      <AlertCircle size={11} /> Escalated
    </span>
  );
}

export default function CallLogsPage() {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<CallLog[]>('/api/call-logs')
      .then(setCalls)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <DashboardShell title="Call Logs">
      {loading && (
        <div className="flex items-center justify-center h-48 text-[rgba(245,245,247,0.4)]">
          <Loader2 size={24} className="animate-spin mr-2" /> Loading calls…
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl px-4 py-3 text-[14px]">
          {error}
        </div>
      )}

      {!loading && !error && calls.length === 0 && (
        <div className="flex flex-col items-center justify-center h-48 text-[rgba(245,245,247,0.4)] text-[16px]">
          <PhoneOutgoing size={32} className="mb-3 opacity-40" />
          No call logs yet. Make your first call via the MCP <code>make_call</code> tool.
        </div>
      )}

      {!loading && calls.length > 0 && (
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_1fr_1fr_80px_100px_100px_48px] gap-4 px-5 py-3 border-b border-white/[0.06] text-[rgba(245,245,247,0.4)] text-[12px] font-semibold uppercase tracking-wide">
            <span>Date</span>
            <span>From / To</span>
            <span>Status</span>
            <span>Duration</span>
            <span>Sentiment</span>
            <span>Recording</span>
            <span />
          </div>

          {/* Rows */}
          {calls.map((call) => {
            const expanded = expandedId === call.id;
            return (
              <div key={call.id} className="border-b border-white/[0.04] last:border-0">
                <div
                  className="grid grid-cols-[1fr_1fr_1fr_80px_100px_100px_48px] gap-4 px-5 py-3.5 items-center hover:bg-white/[0.02] cursor-pointer"
                  onClick={() => setExpandedId(expanded ? null : call.id)}
                >
                  <span className="text-[rgba(245,245,247,0.6)] text-[13px]">
                    {formatDate(call.created_at)}
                  </span>

                  <span className="text-[#F5F5F7] text-[13px] flex items-center gap-1.5">
                    {call.direction === 'inbound' ? (
                      <PhoneIncoming size={13} className="text-blue-400 flex-shrink-0" />
                    ) : (
                      <PhoneOutgoing size={13} className="text-[rgba(245,245,247,0.4)] flex-shrink-0" />
                    )}
                    <span className="truncate">
                      {call.from_number ?? '—'} → {call.to_number ?? '—'}
                    </span>
                  </span>

                  <span>
                    <StatusBadge resolved={call.resolved} status={call.status} />
                  </span>

                  <span className="text-[rgba(245,245,247,0.6)] text-[13px]">
                    {formatDuration(call.duration_seconds)}
                  </span>

                  <span>
                    <SentimentBadge sentiment={call.sentiment} />
                  </span>

                  <span>
                    {call.recording_url ? (
                      <a
                        href={call.recording_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-center gap-1.5 text-[#f97316] hover:text-[#ea6c0a] text-[13px] transition-colors"
                      >
                        <Play size={12} fill="currentColor" /> Play
                      </a>
                    ) : (
                      <span className="text-[rgba(245,245,247,0.2)] text-[13px]">—</span>
                    )}
                  </span>

                  <span className="flex justify-center text-[rgba(245,245,247,0.4)]">
                    {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </span>
                </div>

                {/* Expanded transcript */}
                {expanded && (
                  <div className="px-5 pb-5 pt-1">
                    <div className="bg-[#161618] border border-white/[0.06] rounded-xl p-4">
                      <p className="text-[rgba(245,245,247,0.4)] text-[12px] uppercase tracking-wide mb-2 font-semibold">
                        Transcript
                      </p>
                      {call.transcript ? (
                        <p className="text-[rgba(245,245,247,0.8)] text-[14px] leading-relaxed whitespace-pre-wrap font-mono">
                          {call.transcript}
                        </p>
                      ) : (
                        <p className="text-[rgba(245,245,247,0.3)] text-[14px] italic">
                          Transcript not yet available.
                        </p>
                      )}
                      <p className="text-[rgba(245,245,247,0.2)] text-[11px] mt-3">
                        Call ID: {call.call_id}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
