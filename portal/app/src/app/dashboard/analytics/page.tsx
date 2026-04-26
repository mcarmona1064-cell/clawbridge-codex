'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { isAuthenticated } from '@/lib/auth';
import DashboardShell from '@/components/DashboardShell';
import { Skeleton } from '@/components/Skeleton';

const MONTHS = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'];

const TASKS_DATA = MONTHS.map((month, i) => ({
  month,
  tasks: [1200, 1850, 2100, 2780, 3400, 3847][i],
  industry: [900, 1100, 1300, 1500, 1700, 1900][i],
}));

const CSAT_DATA = MONTHS.map((month, i) => ({
  month,
  csat: [4.2, 4.3, 4.5, 4.6, 4.6, 4.7][i],
  industry: [4.0, 4.0, 4.1, 4.1, 4.1, 4.1][i],
}));

const DEFLECTION_DATA = MONTHS.map((month, i) => ({
  month,
  rate: [58, 63, 67, 72, 75, 78][i],
  industry: 55,
}));

const RESPONSE_DATA = MONTHS.map((month, i) => ({
  month,
  yours: [3.2, 2.8, 2.1, 1.8, 1.4, 1.2][i],
  industry: 4.5,
}));

const CHART_STYLE = {
  cartesian: { stroke: 'rgba(255,255,255,0.04)' },
  xAxis: { stroke: 'none', tick: { fill: 'rgba(245,245,247,0.4)', fontSize: 14, fontWeight: 600 } },
  yAxis: { stroke: 'none', tick: { fill: 'rgba(245,245,247,0.4)', fontSize: 14, fontWeight: 600 } },
  tooltip: {
    contentStyle: { background: '#2a2a2d', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 12, color: '#F5F5F7', fontSize: 14, fontWeight: 600 },
    cursor: { fill: 'rgba(255,255,255,0.03)' },
  },
  legend: { wrapperStyle: { fontSize: 14, fontWeight: 600, color: 'rgba(245,245,247,0.6)' } },
};

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5">
      <h3 className="text-[20px] font-bold text-[#F5F5F7] mb-5">{title}</h3>
      <div className="h-52">{children}</div>
    </div>
  );
}

export default function AnalyticsPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) { router.push('/login'); return; }
    // Simulate a brief load for skeleton demo
    const t = setTimeout(() => setReady(true), 600);
    return () => clearTimeout(t);
  }, [router]);

  return (
    <DashboardShell title="Analytics">
      <div className="space-y-5 max-w-7xl mx-auto">

        {/* Benchmark banner */}
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl px-5 py-4 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#f97316] flex-shrink-0" />
          <p className="text-[16px] text-[rgba(245,245,247,0.6)]">
            Industry benchmarks shown in <span className="text-[rgba(245,245,247,0.4)]">grey</span> — your metrics in <span className="text-[#f97316]">orange</span>.
            Data sourced from ClawBridge aggregate (anonymised, n=200+ deployments).
          </p>
        </div>

        {!ready ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 space-y-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-52 w-full" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Tasks handled — bar */}
            <ChartCard title="Tasks Handled per Month">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={TASKS_DATA} barGap={4}>
                  <CartesianGrid vertical={false} {...CHART_STYLE.cartesian} />
                  <XAxis dataKey="month" {...CHART_STYLE.xAxis} />
                  <YAxis {...CHART_STYLE.yAxis} />
                  <Tooltip {...CHART_STYLE.tooltip} />
                  <Legend {...CHART_STYLE.legend} />
                  <Bar dataKey="tasks" name="Your agent" fill="#f97316" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="industry" name="Industry avg" fill="rgba(255,255,255,0.1)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* CSAT — line */}
            <ChartCard title="CSAT Score Trend">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={CSAT_DATA}>
                  <CartesianGrid vertical={false} {...CHART_STYLE.cartesian} />
                  <XAxis dataKey="month" {...CHART_STYLE.xAxis} />
                  <YAxis domain={[3.5, 5]} {...CHART_STYLE.yAxis} />
                  <Tooltip {...CHART_STYLE.tooltip} />
                  <Legend {...CHART_STYLE.legend} />
                  <Line type="monotone" dataKey="csat" name="Your agent" stroke="#f97316" strokeWidth={2} dot={{ fill: '#f97316', r: 3 }} />
                  <Line type="monotone" dataKey="industry" name="Industry avg" stroke="rgba(255,255,255,0.2)" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Deflection rate — line */}
            <ChartCard title="Deflection Rate % (vs 55% industry avg)">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={DEFLECTION_DATA}>
                  <CartesianGrid vertical={false} {...CHART_STYLE.cartesian} />
                  <XAxis dataKey="month" {...CHART_STYLE.xAxis} />
                  <YAxis domain={[40, 90]} unit="%" {...CHART_STYLE.yAxis} />
                  <Tooltip {...CHART_STYLE.tooltip} formatter={(v: number) => `${v}%`} />
                  <Legend {...CHART_STYLE.legend} />
                  <Line type="monotone" dataKey="rate" name="Your rate" stroke="#f97316" strokeWidth={2} dot={{ fill: '#f97316', r: 3 }} />
                  <Line type="monotone" dataKey="industry" name="Industry avg" stroke="rgba(255,255,255,0.2)" strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* Response time — bar */}
            <ChartCard title="Avg Response Time (min) — lower is better">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={RESPONSE_DATA} barGap={4}>
                  <CartesianGrid vertical={false} {...CHART_STYLE.cartesian} />
                  <XAxis dataKey="month" {...CHART_STYLE.xAxis} />
                  <YAxis unit="m" {...CHART_STYLE.yAxis} />
                  <Tooltip {...CHART_STYLE.tooltip} formatter={(v: number) => `${v} min`} />
                  <Legend {...CHART_STYLE.legend} />
                  <Bar dataKey="yours" name="Your agent" fill="#f97316" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="industry" name="Industry avg" fill="rgba(255,255,255,0.1)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

          </div>
        )}
      </div>
    </DashboardShell>
  );
}
