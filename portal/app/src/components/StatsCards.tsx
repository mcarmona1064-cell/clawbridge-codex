import {
  CheckCircle2,
  Clock,
  DollarSign,
  ShieldCheck,
  Zap,
  Star,
  Moon,
  TrendingUp,
} from 'lucide-react';
import clsx from 'clsx';

export interface OverviewStats {
  totalClients?: number;
  tasksCompleted?: number;
  messagesProcessed?: number;
  monthlyRevenue?: number;
  // Extended metrics
  tasksThisMonth?: number;
  hoursSaved?: number;
  costSaved?: number;
  deflectionRate?: number;
  avgResponseTime?: number;
  csatScore?: number;
  afterHoursTasks?: number;
  planCost?: number;
  daysActive?: number;
}

interface Benchmark {
  label: string;
  yours: number | string;
  industry: number | string;
  unit?: string;
  higherIsBetter?: boolean;
}

const BENCHMARKS: Benchmark[] = [
  { label: 'Deflection Rate',   yours: 78,  industry: 55, unit: '%',  higherIsBetter: true },
  { label: 'Avg Response Time', yours: 1.2, industry: 4.5, unit: 'min', higherIsBetter: false },
  { label: 'CSAT Score',        yours: 4.7, industry: 4.1, unit: '/5', higherIsBetter: true },
];

interface StatCard {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: boolean;
  benchmarkIdx?: number;
}

function buildCards(stats: OverviewStats): StatCard[] {
  const tasks = stats.tasksThisMonth ?? stats.tasksCompleted ?? 0;
  const avgMinutes = 8; // minutes per task saved
  const hoursSaved = stats.hoursSaved ?? Math.round((tasks * avgMinutes) / 60);
  const costSaved = stats.costSaved ?? Math.round(hoursSaved * 35); // $35/hr labor
  const deflection = stats.deflectionRate ?? 78;
  const responseMin = stats.avgResponseTime ?? 1.2;
  const csat = stats.csatScore ?? 4.7;
  const afterHours = stats.afterHoursTasks ?? Math.round(tasks * 0.31);

  return [
    {
      label: 'Tasks Handled',
      value: tasks.toLocaleString(),
      sub: 'this month',
      icon: CheckCircle2,
      benchmarkIdx: undefined,
    },
    {
      label: 'Hours Saved',
      value: hoursSaved.toLocaleString(),
      sub: `≈ ${tasks} tasks × ${avgMinutes} min avg`,
      icon: Clock,
    },
    {
      label: 'Cost Saved',
      value: `$${costSaved.toLocaleString()}`,
      sub: 'vs. human agents @ $35/hr',
      icon: DollarSign,
    },
    {
      label: 'Deflection Rate',
      value: `${deflection}%`,
      sub: 'industry avg 55%',
      icon: ShieldCheck,
      benchmarkIdx: 0,
    },
    {
      label: 'Avg Response Time',
      value: `${responseMin}m`,
      sub: 'industry avg 4.5 min',
      icon: Zap,
      benchmarkIdx: 1,
    },
    {
      label: 'CSAT Score',
      value: `${csat}/5`,
      sub: 'industry avg 4.1',
      icon: Star,
      benchmarkIdx: 2,
    },
    {
      label: 'After-Hours Recovery',
      value: afterHours.toLocaleString(),
      sub: 'tasks outside 9–5',
      icon: Moon,
    },
  ];
}

function roiDays(stats: OverviewStats): number {
  const planCost = stats.planCost ?? 299;
  const dailyCostSaved = ((stats.costSaved ?? 0) || (stats.hoursSaved ?? 0) * 35) / 30;
  if (dailyCostSaved <= 0) return 0;
  return Math.round(planCost / dailyCostSaved);
}

function BenchmarkBar({ b }: { b: Benchmark }) {
  const yoursNum = typeof b.yours === 'number' ? b.yours : parseFloat(String(b.yours));
  const industryNum = typeof b.industry === 'number' ? b.industry : parseFloat(String(b.industry));
  const max = Math.max(yoursNum, industryNum) * 1.3;
  const yoursPct = (yoursNum / max) * 100;
  const industryPct = (industryNum / max) * 100;
  const winning = b.higherIsBetter ? yoursNum >= industryNum : yoursNum <= industryNum;

  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className={clsx('h-full rounded-full', winning ? 'bg-green-400' : 'bg-yellow-400')}
            style={{ width: `${yoursPct}%` }}
          />
        </div>
        <span className="text-[12px] text-[rgba(245,245,247,0.6)] w-16 text-right">You</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-white/20"
            style={{ width: `${industryPct}%` }}
          />
        </div>
        <span className="text-[12px] text-[rgba(245,245,247,0.6)] w-16 text-right">Industry</span>
      </div>
    </div>
  );
}

interface StatsCardsProps {
  stats?: OverviewStats;
  isDemo?: boolean;
}

export default function StatsCards({ stats = {}, isDemo }: StatsCardsProps) {
  const cards = buildCards(stats);
  const roi = roiDays(stats);

  return (
    <div className="space-y-4">
      {/* ROI Hero Card */}
      <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 flex items-center gap-5">
        <div className="p-3 rounded-xl bg-[#f97316]/10">
          <TrendingUp size={22} className="text-[#f97316]" />
        </div>
        <div>
          <p className="text-[rgba(245,245,247,0.6)] text-[16px]">Return on investment</p>
          {roi > 0 ? (
            <p className="text-[28px] font-bold text-[#F5F5F7]">
              Your agent paid for itself{' '}
              <span className="text-[#f97316]">{roi} days ago</span>
            </p>
          ) : (
            <p className="text-[28px] font-bold text-[#F5F5F7]">
              ROI tracking starts after first full month
            </p>
          )}
        </div>
      </div>

      {/* 7 Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((card, i) => {
          const Icon = card.icon;
          const hasBenchmark = card.benchmarkIdx !== undefined;
          const benchmark = hasBenchmark ? BENCHMARKS[card.benchmarkIdx!] : null;
          // Only first card gets accent color treatment
          const isFirst = i === 0;

          return (
            <div
              key={card.label}
              className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <span className="text-[rgba(245,245,247,0.6)] text-[16px]">{card.label}</span>
                <div className={clsx(
                  'p-2 rounded-xl',
                  isFirst ? 'bg-[#f97316]/10' : 'bg-white/[0.06]'
                )}>
                  <Icon
                    size={16}
                    strokeWidth={2}
                    className={isFirst ? 'text-[#f97316]' : 'text-[rgba(245,245,247,0.6)]'}
                  />
                </div>
              </div>

              <div className="text-[28px] font-bold text-[#F5F5F7]">{card.value}</div>

              {card.sub && (
                <p className="text-[rgba(245,245,247,0.6)] text-[14px] font-semibold leading-tight">
                  {card.sub}
                </p>
              )}

              {benchmark && <BenchmarkBar b={benchmark} />}
            </div>
          );
        })}

        {/* 8th card — placeholder for "this month" sparkline space */}
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[rgba(245,245,247,0.6)] text-[16px]">Monthly Revenue</span>
            <div className="p-2 rounded-xl bg-white/[0.06]">
              <DollarSign size={16} strokeWidth={2} className="text-[rgba(245,245,247,0.6)]" />
            </div>
          </div>
          <div className="text-[28px] font-bold text-[#F5F5F7]">
            ${(stats.monthlyRevenue ?? 0).toLocaleString()}
          </div>
          <p className="text-[rgba(245,245,247,0.6)] text-[14px] font-semibold">active subscriptions</p>
        </div>
      </div>

      {isDemo && (
        <div className="rounded-xl border border-[#f97316]/30 bg-[#f97316]/5 px-5 py-3 text-[16px] text-[rgba(245,245,247,0.6)]">
          <span className="text-[#f97316] font-bold">Demo data</span> — this is what your dashboard will look like once your agent starts handling tasks.
        </div>
      )}
    </div>
  );
}
