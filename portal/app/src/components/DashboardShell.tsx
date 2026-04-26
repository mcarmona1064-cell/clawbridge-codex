'use client';

import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import {
  LayoutDashboard,
  PhoneCall,
  BarChart2,
  Bot,
  Plug,
  CreditCard,
  HelpCircle,
  LogOut,
} from 'lucide-react';
import { clearToken } from '@/lib/auth';

const navItems = [
  { href: '/dashboard',              label: 'Overview',        icon: LayoutDashboard },
  { href: '/dashboard/call-logs',    label: 'Call Logs',       icon: PhoneCall },
  { href: '/dashboard/analytics',    label: 'Analytics',       icon: BarChart2 },
  { href: '/dashboard/agent',        label: 'Agent Settings',  icon: Bot },
  { href: '/dashboard/integrations', label: 'Integrations',    icon: Plug },
  { href: '/dashboard/billing',      label: 'Billing',         icon: CreditCard },
  { href: '/dashboard/help',         label: 'Get Help',        icon: HelpCircle },
];

interface DashboardShellProps {
  children: React.ReactNode;
  title?: string;
}

export default function DashboardShell({ children, title }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();

  function handleLogout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="min-h-screen bg-[#1f1f21] flex">
      {/* Sidebar */}
      <aside className="w-60 bg-[#1f1f21] border-r border-white/[0.06] flex flex-col fixed inset-y-0 left-0 z-40">
        {/* Logo */}
        <div className="h-14 flex items-center gap-2.5 px-5 border-b border-white/[0.06]">
          <div className="w-7 h-7 rounded-lg bg-[#f97316] flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
              <path d="M8 8L16 4L24 8V16C24 21 16 28 16 28C16 28 8 21 8 16V8Z" fill="white"/>
            </svg>
          </div>
          <span className="font-bold text-[#F5F5F7] text-[16px]">ClawBridge</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active =
              pathname === href ||
              (href !== '/dashboard' && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                className={clsx(
                  'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[16px] font-semibold transition-colors',
                  active
                    ? 'bg-white/[0.08] text-[#F5F5F7]'
                    : 'text-[rgba(245,245,247,0.6)] hover:text-[#F5F5F7] hover:bg-white/[0.04]'
                )}
              >
                <Icon size={16} strokeWidth={2} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="p-2 border-t border-white/[0.06]">
          <button
            onClick={handleLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[16px] font-semibold text-[rgba(245,245,247,0.6)] hover:text-[#F5F5F7] hover:bg-white/[0.04] transition-colors"
          >
            <LogOut size={16} strokeWidth={2} />
            Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 ml-60 flex flex-col min-h-screen">
        <header className="h-14 bg-[#1f1f21] border-b border-white/[0.06] flex items-center px-6 sticky top-0 z-30">
          <h1 className="text-[20px] font-bold text-[#F5F5F7]">{title ?? 'Overview'}</h1>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
