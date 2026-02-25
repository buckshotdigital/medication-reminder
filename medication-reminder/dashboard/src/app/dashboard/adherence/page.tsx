'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchWeeklyAdherence } from '@/lib/queries';
import { AdherenceChart } from '@/components/adherence-chart';
import { EmptyState } from '@/components/empty-state';
import { ChartSkeleton } from '@/components/skeletons';
import { useState, useCallback } from 'react';
import { BarChart3, ArrowUpDown, RefreshCw } from 'lucide-react';
import Link from 'next/link';

type SortKey = 'patient_name' | 'adherence_percentage' | 'taken_count' | 'missed_count';
type SortDir = 'asc' | 'desc';

function SortHeader({ label, field, sortKey, sortDir, onSort, align = 'left' }: {
  label: string;
  field: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'center' | 'right';
}) {
  const active = sortKey === field;
  const alignClass = align === 'center' ? 'text-center' : align === 'right' ? 'text-right' : 'text-left';
  const flexAlign = align === 'center' ? 'justify-center' : align === 'right' ? 'justify-end' : '';
  return (
    <th
      className={`${alignClass} p-3 font-medium cursor-pointer hover:text-foreground select-none`}
      onClick={() => onSort(field)}
    >
      <span className={`inline-flex items-center gap-1 ${flexAlign}`}>
        {label}
        <ArrowUpDown className={`w-3 h-3 ${active ? 'text-primary' : 'text-muted-foreground/50'}`} />
        {active && (
          <span className="text-xs text-primary">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
        )}
      </span>
    </th>
  );
}

export default function AdherencePage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['weekly-adherence'],
    queryFn: fetchWeeklyAdherence,
  });

  const [sortKey, setSortKey] = useState<SortKey>('patient_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = useCallback((key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }, [sortKey]);

  const sortedData = data
    ? [...data].sort((a: any, b: any) => {
        const aVal = a[sortKey];
        const bVal = b[sortKey];
        const cmp = typeof aVal === 'string' ? aVal.localeCompare(bVal) : aVal - bVal;
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : [];

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Adherence Tracking</h1>
        <div className="text-center py-12">
          <p className="text-destructive">Failed to load adherence data</p>
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
      <h1 className="text-2xl font-bold">Adherence Tracking</h1>

      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
        <h2 className="font-semibold mb-4">Weekly Adherence Trend</h2>
        {isLoading ? (
          <ChartSkeleton />
        ) : (
          <AdherenceChart data={data || []} />
        )}
      </div>

      {/* Per-patient breakdown */}
      {sortedData.length > 0 ? (
        <div className="rounded-2xl shadow-soft bg-white dark:bg-card overflow-hidden">
          <div className="p-5">
            <h2 className="font-semibold">Per-Patient Weekly Breakdown</h2>
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-t bg-muted/30">
                  <SortHeader label="Patient" field="patient_name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  <th className="text-center p-3 font-medium">Week</th>
                  <SortHeader label="Taken" field="taken_count" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="center" />
                  <SortHeader label="Missed" field="missed_count" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="center" />
                  <SortHeader label="Adherence" field="adherence_percentage" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="center" />
                </tr>
              </thead>
              <tbody>
                {sortedData.map((row: any, i: number) => (
                  <tr key={`${row.patient_id || row.patient_name}-${row.week_start}-${i}`} className={`hover:bg-muted/20 ${i % 2 === 0 ? '' : 'bg-muted/10'}`}>
                    <td className="p-3 font-medium">
                      <Link
                        href={row.patient_id ? `/dashboard/patients/${row.patient_id}` : '/dashboard/patients'}
                        className="hover:text-primary transition-colors"
                      >
                        {row.patient_name}
                      </Link>
                    </td>
                    <td className="p-3 text-center text-muted-foreground">
                      {new Date(row.week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="p-3 text-center text-emerald-600 dark:text-emerald-400 font-medium tabular-nums">{row.taken_count}</td>
                    <td className="p-3 text-center text-rose-600 dark:text-rose-400 font-medium tabular-nums">{row.missed_count}</td>
                    <td className="p-3">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-16 bg-muted rounded-full h-2 overflow-hidden">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              row.adherence_percentage >= 80
                                ? 'bg-emerald-500'
                                : row.adherence_percentage >= 50
                                ? 'bg-amber-500'
                                : 'bg-rose-500'
                            }`}
                            style={{ width: `${row.adherence_percentage}%` }}
                          />
                        </div>
                        <span className={`font-medium tabular-nums ${
                          row.adherence_percentage >= 80
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : row.adherence_percentage >= 50
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-rose-600 dark:text-rose-400'
                        }`}>
                          {row.adherence_percentage}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden divide-y divide-border/50">
            {sortedData.map((row: any, i: number) => (
              <div key={`${row.patient_id || row.patient_name}-${row.week_start}-${i}`} className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium">{row.patient_name}</span>
                  <span className={`font-bold ${
                    row.adherence_percentage >= 80
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : row.adherence_percentage >= 50
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}>
                    {row.adherence_percentage}%
                  </span>
                </div>
                <div className="bg-muted rounded-full h-2 overflow-hidden mb-2">
                  <div
                    className={`h-2 rounded-full ${
                      row.adherence_percentage >= 80
                        ? 'bg-emerald-500'
                        : row.adherence_percentage >= 50
                        ? 'bg-amber-500'
                        : 'bg-rose-500'
                    }`}
                    style={{ width: `${row.adherence_percentage}%` }}
                  />
                </div>
                <p className="text-sm text-muted-foreground">
                  Week of {new Date(row.week_start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' '}&middot;{' '}
                  {row.taken_count} taken, {row.missed_count} missed
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : !isLoading ? (
        <EmptyState
          icon={BarChart3}
          title="No adherence data"
          description="Data will appear after medication reminder calls are made"
        />
      ) : null}
    </div>
  );
}
