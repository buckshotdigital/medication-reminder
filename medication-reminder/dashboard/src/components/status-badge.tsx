'use client';

import { cn } from '@/lib/utils';

type BadgeVariant = 'taken' | 'missed' | 'pending' | 'unreached' | 'active' | 'inactive';

const variantStyles: Record<BadgeVariant, { bg: string; dot: string }> = {
  taken: {
    bg: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  missed: {
    bg: 'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
    dot: 'bg-rose-500',
  },
  pending: {
    bg: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  unreached: {
    bg: 'bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-400',
    dot: 'bg-slate-400',
  },
  active: {
    bg: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  inactive: {
    bg: 'bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground/50',
  },
};

interface StatusBadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

export function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  const style = variantStyles[variant];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium',
        style.bg,
        className
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', style.dot)} />
      {children}
    </span>
  );
}

export function getCallStatusVariant(
  medicationTaken: boolean | null,
  status?: string
): BadgeVariant {
  if (medicationTaken === true) return 'taken';
  if (medicationTaken === false) return 'missed';
  if (status && ['no_answer', 'failed', 'voicemail'].includes(status)) return 'unreached';
  return 'pending';
}

export function getCallStatusLabel(
  medicationTaken: boolean | null,
  status?: string
): string {
  if (medicationTaken === true) return 'Taken';
  if (medicationTaken === false) return 'Not Taken';
  if (status === 'no_answer') return 'No Answer';
  if (status === 'failed') return 'Failed';
  if (status === 'voicemail') return 'Voicemail';
  return 'In Progress';
}
