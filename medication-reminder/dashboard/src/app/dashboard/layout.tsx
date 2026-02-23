'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  LayoutDashboard,
  Users,
  Phone,
  BarChart3,
  Coins,
  Settings,
  LogOut,
  Pill,
  ClipboardList,
} from 'lucide-react';
import { useState } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/patients', label: 'Patients', icon: Users },
  { href: '/dashboard/calls', label: 'Calls', icon: Phone },
  { href: '/dashboard/adherence', label: 'Adherence', icon: BarChart3 },
  { href: '/dashboard/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/dashboard/credits', label: 'Credits', icon: Coins },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    queryClient.clear();
    router.push('/login');
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Top navbar */}
      <nav className="sticky top-0 z-40 backdrop-blur-md bg-white/80 dark:bg-card/80 border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <Link href="/dashboard" className="flex items-center gap-2">
              <Pill className="w-5 h-5 text-primary" />
              <span className="font-semibold text-lg text-foreground">
                GentleRing
              </span>
            </Link>

            {/* Desktop nav */}
            <div className="hidden md:flex items-center gap-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive =
                  item.href === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname.startsWith(item.href);

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>

            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                onClick={handleSignOut}
                className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-lg transition-colors"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Mobile bottom nav - show all 5 items */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 backdrop-blur-lg bg-white/90 dark:bg-card/90 border-t border-border/50 pb-[env(safe-area-inset-bottom)]">
        <div className="flex justify-around py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              item.href === '/dashboard'
                ? pathname === '/dashboard'
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex flex-col items-center gap-0.5 px-2 py-1 text-xs transition-colors',
                  isActive ? 'text-primary font-medium' : 'text-muted-foreground'
                )}
              >
                <Icon className={cn('w-5 h-5', isActive && 'fill-primary/20')} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-20 md:pb-6 animate-fade-in">
        {children}
      </main>
    </div>
  );
}
