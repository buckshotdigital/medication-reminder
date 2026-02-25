'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCallLogs, fetchScheduledCalls } from '@/lib/queries';
import { CallTranscript } from '@/components/call-transcript';
import { StatusBadge, getCallStatusVariant, getCallStatusLabel } from '@/components/status-badge';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/empty-state';
import { CallListSkeleton } from '@/components/skeletons';
import { Input, Select } from '@/components/form-field';
import { formatDate, formatTime, formatDuration, relativeTime, cn } from '@/lib/utils';
import { useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Phone, Search, PhoneOff, CalendarClock, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';

interface CallGroup {
  key: string;
  primary: any;
  retries: any[];
}

function groupCalls(calls: any[]): CallGroup[] {
  const groups = new Map<string, CallGroup>();

  for (const call of calls) {
    const date = new Date(call.created_at).toISOString().split('T')[0];
    const key = `${call.patient_id}-${call.medication_id}-${date}`;

    if (!groups.has(key)) {
      groups.set(key, { key, primary: call, retries: [] });
    } else {
      const group = groups.get(key)!;
      if ((call.attempt_number || 1) === 1 && (group.primary.attempt_number || 1) > 1) {
        // This call is the primary (attempt 1), swap
        group.retries.push(group.primary);
        group.primary = call;
      } else if ((call.attempt_number || 1) > 1) {
        group.retries.push(call);
      } else {
        // Multiple attempt_number=1 calls on same day — treat earlier as primary
        if (new Date(call.created_at) < new Date(group.primary.created_at)) {
          group.retries.push(group.primary);
          group.primary = call;
        } else {
          group.retries.push(call);
        }
      }
    }
  }

  // Sort retries by attempt number
  for (const group of groups.values()) {
    group.retries.sort((a, b) => (a.attempt_number || 1) - (b.attempt_number || 1));
  }

  return Array.from(groups.values());
}

function CallsContent() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get('status') || 'all';
  const initialFrom = searchParams.get('from') || '';
  const initialTo = searchParams.get('to') || '';

  const { data: calls, isLoading, error, refetch } = useQuery({
    queryKey: ['calls'],
    queryFn: () => fetchCallLogs(),
  });

  const { data: scheduledCalls, isLoading: scheduledLoading } = useQuery({
    queryKey: ['scheduled-calls'],
    queryFn: () => fetchScheduledCalls(),
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [dateFrom, setDateFrom] = useState(initialFrom);
  const [dateTo, setDateTo] = useState(initialTo);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!calls) return [];
    return calls.filter((call: any) => {
      if (search.trim()) {
        const q = search.toLowerCase();
        const name = call.patients?.name?.toLowerCase() || '';
        if (!name.includes(q)) return false;
      }

      if (statusFilter !== 'all') {
        if (statusFilter === 'taken' && call.medication_taken !== true) return false;
        if (statusFilter === 'not_taken' && call.medication_taken !== false) return false;
        if (statusFilter === 'unreached' && !['no_answer', 'failed', 'voicemail'].includes(call.status)) return false;
      }

      if (dateFrom) {
        const callDate = new Date(call.created_at).toISOString().split('T')[0];
        if (callDate < dateFrom) return false;
      }
      if (dateTo) {
        const callDate = new Date(call.created_at).toISOString().split('T')[0];
        if (callDate > dateTo) return false;
      }

      return true;
    });
  }, [calls, search, statusFilter, dateFrom, dateTo]);

  const grouped = useMemo(() => groupCalls(filtered), [filtered]);

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const statusBorderColor = (call: any) => {
    if (call.medication_taken === true) return 'border-l-emerald-400';
    if (call.medication_taken === false) return 'border-l-rose-400';
    if (call.status === 'no_answer') return 'border-l-slate-300';
    return 'border-l-amber-400';
  };

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Call History</h1>
        <div className="text-center py-12">
          <p className="text-destructive">Failed to load call history</p>
          <p className="text-muted-foreground text-sm mt-1">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 inline-flex items-center gap-2 text-sm text-primary hover:underline"
          >
            <RefreshCw className="w-4 h-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Call History</h1>

      {/* Filter toolbar */}
      {calls && calls.length > 0 && (
        <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search patient..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-11"
              />
            </div>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              <option value="taken">Taken</option>
              <option value="scheduled">Scheduled</option>
              <option value="not_taken">Not Taken</option>
              <option value="unreached">Unreached</option>
            </Select>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              placeholder="From"
            />
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              placeholder="To"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Showing {filtered.length} of {calls.length} calls
          </p>
        </div>
      )}

      {/* Scheduled calls view */}
      {statusFilter === 'scheduled' ? (
        scheduledLoading ? (
          <CallListSkeleton />
        ) : scheduledCalls && scheduledCalls.length > 0 ? (
          <div className="space-y-3">
            {scheduledCalls.map((sc: any) => (
              <div
                key={sc.id}
                className="rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4 border-l-blue-400"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Avatar name={sc.patients?.name || 'Unknown'} size="sm" />
                    <div>
                      <span className="font-medium">{sc.patients?.name || 'Unknown'}</span>
                      <p className="text-sm text-muted-foreground">
                        {sc.medications?.name}
                        {sc.medications?.dosage && ` (${sc.medications.dosage})`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">
                      <CalendarClock className="w-3 h-3" />
                      Scheduled
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2 ml-12">
                  <span>
                    {new Date(sc.scheduled_for).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    })}
                  </span>
                  {sc.attempt_number > 1 && (
                    <span>Attempt #{sc.attempt_number}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="No scheduled calls"
            description="Calls will appear here when medications are scheduled for today"
          />
        )
      ) : isLoading ? (
        <CallListSkeleton />
      ) : filtered.length > 0 ? (
        <div className="space-y-3">
          {grouped.map((group) => (
            <div key={group.key}>
              {/* Primary call */}
              <div
                className={cn(
                  'rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4',
                  statusBorderColor(group.primary)
                )}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <Avatar name={group.primary.patients?.name || 'Unknown'} size="sm" />
                    <div>
                      <span className="font-medium">{group.primary.patients?.name || 'Unknown'}</span>
                      <p className="text-sm text-muted-foreground">
                        {group.primary.medications?.name}
                        {group.primary.medications?.dosage && ` (${group.primary.medications.dosage})`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge variant={getCallStatusVariant(group.primary.medication_taken, group.primary.status)}>
                      {getCallStatusLabel(group.primary.medication_taken, group.primary.status)}
                    </StatusBadge>
                    {group.retries.length > 0 && (
                      <button
                        onClick={() => toggleGroup(group.key)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-lg hover:bg-muted transition-colors"
                      >
                        {expandedGroups.has(group.key) ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )}
                        {group.retries.length} {group.retries.length !== 1 ? 'retries' : 'retry'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4 text-sm text-muted-foreground mb-2 ml-12">
                  <span title={`${formatDate(group.primary.created_at)} at ${formatTime(group.primary.created_at)}`}>
                    {relativeTime(group.primary.created_at)}
                  </span>
                  {group.primary.duration_seconds != null && group.primary.duration_seconds > 0 && (
                    <span>Duration: {formatDuration(group.primary.duration_seconds)}</span>
                  )}
                  {group.primary.attempt_number > 1 && (
                    <span>Attempt #{group.primary.attempt_number}</span>
                  )}
                </div>

                <div className="ml-12">
                  <CallTranscript
                    transcript={group.primary.patient_response}
                    callSid={group.primary.call_sid}
                  />
                </div>
              </div>

              {/* Retry calls (expanded) */}
              {expandedGroups.has(group.key) && group.retries.map((retry: any) => (
                <div
                  key={retry.id}
                  className={cn(
                    'rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4 ml-8 mt-2',
                    statusBorderColor(retry)
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                          Retry #{retry.attempt_number || 2}
                        </span>
                      </div>
                    </div>
                    <StatusBadge variant={getCallStatusVariant(retry.medication_taken, retry.status)}>
                      {getCallStatusLabel(retry.medication_taken, retry.status)}
                    </StatusBadge>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mb-2">
                    <span title={`${formatDate(retry.created_at)} at ${formatTime(retry.created_at)}`}>
                      {relativeTime(retry.created_at)}
                    </span>
                    {retry.duration_seconds != null && retry.duration_seconds > 0 && (
                      <span>Duration: {formatDuration(retry.duration_seconds)}</span>
                    )}
                  </div>
                  <CallTranscript
                    transcript={retry.patient_response}
                    callSid={retry.call_sid}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : calls && calls.length > 0 ? (
        <EmptyState
          icon={Search}
          title="No matching calls"
          description="Try adjusting your filters"
        />
      ) : (
        <EmptyState
          icon={PhoneOff}
          title="No calls found"
          description="Calls will appear here once reminders are sent"
        />
      )}
    </div>
  );
}

export default function CallsPage() {
  return (
    <Suspense>
      <CallsContent />
    </Suspense>
  );
}
