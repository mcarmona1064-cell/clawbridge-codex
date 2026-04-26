'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';
import { Shield, Plug, Bot, Zap, Check, ArrowRight } from 'lucide-react';

const STEPS = [
  {
    id: 1,
    title: 'Welcome to ClawBridge',
    description: 'Your AI agent platform is ready. Complete these steps to go live in under 10 minutes.',
    icon: Shield,
    cta: 'Get started',
  },
  {
    id: 2,
    title: 'Connect a channel',
    description: 'Link WhatsApp, Telegram, Slack, or any channel where your customers reach you.',
    icon: Plug,
    cta: 'Connect channel',
  },
  {
    id: 3,
    title: 'Customize your agent',
    description: 'Set your agent\'s name, tone, and the topics it should handle automatically.',
    icon: Bot,
    cta: 'Customize agent',
  },
  {
    id: 4,
    title: 'Test and go live',
    description: 'Send a test message to verify everything works, then flip the switch to live.',
    icon: Zap,
    cta: 'Go live',
  },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const router = useRouter();

  const current = STEPS[step - 1];
  const Icon = current.icon;
  const isLast = step === STEPS.length;

  function handleNext() {
    if (isLast) {
      localStorage.setItem('cb_onboarded', '1');
      router.push('/dashboard');
    } else {
      setStep((s) => s + 1);
    }
  }

  return (
    <div className="min-h-screen bg-[#1f1f21] flex flex-col items-center justify-center px-4">
      {/* Progress */}
      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s) => (
          <div key={s.id} className="flex items-center gap-2">
            <div
              className={clsx(
                'w-8 h-8 rounded-full flex items-center justify-center text-[14px] font-bold transition-colors',
                s.id < step
                  ? 'bg-green-500 text-white'
                  : s.id === step
                  ? 'bg-[#f97316] text-white'
                  : 'bg-white/[0.06] text-[rgba(245,245,247,0.4)]'
              )}
            >
              {s.id < step ? <Check size={14} strokeWidth={3} /> : s.id}
            </div>
            {s.id < STEPS.length && (
              <div
                className={clsx(
                  'w-12 h-0.5 transition-colors',
                  s.id < step ? 'bg-green-500' : 'bg-white/[0.06]'
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-[#2a2a2d] border border-white/[0.06] rounded-2xl p-8 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-[#f97316]/10 mb-6">
          <Icon size={28} className="text-[#f97316]" strokeWidth={1.5} />
        </div>

        <h2 className="text-[28px] font-bold text-[#F5F5F7] mb-3">{current.title}</h2>
        <p className="text-[rgba(245,245,247,0.6)] text-[16px] leading-relaxed mb-8">
          {current.description}
        </p>

        {/* Step-specific content */}
        {step === 2 && (
          <div className="grid grid-cols-2 gap-3 mb-8 text-left">
            {['WhatsApp', 'Telegram', 'Slack', 'Discord'].map((ch) => (
              <button
                key={ch}
                className="flex items-center gap-2.5 px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl text-[16px] text-[#F5F5F7] hover:border-[#f97316]/40 transition-colors"
              >
                <div className="w-2 h-2 rounded-full bg-[rgba(245,245,247,0.2)]" />
                {ch}
              </button>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3 mb-8 text-left">
            <div>
              <label className="block text-[rgba(245,245,247,0.6)] text-[16px] mb-1.5">Agent name</label>
              <input
                type="text"
                defaultValue="Alex"
                className="w-full px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl text-[#F5F5F7] text-[16px] focus:outline-none focus:ring-2 focus:ring-[#f97316]/50"
              />
            </div>
            <div>
              <label className="block text-[rgba(245,245,247,0.6)] text-[16px] mb-1.5">Tone</label>
              <select className="w-full px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl text-[#F5F5F7] text-[16px] focus:outline-none focus:ring-2 focus:ring-[#f97316]/50">
                <option>Professional</option>
                <option>Friendly</option>
                <option>Concise</option>
              </select>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="mb-8 bg-[#161618] border border-white/[0.06] rounded-xl p-4 text-left">
            <p className="text-[rgba(245,245,247,0.6)] text-[16px] mb-2">Test message sent:</p>
            <div className="flex gap-3">
              <div className="flex-1 bg-[#2a2a2d] rounded-xl px-4 py-2.5 text-[#F5F5F7] text-[16px]">
                Hi, what are your hours?
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-green-400 text-[16px]">
              <Check size={14} strokeWidth={3} />
              Agent responded in 1.1s
            </div>
          </div>
        )}

        <button
          onClick={handleNext}
          className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-[#f97316] hover:bg-[#ea6c0a] text-white text-[16px] font-bold rounded-xl transition-colors shadow-lg shadow-[#f97316]/20"
        >
          {current.cta}
          <ArrowRight size={16} strokeWidth={2.5} />
        </button>

        {step > 1 && (
          <button
            onClick={() => setStep((s) => s - 1)}
            className="mt-3 w-full py-2 text-[rgba(245,245,247,0.4)] text-[16px] hover:text-[rgba(245,245,247,0.7)] transition-colors"
          >
            Back
          </button>
        )}
      </div>

      <p className="mt-6 text-[rgba(245,245,247,0.3)] text-[16px]">
        Step {step} of {STEPS.length}
      </p>
    </div>
  );
}
