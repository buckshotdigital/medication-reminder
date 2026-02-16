'use client';

import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';

interface UsageRecord {
  created_at: string;
  minutes_deducted: number;
  balance_after: number;
}

interface PurchaseRecord {
  created_at: string;
  minutes_purchased: number;
}

interface CreditChartsProps {
  usage: UsageRecord[];
  purchases: PurchaseRecord[];
}

function aggregateDailyUsage(usage: UsageRecord[]) {
  const byDay: Record<string, number> = {};
  for (const row of usage) {
    const day = new Date(row.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    });
    byDay[day] = (byDay[day] || 0) + Number(row.minutes_deducted);
  }
  return Object.entries(byDay).map(([day, minutes]) => ({
    day,
    minutes: Math.round(minutes * 10) / 10,
  }));
}

function buildBalanceTrend(usage: UsageRecord[], purchases: PurchaseRecord[]) {
  // Merge usage and purchases into a timeline
  const events: { date: Date; balance?: number; label: string }[] = [];

  for (const row of usage) {
    events.push({
      date: new Date(row.created_at),
      balance: Number(row.balance_after),
      label: new Date(row.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      }),
    });
  }

  // Sort by date
  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  // Deduplicate by day, keeping last balance
  const byDay: Record<string, number> = {};
  for (const e of events) {
    if (e.balance !== undefined) {
      byDay[e.label] = e.balance;
    }
  }

  return Object.entries(byDay).map(([day, balance]) => ({
    day,
    balance: Math.round(balance * 10) / 10,
  }));
}

export function DailyUsageChart({ usage }: { usage: UsageRecord[] }) {
  const data = aggregateDailyUsage(usage);

  if (data.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        No usage data yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '0.75rem',
            fontSize: 13,
          }}
          formatter={(value: number) => [`${value} min`, 'Used']}
        />
        <Bar dataKey="minutes" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BalanceTrendChart({ usage, purchases }: CreditChartsProps) {
  const data = buildBalanceTrend(usage, purchases);

  if (data.length === 0) {
    return (
      <div className="text-center text-muted-foreground text-sm py-8">
        No balance history yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="day" tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis tick={{ fontSize: 12 }} stroke="hsl(var(--muted-foreground))" />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--card))',
            border: '1px solid hsl(var(--border))',
            borderRadius: '0.75rem',
            fontSize: 13,
          }}
          formatter={(value: number) => [`${value} min`, 'Balance']}
        />
        <Line
          type="monotone"
          dataKey="balance"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          dot={{ r: 3 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
