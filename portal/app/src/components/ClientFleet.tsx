'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import clsx from 'clsx';

type ClientStatus = 'running' | 'degraded' | 'error' | 'offline';

interface FleetClient {
  id: string;
  name: string;
  status: ClientStatus;
  last_active: string | null;
  messageVolume: number;
  maxVolume: number;
  errorCount: number;
  uptime: number;
}

const MOCK_CLIENTS: FleetClient[] = [
  { id: '1', name: 'Acme Corp',       status: 'running',  last_active: new Date(Date.now() - 2 * 60000).toISOString(),   messageVolume: 420, maxVolume: 500, errorCount: 0,  uptime: 99.8 },
  { id: '2', name: 'Bright Dental',   status: 'running',  last_active: new Date(Date.now() - 15 * 60000).toISOString(),  messageVolume: 180, maxVolume: 500, errorCount: 0,  uptime: 99.1 },
  { id: '3', name: 'Metro Auto',      status: 'degraded', last_active: new Date(Date.now() - 3600000).toISOString(),     messageVolume: 95,  maxVolume: 500, errorCount: 3,  uptime: 94.5 },
  { id: '4', name: 'Lakeside Realty', status: 'offline',  last_active: null,                                             messageVolume: 0,   maxVolume: 500, errorCount: 0,  uptime: 71.2 },
  { id: '5', name: 'TechStart',       status: 'running',  last_active: new Date(Date.now() - 5 * 60000).toISOString(),   messageVolume: 310, maxVolume: 500, errorCount: 1,  uptime: 98.3 },
  { id: '6', name: 'Sunrise Hotels',  status: 'error',    last_active: new Date(Date.now() - 20 * 60000).toISOString(),  messageVolume: 12,  maxVolume: 500, errorCount: 17, uptime: 82.0 },
];

const STATUS_DOT: Record<ClientStatus, string> = {
  running:  'bg-[#2ECC71]',
  degraded: 'bg-[#F5A623]',
  error:    'bg-[#E84040]',
  offline:  'bg-[#8892A0]',
};

const STATUS_LABEL: Record<ClientStatus, string> = {
  running:  'Running',
  degraded: 'Degraded',
  error:    'Error',
  offline:  'Offline',
};

const STATUS_TEXT: Record<ClientStatus, string> = {
  running:  'text-[#2ECC71]',
  degraded: 'text-[#F5A623]',
  error:    'text-[#E84040]',
  offline:  'text-[#8892A0]',
};

function timeAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ClientFleet() {
  const router = useRouter();
  const [clients, setClients] = useState<FleetClient[]>(MOCK_CLIENTS);

  useEffect(() => {
    api.get<Array<{ id: string; name: string; status: string; last_active: string | null }>>('/api/clients')
      .then((data) => {
        if (data.length > 0) {
          setClients(
            data.map((c) => ({
              id: c.id,
              name: c.name,
              status: (c.status === 'active' ? 'running' : 'offline') as ClientStatus,
              last_active: c.last_active,
              messageVolume: Math.floor(Math.random() * 400),
              maxVolume: 500,
              errorCount: 0,
              uptime: 99.0,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="bg-[#0F1318] border border-[#252C38] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#252C38] flex items-center justify-between">
        <span className="text-[13px] font-bold text-white uppercase tracking-wider">Client Fleet</span>
        <span className="text-[11px] text-[#8892A0]">{clients.filter(c => c.status === 'running').length} online</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
        {clients.map((client) => (
          <div
            key={client.id}
            onClick={() => router.push(`/dashboard/clients/${client.id}`)}
            className="bg-[#0F1318] border border-[#252C38] rounded-lg p-3 hover:border-[#00D4FF] transition-colors cursor-pointer"
          >
            {/* Top row */}
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={clsx('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_DOT[client.status])} />
                  <span className={clsx('text-[10px] font-bold uppercase tracking-wide', STATUS_TEXT[client.status])}>
                    {STATUS_LABEL[client.status]}
                  </span>
                </div>
                <span className="text-[13px] font-bold text-white">{client.name}</span>
              </div>
              {client.errorCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-[#E84040]/15 text-[#E84040] text-[10px] font-bold">
                  {client.errorCount} err
                </span>
              )}
            </div>

            {/* Message volume bar */}
            <div className="mb-2">
              <div className="flex justify-between mb-1">
                <span className="text-[10px] text-[#8892A0]">Volume</span>
                <span className="text-[10px] text-[#8892A0]">{client.messageVolume}</span>
              </div>
              <div className="h-1 bg-[#1A1F28] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#00D4FF] rounded-full transition-all"
                  style={{ width: `${Math.min(100, (client.messageVolume / client.maxVolume) * 100)}%` }}
                />
              </div>
            </div>

            {/* Bottom row */}
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-[#8892A0]">{timeAgo(client.last_active)}</span>
              <span className="text-[10px] text-[#8892A0]">{client.uptime}% uptime</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
