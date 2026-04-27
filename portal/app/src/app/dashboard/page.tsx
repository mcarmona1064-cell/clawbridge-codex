'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated } from '@/lib/auth';
import { api } from '@/lib/api';
import DashboardShell from '@/components/DashboardShell';
import StatsCards, { type OverviewStats } from '@/components/StatsCards';
import ClientFleet from '@/components/ClientFleet';
import AlertInbox from '@/components/AlertInbox';
import ActivityFeed from '@/components/ActivityFeed';
import VolumeChart from '@/components/VolumeChart';

export default function DashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) { router.push('/login'); return; }

    api.get<OverviewStats>('/api/stats/overview')
      .then((s) => {
        const hasData = (s.tasksCompleted ?? 0) > 0;
        if (!hasData) {
          setStats({
            systemHealth: 97,
            activeAgents: 8,
            messagesToday: 8400,
            errorRate: 0.4,
            ...s,
          });
          setIsDemo(true);
        } else {
          setStats(s);
          setIsDemo(false);
        }
      })
      .catch(() => {
        setStats({ systemHealth: 97, activeAgents: 8, messagesToday: 8400, errorRate: 0.4 });
        setIsDemo(true);
      });
  }, [router]);

  return (
    <DashboardShell alertCount={2}>
      <div className="space-y-4">
        <StatsCards stats={stats ?? {}} isDemo={isDemo} />
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 lg:col-span-5"><ClientFleet /></div>
          <div className="col-span-12 lg:col-span-3"><AlertInbox /></div>
          <div className="col-span-12 lg:col-span-4"><ActivityFeed /></div>
        </div>
        <VolumeChart />
      </div>
    </DashboardShell>
  );
}
