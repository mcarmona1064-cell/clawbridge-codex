'use client';

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

// Generate 24h mock data (hourly)
function mock24h() {
  const now = new Date();
  const currentHour = now.getHours();
  return Array.from({ length: 24 }, (_, i) => {
    const hour = i;
    const base = hour < 6 ? 20 : hour < 9 ? 80 : hour < 12 ? 300 : hour < 14 ? 420 : hour < 17 ? 380 : hour < 20 ? 220 : 80;
    const v = hour <= currentHour ? Math.max(0, base + (Math.random() - 0.5) * base * 0.4) : null;
    return {
      hour: `${String(hour).padStart(2, '0')}:00`,
      messages: v !== null ? Math.round(v) : undefined,
    };
  });
}

const DATA = mock24h();

const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ value?: number }>; label?: string }) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-[#1A1F28] border border-[#252C38] rounded-lg px-3 py-2 text-[12px]">
        <p className="text-[#8892A0] mb-0.5">{label}</p>
        <p className="text-[#00D4FF] font-bold font-mono">{payload[0].value?.toLocaleString()} msgs</p>
      </div>
    );
  }
  return null;
};

export default function VolumeChart() {
  return (
    <div className="bg-[#0F1318] border border-[#252C38] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#252C38] flex items-center justify-between">
        <span className="text-[13px] font-bold text-white uppercase tracking-wider">24h Message Volume</span>
        <span className="text-[11px] text-[#8892A0]">All clients combined</span>
      </div>
      <div className="px-4 py-3" style={{ height: '140px' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={DATA} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="cyanGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#00D4FF" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#00D4FF" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#252C38" vertical={false} />
            <XAxis
              dataKey="hour"
              tick={{ fill: '#8892A0', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval={3}
            />
            <YAxis
              tick={{ fill: '#8892A0', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(1)}k` : String(v)}
            />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="messages"
              stroke="#00D4FF"
              strokeWidth={1.5}
              fill="url(#cyanGrad)"
              dot={false}
              activeDot={{ r: 3, fill: '#00D4FF', strokeWidth: 0 }}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
