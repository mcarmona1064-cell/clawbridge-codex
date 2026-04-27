'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { LineChart, Line, ResponsiveContainer, Tooltip } from 'recharts';
import clsx from 'clsx';

export interface OverviewStats {
  totalClients?: number;
  tasksCompleted?: number;
  messagesProcessed?: number;
  monthlyRevenue?: number;
  tasksThisMonth?: number;
  hoursSaved?: number;
  costSaved?: number;
  deflectionRate?: number;
  avgResponseTime?: number;
  csatScore?: number;
  afterHoursTasks?: number;
  planCost?: number;
  daysActive?: number;
  // Mission control fields
  systemHealth?: number;
  activeAgents?: number;
  messagesToday?: number;
  errorRate?: number;
}

// Generate mock 24h sparkline data
function mockSparkline(base: number, variance: number, points = 12) {
  return Array.from({ length: points }, (_, i) => ({
    t: i,
    v: Math.max(0, base + (Math.random() - 0.5) * variance * 2),
  }));
}

const MOCK_HEALTH_SPARK = mockSparkline(97, 3);
const MOCK_AGENTS_SPARK = mockSparkline(8, 2);
const MOCK_MSGS_SPARK   = mockSparkline(350, 80);
const MOCK_ERR_SPARK    = mockSparkline(0.4, 0.3);

interface MiniSparkProps {
  data: { t: number; v: number }[];
  color: string;
}

function MiniSpark({ data, color }: MiniSparkProps) {
  return (
    <ResponsiveContainer width="100%" height={36}>
      <LineChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <Line
          type="monotone"
          dataKey="v"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
        <Tooltip
          contentStyle={{ display: 'none' }}
          cursor={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

interface StatsCardsProps {
  stats?: OverviewStats;
  isDemo?: boolean;
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function StatsCards({ stats = {}, isDemo }: StatsCardsProps) {
  const health = stats.systemHealth ?? 97;
  const agents = stats.activeAgents ?? 8;
  const msgs   = stats.messagesToday ?? 8400;
  const errRate = stats.errorRate ?? 0.4;

  const healthColor = health >= 95 ? '#2ECC71' : health >= 80 ? '#F5A623' : '#E84040';
  const errColor    = errRate > 1   ? '#E84040' : errRate > 0.3 ? '#F5A623' : '#2ECC71';

  const cards = [
    {
      label: 'System Health',
      value: `${health}`,
      unit: '',
      sub: 'Overall score',
      color: healthColor,
      spark: MOCK_HEALTH_SPARK,
      extra: (
        <span className="text-[11px] font-bold" style={{ color: healthColor }}>
          {health >= 95 ? 'Nominal' : health >= 80 ? 'Degraded' : 'Critical'}
        </span>
      ),
    },
    {
      label: 'Active Agents',
      value: String(agents),
      unit: '',
      sub: 'Running now',
      color: '#00D4FF',
      spark: MOCK_AGENTS_SPARK,
      extra: (
        <span className="flex items-center gap-1 text-[11px] text-[#8892A0]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#00D4FF] pulse-dot" />
          Live
        </span>
      ),
    },
    {
      label: 'Messages Today',
      value: formatCount(msgs),
      unit: '',
      sub: 'Last 24h',
      color: '#7B68EE',
      spark: MOCK_MSGS_SPARK,
      extra: null,
    },
    {
      label: 'Error Rate',
      value: `${errRate.toFixed(1)}%`,
      unit: '',
      sub: 'Last 24h',
      color: errColor,
      spark: MOCK_ERR_SPARK,
      extra: (
        <span className="text-[11px] font-bold" style={{ color: errColor }}>
          {errRate > 1 ? 'Above threshold' : errRate > 0.3 ? 'Elevated' : 'Normal'}
        </span>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="bg-[#0F1318] border border-[#252C38] rounded-xl p-4 flex flex-col gap-1"
        >
          <span className="text-[11px] uppercase tracking-wider text-[#8892A0] font-bold">{card.label}</span>
          <div className="flex items-end justify-between">
            <span className="font-mono text-[32px] font-bold leading-none" style={{ color: card.color }}>
              {card.value}
            </span>
            {card.extra}
          </div>
          <span className="text-[11px] text-[#8892A0]">{card.sub}</span>
          <div className="mt-1">
            <MiniSpark data={card.spark} color={card.color} />
          </div>
        </div>
      ))}
      {isDemo && (
        <div className="col-span-full rounded-xl border border-[#00D4FF]/20 bg-[#00D4FF]/5 px-4 py-2.5 text-[13px] text-[#8892A0]">
          <span className="text-[#00D4FF] font-bold">Demo data</span> — metrics will populate once your agents start handling traffic.
        </div>
      )}
    </div>
  );
}
