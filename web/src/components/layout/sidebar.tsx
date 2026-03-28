'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Target, Cpu, BookOpen, Settings } from 'lucide-react';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/goals', label: 'Goals', icon: Target },
  { href: '/sessions', label: 'Sessions', icon: Cpu },
  { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="fixed left-0 top-0 h-screen w-[120px] flex flex-col py-6 px-3 gap-1"
      style={{
        background: 'var(--bg-secondary)',
        borderRight: '1px solid var(--border-primary)',
      }}
    >
      <div
        className="text-sm font-semibold mb-6 px-2"
        style={{ color: 'var(--accent-primary)' }}
      >
        PulSeed
      </div>
      {navItems.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className="flex flex-col items-center gap-1 py-2 px-2 rounded text-xs transition-colors"
            style={{
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: active ? 'var(--bg-hover)' : 'transparent',
            }}
          >
            <Icon size={18} />
            <span>{label}</span>
          </Link>
        );
      })}
    </aside>
  );
}
