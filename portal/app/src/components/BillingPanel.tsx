'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { BillingSkeleton } from '@/components/Skeleton';

interface Plan { id: string; name: string; price: number; features: string[]; }
interface Invoice { id: string; date: string; amount: number | string; status: 'paid' | 'open' | 'void'; url?: string; }

const PLAN_ACCENT: Record<string, string> = {
  starter: 'text-blue-400 border-blue-400/20',
  pro: 'text-[#f97316] border-[#f97316]/30',
  enterprise: 'text-purple-400 border-purple-400/20',
};

export default function BillingPanel({ clientId, currentPlan = 'starter' }: { clientId?: string; currentPlan?: string }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<Plan[]>('/api/billing/plans'),
      clientId ? api.get<Invoice[]>(`/api/billing/invoices/${clientId}`) : Promise.resolve([]),
    ])
      .then(([p, inv]) => { setPlans(p); setInvoices(inv); })
      .catch(() => setPlans([
        { id: 'starter',    name: 'Starter',    price: 299,  features: ['1 agent', 'WhatsApp', '5k tasks/mo'] },
        { id: 'pro',        name: 'Pro',         price: 599,  features: ['3 agents', 'All channels', '20k tasks/mo'] },
        { id: 'enterprise', name: 'Enterprise',  price: 1299, features: ['Unlimited agents', 'Priority SLA', 'Custom'] },
      ]))
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading) return <BillingSkeleton />;

  return (
    <div className="space-y-4">
      {/* Plans */}
      <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5">
        <h3 className="text-[20px] font-bold text-[#F5F5F7] mb-4">Plans</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {plans.map((plan) => {
            const active = plan.id === currentPlan;
            return (
              <div
                key={plan.id}
                className={clsx(
                  'rounded-xl p-4 border transition-colors',
                  active
                    ? 'border-[#f97316]/30 bg-[#f97316]/5'
                    : 'border-white/[0.06] bg-[#161618]'
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={clsx('text-[16px] font-bold capitalize', PLAN_ACCENT[plan.id]?.split(' ')[0] ?? 'text-[#F5F5F7]')}>
                    {plan.name}
                  </span>
                  {active && (
                    <span className="text-[12px] bg-[#f97316]/15 text-[#f97316] px-2 py-0.5 rounded-full font-bold">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-[20px] font-bold text-[#F5F5F7] mb-3">
                  ${plan.price}<span className="text-[rgba(245,245,247,0.4)] text-[14px] font-semibold">/mo</span>
                </div>
                <ul className="space-y-1">
                  {plan.features.map((f) => (
                    <li key={f} className="text-[rgba(245,245,247,0.6)] text-[14px] font-semibold flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-white/20 flex-shrink-0" />{f}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div className="bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-5">
          <h3 className="text-[20px] font-bold text-[#F5F5F7] mb-4">Invoices</h3>
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl">
                <span className="text-[16px] font-bold text-[#F5F5F7]">{inv.date}</span>
                <div className="flex items-center gap-3">
                  <span className="text-[16px] font-bold text-[#F5F5F7]">${inv.amount}</span>
                  <span className={clsx('text-[14px] font-bold px-2 py-0.5 rounded-full', {
                    'bg-green-500/10 text-green-400': inv.status === 'paid',
                    'bg-yellow-500/10 text-yellow-400': inv.status === 'open',
                    'bg-white/[0.06] text-[rgba(245,245,247,0.4)]': inv.status === 'void',
                  })}>
                    {inv.status}
                  </span>
                  {inv.url && (
                    <a href={inv.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={14} className="text-[rgba(245,245,247,0.4)] hover:text-[#F5F5F7]" />
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
