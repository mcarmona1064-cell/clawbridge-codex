'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';
import { api } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';
import StatsCards, { type OverviewStats } from '@/components/StatsCards';
import { StatsCardsSkeleton } from '@/components/Skeleton';
import IntegrationsPanel from '@/components/IntegrationsPanel';
import BillingPanel from '@/components/BillingPanel';

interface ClientDetail {
  id: string;
  name: string;
  email: string;
  subdomain: string;
  plan: string;
  status: string;
  created_at: string;
  last_active: string | null;
}

export default function ClientPage() {
  const router = useRouter();
  const params = useParams();
  const subdomain = params.client as string;
  const [client, setClient] = useState<ClientDetail | null>(null);
  const [stats, setStats] = useState<OverviewStats | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) { router.push('/login'); return; }
    api.get<ClientDetail[]>('/api/clients')
      .then((clients) => {
        const found = clients.find((c) => c.subdomain === subdomain || c.id === subdomain);
        if (!found) { router.push('/dashboard'); return; }
        setClient(found);
        return api.get<OverviewStats>(`/api/stats/client/${found.id}`);
      })
      .then((s) => s && setStats(s))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [router, subdomain]);

  if (loading || !client) {
    return (
      <DashboardShell title="Loading…">
        <div className="max-w-5xl mx-auto space-y-6">
          <StatsCardsSkeleton />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell title={client.name}>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Client header */}
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 flex items-center justify-between">
          <div>
            <h2 className="text-[28px] font-bold text-[#F5F5F7]">{client.name}</h2>
            <p className="text-[rgba(245,245,247,0.6)] text-[16px] mt-0.5">{client.email}</p>
            <p className="text-[rgba(245,245,247,0.4)] text-[14px] font-semibold mt-1">
              {client.subdomain}.clawbridgeagency.com
            </p>
          </div>
          <div className="text-right">
            <span className="inline-block px-3 py-1 rounded-full text-[14px] font-bold bg-green-500/10 text-green-400 capitalize">
              {client.status}
            </span>
            <p className="text-[rgba(245,245,247,0.4)] text-[14px] font-semibold mt-2">
              Since {new Date(client.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>

        <StatsCards stats={stats ?? {}} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <IntegrationsPanel clientId={client.id} />
          <BillingPanel clientId={client.id} currentPlan={client.plan} />
        </div>
      </div>
    </DashboardShell>
  );
}
