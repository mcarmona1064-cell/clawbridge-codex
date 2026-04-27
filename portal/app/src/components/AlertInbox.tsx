'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';

type Severity = 'P1' | 'P2' | 'P3' | 'P4';

interface Alert {
  id: string;
  severity: Severity;
  title: string;
  client: string;
  time: string;
  detail?: string;
}

const mockAlerts: Alert[] = [
  { id: '1', severity: 'P1', title: 'Agent offline',        client: 'Sunrise Hotels', time: '2m ago',  detail: 'Agent process exited unexpectedly. Last heartbeat 2 minutes ago. Auto-restart attempted 3x.' },
  { id: '2', severity: 'P2', title: 'Auth token expired',   client: 'Metro Auto',     time: '8m ago',  detail: 'WhatsApp session token expired. Agent is queuing messages. Re-auth required.' },
  { id: '3', severity: 'P3', title: 'High latency detected',client: 'TechStart',      time: '14m ago', detail: 'P99 response latency 4.2s (threshold 2s). Elevated DB query times observed.' },
];

const SEVERITY_STYLE: Record<Severity, { pill: string; pulse: boolean }> = {
  P1: { pill: 'bg-[#E84040]/20 text-[#E84040] border border-[#E84040]/40', pulse: true },
  P2: { pill: 'bg-[#F5A623]/15 text-[#F5A623] border border-[#F5A623]/30', pulse: false },
  P3: { pill: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20', pulse: false },
  P4: { pill: 'bg-blue-500/10 text-blue-400 border border-blue-500/20', pulse: false },
};

export default function AlertInbox() {
  const [alerts, setAlerts] = useState<Alert[]>(mockAlerts);
  const [expanded, setExpanded] = useState<string | null>(null);

  function ack(id: string) {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    if (expanded === id) setExpanded(null);
  }

  function toggle(id: string) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  return (
    <div className="bg-[#0F1318] border border-[#252C38] rounded-xl overflow-hidden h-full">
      <div className="px-4 py-3 border-b border-[#252C38] flex items-center justify-between">
        <span className="text-[13px] font-bold text-white uppercase tracking-wider">Alert Inbox</span>
        {alerts.length > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-[#E84040]/15 text-[#E84040] text-[10px] font-bold">
            {alerts.length}
          </span>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2">
          <CheckCircle2 size={22} className="text-[#2ECC71]" />
          <span className="text-[13px] text-[#2ECC71] font-semibold">No active alerts</span>
        </div>
      ) : (
        <div className="divide-y divide-[#252C38]">
          {alerts.map((alert) => {
            const { pill, pulse } = SEVERITY_STYLE[alert.severity];
            const isExpanded = expanded === alert.id;
            return (
              <div key={alert.id} className="px-4 py-3">
                <div
                  className="flex items-center gap-3 cursor-pointer"
                  onClick={() => toggle(alert.id)}
                >
                  {/* Severity badge */}
                  <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold flex-shrink-0', pill, pulse && 'pulse-dot')}>
                    {alert.severity}
                  </span>

                  {/* Center */}
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-bold text-white truncate">{alert.title}</p>
                    <p className="text-[11px] text-[#8892A0] truncate">{alert.client}</p>
                  </div>

                  {/* Right */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className="text-[11px] text-[#8892A0]">{alert.time}</span>
                    {isExpanded ? (
                      <ChevronUp size={12} className="text-[#8892A0]" />
                    ) : (
                      <ChevronDown size={12} className="text-[#8892A0]" />
                    )}
                  </div>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="mt-2 pl-9">
                    {alert.detail && (
                      <p className="text-[12px] text-[#8892A0] mb-2 leading-relaxed">{alert.detail}</p>
                    )}
                    <button
                      onClick={() => ack(alert.id)}
                      className="text-[11px] font-bold text-[#00D4FF] hover:text-white border border-[#00D4FF]/30 hover:border-[#00D4FF] rounded px-2 py-0.5 transition-colors"
                    >
                      Acknowledge
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
