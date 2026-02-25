'use client';

import { cn } from '@/lib/utils';
import { CheckCircle2, Clock, XCircle, PhoneOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface StatusCardProps {
  label: string;
  count: number;
  variant: 'taken' | 'pending' | 'missed' | 'unreached';
  href?: string;
}

const variantConfig = {
  taken: {
    icon: CheckCircle2,
    accent: 'border-l-emerald-400',
    tint: 'bg-emerald-50/50 dark:bg-emerald-950/20',
    text: 'text-emerald-700 dark:text-emerald-400',
    iconColor: 'text-emerald-400/[0.07] dark:text-emerald-400/[0.07]',
  },
  pending: {
    icon: Clock,
    accent: 'border-l-amber-400',
    tint: 'bg-amber-50/50 dark:bg-amber-950/20',
    text: 'text-amber-700 dark:text-amber-400',
    iconColor: 'text-amber-400/[0.07] dark:text-amber-400/[0.07]',
  },
  missed: {
    icon: XCircle,
    accent: 'border-l-rose-400',
    tint: 'bg-rose-50/50 dark:bg-rose-950/20',
    text: 'text-rose-700 dark:text-rose-400',
    iconColor: 'text-rose-400/[0.07] dark:text-rose-400/[0.07]',
  },
  unreached: {
    icon: PhoneOff,
    accent: 'border-l-slate-300',
    tint: 'bg-slate-50/50 dark:bg-slate-900/20',
    text: 'text-slate-600 dark:text-slate-400',
    iconColor: 'text-slate-400/[0.07] dark:text-slate-400/[0.07]',
  },
};

export function StatusCard({ label, count, variant, href }: StatusCardProps) {
  const config = variantConfig[variant];
  const Icon = config.icon;
  const [displayed, setDisplayed] = useState(0);

  useEffect(() => {
    // Handle count going to 0
    if (count === 0) {
      setDisplayed(0);
      return;
    }

    let frame: number;
    const start = performance.now();
    const duration = 400;

    function animate(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      setDisplayed(Math.round(progress * count));
      if (progress < 1) {
        frame = requestAnimationFrame(animate);
      }
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [count]);

  const content = (
    <>
      <Icon className={cn('absolute top-3 right-3 w-16 h-16', config.iconColor)} strokeWidth={1.5} />
      <div className="relative">
        <p className={cn('text-4xl font-bold animate-count-up', config.text)}>{displayed}</p>
        <p className="text-sm font-medium text-muted-foreground mt-1">{label}</p>
      </div>
    </>
  );

  const className = cn(
    'relative overflow-hidden rounded-2xl border-l-4 p-6 shadow-soft bg-white dark:bg-card',
    'hover:shadow-soft-lg transition-all duration-200',
    href && 'cursor-pointer',
    config.accent,
    config.tint
  );

  if (href) {
    return (
      <Link href={href} className={cn(className, 'block')}>
        {content}
      </Link>
    );
  }

  return (
    <div className={className}>
      {content}
    </div>
  );
}
