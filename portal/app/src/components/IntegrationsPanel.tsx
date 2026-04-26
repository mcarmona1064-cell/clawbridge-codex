'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { IntegrationsSkeleton } from '@/components/Skeleton';

interface Integration {
  name: string;
  provider: string;
  status: 'connected' | 'disconnected' | 'pending';
  lastSync?: string;
}

const MOCK: Integration[] = [
  { name: 'WhatsApp',        provider: 'whatsapp',        status: 'connected',    lastSync: '2 min ago' },
  { name: 'Slack',           provider: 'slack',           status: 'connected',    lastSync: '5 min ago' },
  { name: 'Telegram',        provider: 'telegram',        status: 'disconnected' },
  { name: 'Google Calendar', provider: 'google-calendar', status: 'pending' },
];

export default function IntegrationsPanel({ clientId }: { clientId?: string }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const path = clientId ? `/api/integrations?clientId=${clientId}` : '/api/integrations';
    api.get<Integration[]>(path)
      .then(setIntegrations)
      .catch(() => setIntegrations(MOCK))
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return <IntegrationsSkeleton />;

  return (
    <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5">
      <h3 className="text-[20px] font-bold text-[#F5F5F7] mb-4">Integrations</h3>
      <div className="space-y-2">
        {integrations.map((int) => {
          const Icon = int.status === 'connected' ? CheckCircle2 : int.status === 'pending' ? Clock : XCircle;
          return (
            <div
              key={int.provider}
              className="flex items-center justify-between px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl"
            >
              <div className="flex items-center gap-3">
                <Icon
                  size={15}
                  strokeWidth={2}
                  className={clsx({
                    'text-green-400':                     int.status === 'connected',
                    'text-yellow-400':                    int.status === 'pending',
                    'text-[rgba(245,245,247,0.3)]':       int.status === 'disconnected',
                  })}
                />
                <span className="text-[16px] font-bold text-[#F5F5F7]">{int.name}</span>
              </div>
              <div className="flex items-center gap-3">
                {int.lastSync && (
                  <span className="text-[rgba(245,245,247,0.4)] text-[14px] font-semibold">{int.lastSync}</span>
                )}
                <span
                  className={clsx('text-[14px] font-bold', {
                    'text-green-400':                  int.status === 'connected',
                    'text-yellow-400':                 int.status === 'pending',
                    'text-[rgba(245,245,247,0.3)]':    int.status === 'disconnected',
                  })}
                >
                  {int.status === 'connected' ? 'Connected' : int.status === 'pending' ? 'Pending' : 'Off'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
