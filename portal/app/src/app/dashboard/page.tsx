'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';
import { api } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';
import StatsCards, { type OverviewStats } from '@/components/StatsCards';
import { StatsCardsSkeleton, TableSkeleton } from '@/components/Skeleton';
import { UserPlus, CreditCard, Clock, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import Link from 'next/link';

interface Client {
  id: string;
  name: string;
  email: string;
  plan: string;
  status: string;
  last_active: string | null;
}

const DEMO_STATS: OverviewStats = {
  totalClients: 12,
  tasksThisMonth: 3847,
  hoursSaved: 511,
  costSaved: 17885,
  deflectionRate: 78,
  avgResponseTime: 1.2,
  csatScore: 4.7,
  afterHoursTasks: 1192,
  monthlyRevenue: 7188,
  planCost: 299,
  daysActive: 14,
};

const DEMO_CLIENTS: Client[] = [
  { id: '1', name: 'Acme Corp',        email: 'ops@acme.com',        plan: 'pro',        status: 'active',   last_active: new Date(Date.now() - 1000 * 60 * 5).toISOString() },
  { id: '2', name: 'Bright Dental',    email: 'admin@brightdental.com', plan: 'starter', status: 'active',   last_active: new Date(Date.now() - 1000 * 60 * 30).toISOString() },
  { id: '3', name: 'Metro Auto',       email: 'info@metroauto.com',   plan: 'enterprise', status: 'active',   last_active: new Date(Date.now() - 1000 * 3600).toISOString() },
  { id: '4', name: 'Lakeside Realty',  email: 'team@lakeside.com',    plan: 'pro',        status: 'inactive', last_active: null },
];

const PLAN_BADGE: Record<string, string> = {
  starter:    'bg-blue-500/10 text-blue-400',
  pro:        'bg-[#f97316]/10 text-[#f97316]',
  enterprise: 'bg-purple-500/10 text-purple-400',
};

const STATUS_BADGE: Record<string, string> = {
  active:    'bg-green-500/10 text-green-400',
  inactive:  'bg-white/[0.06] text-[rgba(245,245,247,0.4)]',
  suspended: 'bg-red-500/10 text-red-400',
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

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) { router.push('/login'); return; }

    Promise.all([
      api.get<OverviewStats>('/api/stats/overview'),
      api.get<Client[]>('/api/clients'),
    ])
      .then(([s, c]) => {
        const hasData = (s.tasksCompleted ?? 0) > 0 || c.length > 0;
        if (!hasData) {
          setStats(DEMO_STATS);
          setClients(DEMO_CLIENTS);
          setIsDemo(true);
        } else {
          setStats(s);
          setClients(c.slice(0, 8));
          setIsDemo(false);
        }
      })
      .catch(() => {
        setStats(DEMO_STATS);
        setClients(DEMO_CLIENTS);
        setIsDemo(true);
      })
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <DashboardShell title="Overview">
      <div className="space-y-6 max-w-7xl mx-auto">
        {/* Stats */}
        {loading ? (
          <StatsCardsSkeleton />
        ) : (
          <StatsCards stats={stats ?? {}} isDemo={isDemo} />
        )}

        {/* Quick Actions */}
        <div className="flex gap-3">
          <Link
            href="/dashboard/clients/new"
            className="flex items-center gap-2 px-4 py-2.5 bg-[#f97316] hover:bg-[#ea6c0a] text-white text-[16px] font-bold rounded-xl transition-colors shadow-lg shadow-[#f97316]/20"
          >
            <UserPlus size={15} strokeWidth={2.5} />
            Add Client
          </Link>
          <Link
            href="/dashboard/billing"
            className="flex items-center gap-2 px-4 py-2.5 bg-[#2a2a2d] hover:bg-white/[0.08] border border-white/[0.06] text-[#F5F5F7] text-[16px] font-bold rounded-xl transition-colors"
          >
            <CreditCard size={15} strokeWidth={2.5} />
            View Billing
          </Link>
        </div>

        {/* Recent Clients Table */}
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06] flex items-center justify-between">
            <h2 className="text-[20px] font-bold text-[#F5F5F7]">Recent Clients</h2>
            <Link
              href="/dashboard/clients"
              className="flex items-center gap-1 text-[16px] text-[#f97316] hover:text-[#ea6c0a] transition-colors"
            >
              View all <ArrowRight size={14} />
            </Link>
          </div>

          {loading ? (
            <TableSkeleton rows={4} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-white/[0.06]">
                    {['Client', 'Last Active', 'Plan', 'Status'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-6 py-3 text-[rgba(245,245,247,0.4)] text-[14px] font-bold uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {clients.map((client) => (
                    <tr key={client.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-4">
                        <div className="text-[16px] font-bold text-[#F5F5F7]">{client.name}</div>
                        <div className="text-[rgba(245,245,247,0.4)] text-[14px] font-semibold">{client.email}</div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5 text-[rgba(245,245,247,0.6)] text-[16px]">
                          <Clock size={13} strokeWidth={2} />
                          {timeAgo(client.last_active)}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={clsx('px-2.5 py-1 rounded-full text-[14px] font-bold capitalize', PLAN_BADGE[client.plan] ?? 'bg-white/[0.06] text-[rgba(245,245,247,0.6)]')}>
                          {client.plan}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <span className={clsx('px-2.5 py-1 rounded-full text-[14px] font-bold capitalize', STATUS_BADGE[client.status] ?? 'bg-white/[0.06] text-[rgba(245,245,247,0.4)]')}>
                          {client.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
