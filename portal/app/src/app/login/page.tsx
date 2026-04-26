'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010';
      const res = await fetch(`${apiUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Invalid credentials'); return; }
      localStorage.setItem('cb_token', data.token);
      router.push('/dashboard');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#1f1f21] flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#f97316] mb-4 shadow-lg shadow-[#f97316]/20">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <path d="M8 8L16 4L24 8V16C24 21 16 28 16 28C16 28 8 21 8 16V8Z" fill="white"/>
          </svg>
        </div>
        <h1 className="text-[28px] font-bold text-[#F5F5F7]">ClawBridge</h1>
        <p className="text-[rgba(245,245,247,0.6)] text-[16px] mt-1">Agent Platform</p>
      </div>

      {/* Card */}
      <div className="w-full max-w-sm bg-[#2a2a2d] rounded-2xl p-8 border border-white/[0.06]">
        <h2 className="text-[20px] font-bold text-[#F5F5F7] mb-6">Sign in</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[16px] text-[rgba(245,245,247,0.6)] mb-1.5" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl text-[#F5F5F7] text-[16px] placeholder-[rgba(245,245,247,0.3)] focus:outline-none focus:ring-2 focus:ring-[#f97316]/50 transition"
              placeholder="admin@clawbridgeagency.com"
            />
          </div>

          <div>
            <label className="block text-[16px] text-[rgba(245,245,247,0.6)] mb-1.5" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-[#161618] border border-white/[0.06] rounded-xl text-[#F5F5F7] text-[16px] placeholder-[rgba(245,245,247,0.3)] focus:outline-none focus:ring-2 focus:ring-[#f97316]/50 transition"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-[16px]">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 px-4 bg-[#f97316] hover:bg-[#ea6c0a] disabled:opacity-50 disabled:cursor-not-allowed text-white text-[16px] font-bold rounded-xl transition-colors shadow-lg shadow-[#f97316]/20"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>

      <p className="mt-8 text-[rgba(245,245,247,0.4)] text-[16px]">
        Powered by <span className="text-[#f97316]">ClawBridge Agent</span>
      </p>
    </div>
  );
}
