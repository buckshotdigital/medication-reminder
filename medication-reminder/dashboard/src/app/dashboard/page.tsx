'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchDashboardStats } from '@/lib/queries';
import { StatusCard } from '@/components/status-card';
import { StatusBadge, getCallStatusVariant, getCallStatusLabel } from '@/components/status-badge';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/empty-state';
import { DashboardSkeleton } from '@/components/skeletons';
import { relativeTime, getGreeting, cn } from '@/lib/utils';
import Link from 'next/link';
import { AlertTriangle, Users, CheckCircle2, ChevronRight, Pill, RefreshCw, Coins } from 'lucide-react';

interface DashboardStats {
  today: { taken: number; pending: number; missed: number; unreached: number };
  patients: Array<{ id: string; name: string; phone_number: string; timezone: string; medications?: Array<{ id: string }> }>;
  weekly_adherence: number;
  recent_calls: Array<any>;
  escalations: Array<any>;
  credits?: { balance_minutes: number };
}

export default function DashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: fetchDashboardStats,
  });

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (error) {
    return (
      <div className="text-center py-12 animate-fade-in">
        <p className="text-destructive">Failed to load dashboard data</p>
        <p className="text-muted-foreground text-sm mt-1">{(error as Error).message}</p>
        <button
          onClick={() => refetch()}
          className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    );
  }

  const stats = (data || {}) as DashboardStats;
  const today = stats.today || { taken: 0, pending: 0, missed: 0, unreached: 0 };
  const totalMissed = today.missed + today.unreached;
  const allGood = totalMissed === 0 && today.pending === 0;
  const hasCritical = totalMissed >= 3;
  const credits = stats.credits;
  const lowBalance = (credits?.balance_minutes ?? 0) <= 10;

  return (
    <div className="space-y-8">
      {/* Greeting header */}
      <div>
        <h1 className="text-2xl font-bold">{getGreeting()}</h1>
        <p className="text-muted-foreground mt-1">
          Here&apos;s how your patients are doing today &middot;{' '}
          {new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </p>
      </div>

      {/* Status banner */}
      {allGood && today.taken > 0 ? (
        <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-800/30 p-4 flex items-center gap-3 animate-fade-in">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <p className="text-emerald-800 dark:text-emerald-300 font-medium text-sm">
            All patients are on track today
          </p>
        </div>
      ) : hasCritical ? (
        <div className="rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-100 dark:border-rose-800/30 p-4 flex items-center gap-3 animate-fade-in">
          <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />
          <p className="text-rose-800 dark:text-rose-300 font-medium text-sm">
            {totalMissed} missed reminders need your attention
          </p>
        </div>
      ) : totalMissed > 0 ? (
        <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-800/30 p-4 flex items-center gap-3 animate-fade-in">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0" />
          <p className="text-amber-800 dark:text-amber-300 font-medium text-sm">
            {totalMissed} missed reminder{totalMissed !== 1 ? 's' : ''} need{totalMissed === 1 ? 's' : ''} your attention
          </p>
        </div>
      ) : null}

      {/* Low credit balance warning */}
      {lowBalance && (
        <Link
          href="/dashboard/credits"
          className="rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-100 dark:border-rose-800/30 p-4 flex items-center justify-between gap-3 animate-fade-in hover:shadow-soft transition-shadow"
        >
          <div className="flex items-center gap-3">
            <Coins className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0" />
            <p className="text-rose-800 dark:text-rose-300 font-medium text-sm">
              Low credit balance: {Math.floor(credits?.balance_minutes ?? 0)} minutes remaining. Purchase more credits to keep calls active.
            </p>
          </div>
          <ChevronRight className="w-5 h-5 text-rose-400 shrink-0" />
        </Link>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatusCard label="Taken" count={today.taken} variant="taken" />
        <StatusCard label="Pending" count={today.pending} variant="pending" />
        <StatusCard label="Missed" count={today.missed} variant="missed" />
        <StatusCard label="Unreached" count={today.unreached} variant="unreached" />
      </div>

      {/* Weekly adherence bar */}
      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">This Week&apos;s Adherence</h2>
          <Link href="/dashboard/adherence" className="text-sm text-primary hover:underline">
            View details
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-3xl font-bold text-primary">
            {stats.weekly_adherence || 0}%
          </div>
          <div className="flex-1">
            <div className="bg-muted rounded-full h-3 overflow-hidden">
              <div
                className="bg-emerald-500 rounded-full h-3 transition-all duration-500"
                style={{ width: `${stats.weekly_adherence || 0}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Credit balance card */}
      {credits && (
        <Link
          href="/dashboard/credits"
          className="rounded-2xl shadow-soft bg-white dark:bg-card p-6 hover:shadow-soft-lg transition-shadow group block"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Call Credits</h2>
            <span className="text-sm text-primary group-hover:underline">Manage</span>
          </div>
          <div className="flex items-center gap-4">
            <div className={cn(
              'text-3xl font-bold',
              (credits.balance_minutes ?? 0) > 30
                ? 'text-emerald-600 dark:text-emerald-400'
                : (credits.balance_minutes ?? 0) > 10
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-rose-600 dark:text-rose-400'
            )}>
              {Math.floor(credits.balance_minutes ?? 0)}
            </div>
            <span className="text-muted-foreground text-sm">minutes remaining</span>
          </div>
        </Link>
      )}

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Patients */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Patients</h2>
            <Link href="/dashboard/patients" className="text-sm text-primary hover:underline">
              Manage
            </Link>
          </div>
          {stats.patients?.length > 0 ? (
            <div className="space-y-3">
              {stats.patients.map((patient: any) => (
                <Link
                  key={patient.id}
                  href={`/dashboard/patients/${patient.id}`}
                  className="flex items-center justify-between rounded-2xl shadow-soft bg-white dark:bg-card p-4 hover:shadow-soft-lg transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <Avatar name={patient.name} size="sm" />
                    <div>
                      <p className="font-medium">{patient.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {patient.medications?.length || 0} medication{patient.medications?.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                </Link>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl shadow-soft bg-white dark:bg-card">
              <EmptyState
                icon={Users}
                title="No patients yet"
                description="Add your first patient to start tracking their medications"
                action={
                  <Link href="/dashboard/patients" className="text-primary hover:underline text-sm font-medium">
                    Add patient
                  </Link>
                }
              />
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Recent Activity</h2>
            <Link href="/dashboard/calls" className="text-sm text-primary hover:underline">
              View all
            </Link>
          </div>
          {stats.recent_calls?.length > 0 ? (
            <div className="space-y-3">
              {stats.recent_calls.slice(0, 5).map((call: any) => (
                <div key={call.id} className="rounded-2xl shadow-soft bg-white dark:bg-card p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={call.patients?.name || 'Unknown'} size="sm" />
                    <div>
                      <p className="font-medium text-sm">{call.patients?.name || 'Unknown'}</p>
                      <p className="text-xs text-muted-foreground">
                        {call.medications?.name} {call.medications?.dosage && `(${call.medications.dosage})`}
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex flex-col items-end gap-1">
                    <StatusBadge variant={getCallStatusVariant(call.medication_taken, call.status)}>
                      {getCallStatusLabel(call.medication_taken, call.status)}
                    </StatusBadge>
                    <p className="text-xs text-muted-foreground">
                      {relativeTime(call.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl shadow-soft bg-white dark:bg-card">
              <EmptyState
                icon={Pill}
                title="No recent activity"
                description="Activity will appear here once reminder calls are made"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
