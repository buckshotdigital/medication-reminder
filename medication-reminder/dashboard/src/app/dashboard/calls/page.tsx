'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchCallLogs } from '@/lib/queries';
import { CallTranscript } from '@/components/call-transcript';
import { StatusBadge, getCallStatusVariant, getCallStatusLabel } from '@/components/status-badge';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/empty-state';
import { CallListSkeleton } from '@/components/skeletons';
import { Input, Select } from '@/components/form-field';
import { formatDate, formatTime, formatDuration, relativeTime, cn } from '@/lib/utils';
import { useState, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Phone, Search, PhoneOff, RefreshCw } from 'lucide-react';

function CallsContent() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get('status') || 'all';

  const { data: calls, isLoading, error, refetch } = useQuery({
    queryKey: ['calls'],
    queryFn: () => fetchCallLogs(),
  });

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

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
        if (statusFilter === 'missed' && call.medication_taken !== false) return false;
        if (statusFilter === 'pending' && !(call.medication_taken === null && !['no_answer', 'failed', 'voicemail'].includes(call.status))) return false;
        if (statusFilter === 'unreached' && !['no_answer', 'failed', 'voicemail'].includes(call.status)) return false;
        if (statusFilter === 'no_answer' && call.status !== 'no_answer') return false;
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
              <option value="pending">Pending</option>
              <option value="missed">Missed</option>
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

      {isLoading ? (
        <CallListSkeleton />
      ) : filtered.length > 0 ? (
        <div className="space-y-3">
          {filtered.map((call: any) => (
            <div
              key={call.id}
              className={cn(
                'rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4',
                statusBorderColor(call)
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <Avatar name={call.patients?.name || 'Unknown'} size="sm" />
                  <div>
                    <span className="font-medium">{call.patients?.name || 'Unknown'}</span>
                    <p className="text-sm text-muted-foreground">
                      {call.medications?.name}
                      {call.medications?.dosage && ` (${call.medications.dosage})`}
                    </p>
                  </div>
                </div>
                <StatusBadge variant={getCallStatusVariant(call.medication_taken, call.status)}>
                  {getCallStatusLabel(call.medication_taken, call.status)}
                </StatusBadge>
              </div>

              <div className="flex items-center gap-4 text-sm text-muted-foreground mb-2 ml-12">
                <span title={`${formatDate(call.created_at)} at ${formatTime(call.created_at)}`}>
                  {relativeTime(call.created_at)}
                </span>
                {call.duration_seconds != null && call.duration_seconds > 0 && (
                  <span>Duration: {formatDuration(call.duration_seconds)}</span>
                )}
                {call.attempt_number > 1 && (
                  <span>Attempt #{call.attempt_number}</span>
                )}
              </div>

              <div className="ml-12">
                <CallTranscript
                  transcript={call.patient_response}
                  callSid={call.call_sid}
                />
              </div>
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
