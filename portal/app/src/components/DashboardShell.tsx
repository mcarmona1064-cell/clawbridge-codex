'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Users,
  AlertTriangle,
  GitBranch,
  BarChart2,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Bell,
} from 'lucide-react';
import { clearToken } from '@/lib/auth';

const navItems = [
  { href: '/dashboard',              label: 'Overview',   icon: LayoutDashboard },
  { href: '/dashboard/clients',      label: 'Clients',    icon: Users },
  { href: '/dashboard/alerts',       label: 'Alerts',     icon: AlertTriangle },
  { href: '/dashboard/traces',       label: 'Traces',     icon: GitBranch },
  { href: '/dashboard/analytics',    label: 'Analytics',  icon: BarChart2 },
  { href: '/dashboard/settings',     label: 'Settings',   icon: Settings },
];

type HealthStatus = 'green' | 'amber' | 'red';

interface StatusDot {
  label: string;
  status: HealthStatus;
}

const STATUS_DOTS: StatusDot[] = [
  { label: 'API',      status: 'green' },
  { label: 'Agents',   status: 'green' },
  { label: 'Webhooks', status: 'amber' },
  { label: 'DB',       status: 'green' },
];

const DOT_COLOR: Record<HealthStatus, string> = {
  green: 'bg-[#2ECC71]',
  amber: 'bg-[#F5A623]',
  red:   'bg-[#E84040]',
};

interface DashboardShellProps {
  children: React.ReactNode;
  title?: string;
  alertCount?: number;
}

export default function DashboardShell({ children, alertCount = 2 }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);

  function handleLogout() {
    clearToken();
    router.push('/login');
  }

  return (
    <div className="min-h-screen bg-[#080B10] flex">
      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-[#0F1318] border-r border-[#252C38] flex flex-col fixed inset-y-0 left-0 z-40 transition-all duration-200',
          collapsed ? 'w-[56px]' : 'w-[220px]'
        )}
      >
        {/* Logo */}
        <div className={clsx(
          'h-12 flex items-center border-b border-[#252C38] flex-shrink-0',
          collapsed ? 'justify-center px-0' : 'gap-2.5 px-4'
        )}>
          <div className="w-7 h-7 rounded-lg bg-[#00D4FF]/10 border border-[#00D4FF]/30 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none">
              <path d="M8 8L16 4L24 8V16C24 21 16 28 16 28C16 28 8 21 8 16V8Z" fill="#00D4FF"/>
            </svg>
          </div>
          {!collapsed && (
            <span className="font-bold text-white text-[15px] whitespace-nowrap">ClawBridge</span>
          )}
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
                title={collapsed ? label : undefined}
                className={clsx(
                  'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[14px] font-semibold transition-colors relative',
                  active
                    ? 'bg-[#00D4FF]/10 text-white border-l-2 border-[#00D4FF]'
                    : 'text-[#8892A0] hover:text-[#C8D0DC] hover:bg-[#1A1F28] border-l-2 border-transparent',
                  collapsed && 'justify-center'
                )}
              >
                <Icon size={15} strokeWidth={2} className="flex-shrink-0" />
                {!collapsed && label}
              </Link>
            );
          })}
        </nav>

        {/* Collapse toggle + Logout */}
        <div className="p-2 border-t border-[#252C38] space-y-0.5">
          <button
            onClick={() => setCollapsed(!collapsed)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={clsx(
              'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[14px] font-semibold text-[#8892A0] hover:text-[#C8D0DC] hover:bg-[#1A1F28] transition-colors',
              collapsed && 'justify-center'
            )}
          >
            {collapsed ? <ChevronRight size={15} strokeWidth={2} /> : (
              <>
                <ChevronLeft size={15} strokeWidth={2} />
                Collapse
              </>
            )}
          </button>
          <button
            onClick={handleLogout}
            title={collapsed ? 'Sign out' : undefined}
            className={clsx(
              'flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-[14px] font-semibold text-[#8892A0] hover:text-[#C8D0DC] hover:bg-[#1A1F28] transition-colors',
              collapsed && 'justify-center'
            )}
          >
            <LogOut size={15} strokeWidth={2} />
            {!collapsed && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className={clsx('flex-1 flex flex-col min-h-screen transition-all duration-200', collapsed ? 'ml-[56px]' : 'ml-[220px]')}>
        {/* Top bar */}
        <header className="h-12 bg-[#0F1318] border-b border-[#252C38] flex items-center px-5 sticky top-0 z-30 gap-4">
          {/* Left: title */}
          <span className="text-[14px] font-bold text-white whitespace-nowrap">ClawBridge Mission Control</span>

          {/* Center: status dots */}
          <div className="flex-1 flex items-center justify-center gap-5">
            {STATUS_DOTS.map(({ label, status }) => (
              <div key={label} className="flex items-center gap-1.5">
                <span className={clsx('w-1.5 h-1.5 rounded-full', DOT_COLOR[status])} />
                <span className="text-[12px] text-[#8892A0]">{label}</span>
              </div>
            ))}
          </div>

          {/* Right: alert badge */}
          <button className="relative p-1.5 rounded-lg hover:bg-[#1A1F28] transition-colors">
            <Bell size={15} strokeWidth={2} className="text-[#8892A0]" />
            {alertCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-[#E84040] rounded-full text-[10px] font-bold text-white flex items-center justify-center leading-none">
                {alertCount}
              </span>
            )}
          </button>
        </header>

        <main className="flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
