'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import clsx from 'clsx';

type EventType = 'message' | 'success' | 'error' | 'memory' | 'warning';

interface FeedEvent {
  id: string;
  type: EventType;
  text: string;
  time: string;
}

const TYPE_BORDER: Record<EventType, string> = {
  message: 'border-l-[#00D4FF]',
  success: 'border-l-[#2ECC71]',
  error:   'border-l-[#E84040]',
  memory:  'border-l-[#7B68EE]',
  warning: 'border-l-[#F5A623]',
};

const MOCK_EVENTS: FeedEvent[] = [
  { id: '1',  type: 'message', text: 'agent_42 · message received from @john',       time: '0:04' },
  { id: '2',  type: 'success', text: 'agent_42 · task completed: booking confirmed',  time: '0:12' },
  { id: '3',  type: 'message', text: 'agent_07 · message received from @sarah',       time: '0:31' },
  { id: '4',  type: 'warning', text: 'agent_03 · response latency 2.1s',              time: '1:04' },
  { id: '5',  type: 'error',   text: 'agent_12 · tool call failed: calendar_api',     time: '1:18' },
  { id: '6',  type: 'memory',  text: 'agent_07 · memory updated: user preferences',  time: '1:55' },
  { id: '7',  type: 'message', text: 'agent_42 · message received from @mike',        time: '2:03' },
  { id: '8',  type: 'success', text: 'agent_03 · handoff complete to human agent',    time: '2:30' },
  { id: '9',  type: 'message', text: 'agent_05 · message received from @lisa',        time: '3:11' },
  { id: '10', type: 'warning', text: 'agent_12 · retry 2/3 for calendar_api',         time: '3:18' },
];

function formatNow(): string {
  const d = new Date();
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

const EVENT_TYPES: EventType[] = ['message', 'success', 'error', 'memory', 'warning'];
const EVENT_TEXTS: Record<EventType, string[]> = {
  message: ['message received from @user', 'inbound message queued', 'reply sent to @user'],
  success: ['task completed', 'booking confirmed', 'escalation resolved'],
  error:   ['tool call failed', 'API timeout', 'webhook delivery failed'],
  memory:  ['memory updated', 'context stored', 'preference saved'],
  warning: ['high latency detected', 'retry attempt', 'rate limit approaching'],
};

let nextId = 100;
function randomEvent(): FeedEvent {
  const type = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
  const agentNum = Math.floor(Math.random() * 20) + 1;
  const texts = EVENT_TEXTS[type];
  const text = `agent_${String(agentNum).padStart(2, '0')} · ${texts[Math.floor(Math.random() * texts.length)]}`;
  return { id: String(nextId++), type, text, time: formatNow() };
}

export default function ActivityFeed() {
  const [events, setEvents] = useState<FeedEvent[]>(MOCK_EVENTS);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Poll /api/stats/activity every 5s
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await api.get<Array<{ event_type: string; metadata: string; created_at: string; client_name: string }>>('/api/stats/activity');
        if (data.length > 0) {
          const mapped: FeedEvent[] = data.map((e, i) => ({
            id: String(i),
            type: e.event_type.includes('error') ? 'error'
                : e.event_type.includes('memory') ? 'memory'
                : e.event_type.includes('warn') ? 'warning'
                : e.event_type.includes('success') || e.event_type.includes('completed') ? 'success'
                : 'message',
            text: `${e.client_name} · ${e.event_type}`,
            time: new Date(e.created_at).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          }));
          setEvents(mapped);
          return;
        }
      } catch {}
      // Real API unavailable — simulate a new event
      setEvents((prev) => {
        const next = [...prev, randomEvent()].slice(-50);
        return next;
      });
    };

    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div className="bg-[#0F1318] border border-[#252C38] rounded-xl overflow-hidden flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[#252C38] flex items-center justify-between flex-shrink-0">
        <span className="text-[13px] font-bold text-white uppercase tracking-wider">Activity Feed</span>
        <span className="flex items-center gap-1 text-[11px] text-[#8892A0]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#2ECC71] pulse-dot" />
          Live
        </span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto"
        style={{ maxHeight: '340px' }}
      >
        {events.map((ev) => (
          <div
            key={ev.id}
            className={clsx(
              'flex items-center gap-3 px-4 py-2 border-l-2 hover:bg-[#1A1F28] transition-colors',
              TYPE_BORDER[ev.type]
            )}
          >
            <p className="flex-1 text-[12px] text-[#C8D0DC] leading-relaxed truncate">{ev.text}</p>
            <span className="text-[10px] text-[#8892A0] flex-shrink-0 font-mono">{ev.time}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
