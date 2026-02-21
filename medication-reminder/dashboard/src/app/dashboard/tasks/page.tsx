'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchCareTasks } from '@/lib/queries';
import { cn, relativeTime } from '@/lib/utils';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, ClipboardList, Coins, Pill, Phone } from 'lucide-react';

const filters = [
  { key: 'all', label: 'All' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
] as const;

type FilterKey = typeof filters[number]['key'];

export default function TasksPage() {
  const [filter, setFilter] = useState<FilterKey>('all');
  const { data, isLoading, error } = useQuery({
    queryKey: ['care-tasks'],
    queryFn: fetchCareTasks,
  });

  const tasks = data || [];
  const filtered = useMemo(
    () => filter === 'all' ? tasks : tasks.filter(t => t.priority === filter),
    [tasks, filter]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Care Tasks</h1>
          <p className="text-muted-foreground mt-1">Priority queue for follow-ups and risks</p>
        </div>
        <Link href="/dashboard" className="text-sm text-primary hover:underline">
          Back to overview
        </Link>
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
              filter === f.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-20 rounded-2xl animate-pulse bg-muted/60" />
          ))}
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 dark:bg-rose-950/20 dark:border-rose-900 p-4 text-sm text-rose-700 dark:text-rose-300">
          Failed to load tasks: {(error as Error).message}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-10 text-center">
          <ClipboardList className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <p className="font-medium">No tasks in this filter</p>
          <p className="text-sm text-muted-foreground mt-1">You are caught up right now.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(task => (
            <div
              key={task.id}
              className={cn(
                'rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4',
                task.priority === 'high'
                  ? 'border-l-rose-500'
                  : task.priority === 'medium'
                    ? 'border-l-amber-500'
                    : 'border-l-slate-400'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 text-muted-foreground">
                    {task.type === 'escalation' && <AlertTriangle className="w-4 h-4" />}
                    {task.type === 'missed' && <Phone className="w-4 h-4" />}
                    {task.type === 'overdue_call' && <CalendarClock className="w-4 h-4" />}
                    {task.type === 'refill' && <Pill className="w-4 h-4" />}
                    {task.type === 'low_credit' && <Coins className="w-4 h-4" />}
                  </div>
                  <div>
                    <p className="font-medium">{task.title}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{task.subtitle}</p>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <span
                    className={cn(
                      'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                      task.priority === 'high'
                        ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
                        : task.priority === 'medium'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                          : 'bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300'
                    )}
                  >
                    {task.priority}
                  </span>
                  <p className="text-xs text-muted-foreground mt-1">{relativeTime(task.created_at)}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
