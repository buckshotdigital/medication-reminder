'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchCreditBalance, fetchCreditUsage, fetchCreditPurchases,
  purchaseCreditPack, fetchAutoTopupSettings,
  updateAutoTopupSettings, fetchCreditAnalytics, fetchInvoices,
  createSubscription, createPortalSession,
} from '@/lib/queries';
import { createClient } from '@/lib/supabase/client';
import { cn, formatDate, formatTime } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { ToggleSwitch } from '@/components/toggle-switch';
import { DailyUsageChart, BalanceTrendChart } from '@/components/credit-charts';
import { Button, Input } from '@/components/form-field';
import {
  Coins, Package, CreditCard, TrendingDown, ChevronDown, ChevronUp,
  FileText, Download, ExternalLink,
} from 'lucide-react';
import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';

const CREDIT_PACKS = [
  { label: '60 minutes', minutes: 60, priceCents: 1200, perMinute: '$0.20' },
  { label: '150 minutes', minutes: 150, priceCents: 2500, perMinute: '$0.17', popular: true },
  { label: '500 minutes', minutes: 500, priceCents: 7000, perMinute: '$0.14' },
];

export default function CreditsPage() {
  return (
    <Suspense fallback={<div className="h-64 rounded-2xl animate-pulse bg-muted/60" />}>
      <CreditsPageContent />
    </Suspense>
  );
}

function CreditsPageContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const [buyingPack, setBuyingPack] = useState<number | null>(null);

  // Auto-topup state
  const [showAutoTopup, setShowAutoTopup] = useState(false);
  const [autoTopupEnabled, setAutoTopupEnabled] = useState(false);
  const [autoTopupThreshold, setAutoTopupThreshold] = useState('10');
  const [autoTopupPack, setAutoTopupPack] = useState(150);
  const [savingAutoTopup, setSavingAutoTopup] = useState(false);

  // Subscription state
  const [subscribing, setSubscribing] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [profile, setProfile] = useState<any>(null);

  // Handle Stripe redirect query params
  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      toast('Payment successful! Credits are being added...', 'success');
      const refetch = () => {
        queryClient.invalidateQueries({ queryKey: ['credit-balance'] });
        queryClient.invalidateQueries({ queryKey: ['credit-purchases'] });
        queryClient.invalidateQueries({ queryKey: ['credit-analytics'] });
        queryClient.invalidateQueries({ queryKey: ['invoices'] });
      };
      refetch();
      setTimeout(refetch, 2000);
      setTimeout(refetch, 5000);
    } else if (searchParams.get('subscription') === 'success') {
      toast('Subscription activated successfully!', 'success');
    } else if (searchParams.get('canceled') === 'true' || searchParams.get('subscription') === 'canceled') {
      toast('Payment was canceled.', 'info');
    }
  }, [searchParams, toast, queryClient]);

  // Load caregiver profile for subscription status
  useEffect(() => {
    async function loadProfile() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data } = await supabase
        .from('caregivers')
        .select('id, subscription_status, subscription_current_period_end')
        .eq('auth_user_id', user.id)
        .single();
      if (data) setProfile(data);
    }
    loadProfile();
  }, []);

  const { data: balance, isLoading: loadingBalance } = useQuery({
    queryKey: ['credit-balance'],
    queryFn: fetchCreditBalance,
  });

  const { data: usage, isLoading: loadingUsage } = useQuery({
    queryKey: ['credit-usage'],
    queryFn: () => fetchCreditUsage(),
  });

  const { data: purchases, isLoading: loadingPurchases } = useQuery({
    queryKey: ['credit-purchases'],
    queryFn: fetchCreditPurchases,
  });

  const { data: analytics } = useQuery({
    queryKey: ['credit-analytics'],
    queryFn: fetchCreditAnalytics,
  });

  const { data: autoTopupData } = useQuery({
    queryKey: ['auto-topup-settings'],
    queryFn: fetchAutoTopupSettings,
  });

  const { data: invoices, isLoading: loadingInvoices } = useQuery({
    queryKey: ['invoices'],
    queryFn: fetchInvoices,
  });

  // Sync auto-topup settings from DB
  useEffect(() => {
    if (autoTopupData) {
      setAutoTopupEnabled(autoTopupData.enabled);
      setAutoTopupThreshold(String(autoTopupData.threshold_minutes));
      setAutoTopupPack(autoTopupData.pack_minutes);
    }
  }, [autoTopupData]);

  const balanceMinutes = Number(balance?.balance_minutes ?? 0);

  // Burn rate calculation
  const analyticsUsage = analytics?.usage || [];
  const totalUsedLast30 = analyticsUsage.reduce(
    (sum: number, r: any) => sum + Number(r.minutes_deducted), 0
  );
  const daysWithUsage = new Set(
    analyticsUsage.map((r: any) => new Date(r.created_at).toDateString())
  ).size;
  const avgDailyUsage = daysWithUsage > 0
    ? Math.round((totalUsedLast30 / daysWithUsage) * 10) / 10
    : 0;
  const daysRemaining = avgDailyUsage > 0
    ? Math.floor(balanceMinutes / avgDailyUsage)
    : null;

  async function handleBuyPack(packMinutes: number) {
    setBuyingPack(packMinutes);
    try {
      const url = await purchaseCreditPack(packMinutes);
      window.location.href = url;
    } catch (e) {
      toast('Failed to start checkout: ' + (e as Error).message, 'error');
      setBuyingPack(null);
    }
  }

  async function handleSaveAutoTopup() {
    setSavingAutoTopup(true);
    const pack = CREDIT_PACKS.find(p => p.minutes === autoTopupPack) || CREDIT_PACKS[1];
    try {
      await updateAutoTopupSettings({
        enabled: autoTopupEnabled,
        threshold_minutes: Number(autoTopupThreshold) || 10,
        pack_minutes: pack.minutes,
        pack_price_cents: pack.priceCents,
        pack_label: pack.label,
      });
      toast('Auto top-up settings saved', 'success');
      queryClient.invalidateQueries({ queryKey: ['auto-topup-settings'] });
    } catch (e) {
      toast('Failed to save: ' + (e as Error).message, 'error');
    } finally {
      setSavingAutoTopup(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Subscription</h1>
        <p className="text-muted-foreground mt-1">
          Manage your plan, credits, and billing
        </p>
      </div>

      {/* Balance display */}
      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-8 text-center">
        <Coins className={cn(
          'w-12 h-12 mx-auto mb-4',
          balanceMinutes > 30
            ? 'text-emerald-500'
            : balanceMinutes > 10
              ? 'text-amber-500'
              : 'text-rose-500'
        )} />
        {loadingBalance ? (
          <div className="h-12 w-32 mx-auto rounded-xl animate-pulse bg-muted/60" />
        ) : (
          <>
            <p className={cn(
              'text-5xl font-bold',
              balanceMinutes > 30
                ? 'text-emerald-600 dark:text-emerald-400'
                : balanceMinutes > 10
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-rose-600 dark:text-rose-400'
            )}>
              {Math.floor(balanceMinutes)}
            </p>
            <p className="text-muted-foreground mt-1">minutes remaining</p>
          </>
        )}
      </div>

      {/* Monthly Plan */}
      {profile && (
        <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
          <h2 className="font-semibold mb-4">Monthly Plan</h2>
          <div className="max-w-lg">
            {profile.subscription_status === 'active' || profile.subscription_status === 'trialing' ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5 text-primary" />
                  <div>
                    <p className="text-sm font-medium">MedReminder Base Plan — $49/mo</p>
                    <p className="text-xs text-muted-foreground">
                      Status: <span className="text-emerald-600 dark:text-emerald-400 font-medium">{profile.subscription_status}</span>
                      {profile.subscription_current_period_end && (
                        <> &middot; Next billing: {new Date(profile.subscription_current_period_end).toLocaleDateString()}</>
                      )}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={openingPortal}
                  onClick={async () => {
                    setOpeningPortal(true);
                    try {
                      const url = await createPortalSession();
                      window.location.href = url;
                    } catch (e) {
                      toast('Failed to open billing portal: ' + (e as Error).message, 'error');
                      setOpeningPortal(false);
                    }
                  }}
                >
                  <ExternalLink className="w-4 h-4" />
                  Manage
                </Button>
              </div>
            ) : profile.subscription_status === 'past_due' ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5 text-amber-500" />
                  <div>
                    <p className="text-sm font-medium">MedReminder Base Plan — $49/mo</p>
                    <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                      Payment failed — please update your payment method
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  loading={openingPortal}
                  onClick={async () => {
                    setOpeningPortal(true);
                    try {
                      const url = await createPortalSession();
                      window.location.href = url;
                    } catch (e) {
                      toast('Failed to open billing portal: ' + (e as Error).message, 'error');
                      setOpeningPortal(false);
                    }
                  }}
                >
                  <ExternalLink className="w-4 h-4" />
                  Update Payment
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <CreditCard className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">MedReminder Base Plan — $49/mo</p>
                    <p className="text-xs text-muted-foreground">
                      Includes medication reminder calls for all your patients
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  loading={subscribing}
                  onClick={async () => {
                    setSubscribing(true);
                    try {
                      const url = await createSubscription();
                      window.location.href = url;
                    } catch (e) {
                      toast('Failed to start subscription: ' + (e as Error).message, 'error');
                      setSubscribing(false);
                    }
                  }}
                >
                  <CreditCard className="w-4 h-4" />
                  Subscribe
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Burn Rate Stats */}
      {analyticsUsage.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Avg Daily Usage</p>
            </div>
            <p className="text-2xl font-bold">{avgDailyUsage} min</p>
          </div>
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-5">
            <div className="flex items-center gap-2 mb-2">
              <Coins className="w-4 h-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Last 30 Days Total</p>
            </div>
            <p className="text-2xl font-bold">{Math.round(totalUsedLast30)} min</p>
          </div>
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Est. Days Remaining</p>
            </div>
            <p className={cn(
              'text-2xl font-bold',
              daysRemaining !== null && daysRemaining <= 7
                ? 'text-rose-600 dark:text-rose-400'
                : ''
            )}>
              {daysRemaining !== null ? daysRemaining : '--'}
            </p>
          </div>
        </div>
      )}

      {/* Usage Charts */}
      {analytics && (analytics.usage.length > 0 || analytics.purchases.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
            <h3 className="font-semibold mb-4">Daily Usage (Last 30 Days)</h3>
            <DailyUsageChart usage={analytics.usage} />
          </div>
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
            <h3 className="font-semibold mb-4">Balance Trend</h3>
            <BalanceTrendChart usage={analytics.usage} purchases={analytics.purchases} />
          </div>
        </div>
      )}

      {/* Credit packs */}
      <div>
        <h2 className="font-semibold mb-4">Purchase Credits</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {CREDIT_PACKS.map((pack) => (
            <div
              key={pack.minutes}
              className={cn(
                'rounded-2xl p-6 border-2 relative',
                pack.popular
                  ? 'border-primary bg-primary/5 shadow-soft-lg'
                  : 'border-border bg-white dark:bg-card shadow-soft'
              )}
            >
              {pack.popular && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-medium text-white bg-primary px-3 py-1 rounded-full">
                  Most Popular
                </span>
              )}
              <div className="flex items-center gap-3 mb-3">
                <Package className={cn(
                  'w-8 h-8',
                  pack.popular ? 'text-primary' : 'text-muted-foreground'
                )} />
                <div>
                  <p className="font-semibold text-lg">{pack.label}</p>
                  <p className="text-sm text-muted-foreground">{pack.perMinute}/min</p>
                </div>
              </div>
              <p className="text-2xl font-bold mb-4">${(pack.priceCents / 100).toFixed(0)}</p>
              <button
                onClick={() => handleBuyPack(pack.minutes)}
                disabled={buyingPack !== null}
                className={cn(
                  'flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-sm font-medium transition-colors',
                  pack.popular
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted hover:bg-muted/80 text-foreground',
                  buyingPack !== null && 'opacity-50 cursor-not-allowed'
                )}
              >
                <CreditCard className="w-4 h-4" />
                {buyingPack === pack.minutes ? 'Redirecting...' : 'Buy Now'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Auto Top-Up Settings */}
      <div>
        <button
          onClick={() => setShowAutoTopup(!showAutoTopup)}
          className="flex items-center gap-2 text-sm font-semibold hover:text-foreground transition-colors"
        >
          {showAutoTopup ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          Auto Top-Up Settings
        </button>
        {showAutoTopup && (
          <div className="mt-3 rounded-2xl shadow-soft bg-white dark:bg-card p-5 max-w-md animate-slide-up">
            <div className="space-y-4">
              <ToggleSwitch
                checked={autoTopupEnabled}
                onChange={setAutoTopupEnabled}
                label="Enable Auto Top-Up"
                description="Automatically purchase credits when balance drops below threshold"
              />
              <div>
                <label className="block text-sm font-medium mb-1">Threshold (minutes)</label>
                <Input
                  type="number"
                  min="1"
                  max="100"
                  value={autoTopupThreshold}
                  onChange={e => setAutoTopupThreshold(e.target.value)}
                  disabled={!autoTopupEnabled}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-purchase when balance drops below this
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Pack to Purchase</label>
                <div className="space-y-2">
                  {CREDIT_PACKS.map(pack => (
                    <label
                      key={pack.minutes}
                      className={cn(
                        'flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors',
                        autoTopupPack === pack.minutes
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-primary/50',
                        !autoTopupEnabled && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <input
                        type="radio"
                        name="autoTopupPack"
                        value={pack.minutes}
                        checked={autoTopupPack === pack.minutes}
                        onChange={() => setAutoTopupPack(pack.minutes)}
                        disabled={!autoTopupEnabled}
                        className="accent-primary"
                      />
                      <span className="text-sm">{pack.label} — ${(pack.priceCents / 100).toFixed(0)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <Button loading={savingAutoTopup} onClick={handleSaveAutoTopup} size="sm">
                Save Auto Top-Up
              </Button>
              <p className="text-xs text-muted-foreground">
                Requires a saved payment method from a previous purchase.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Usage history */}
      <div>
        <h2 className="font-semibold mb-4">Usage History</h2>
        {loadingUsage ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 rounded-2xl animate-pulse bg-muted/60" />
            ))}
          </div>
        ) : usage && usage.length > 0 ? (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Patient</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Duration</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Billable</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Credits Used</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Balance After</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((row: any) => (
                    <tr key={row.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 px-4 text-muted-foreground">
                        {formatDate(row.created_at)} {formatTime(row.created_at)}
                      </td>
                      <td className="py-3 px-4">{row.patients?.name || 'Unknown'}</td>
                      <td className="py-3 px-4 text-right">{formatCallDuration(row.total_duration_seconds)}</td>
                      <td className="py-3 px-4 text-right">{formatCallDuration(row.billable_seconds)}</td>
                      <td className="py-3 px-4 text-right font-medium">
                        {Number(row.minutes_deducted) > 0 ? `-${Number(row.minutes_deducted)}` : '0'}
                      </td>
                      <td className="py-3 px-4 text-right">{Math.floor(Number(row.balance_after))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-8 text-center">
            <Coins className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground text-sm">No usage recorded yet</p>
          </div>
        )}
      </div>

      {/* Purchase history */}
      <div>
        <h2 className="font-semibold mb-4">Purchase History</h2>
        {loadingPurchases ? (
          <div className="space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-16 rounded-2xl animate-pulse bg-muted/60" />
            ))}
          </div>
        ) : purchases && purchases.length > 0 ? (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Pack</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Source</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Minutes</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((row: any) => (
                    <tr key={row.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 px-4 text-muted-foreground">{formatDate(row.created_at)}</td>
                      <td className="py-3 px-4">{row.pack_label}</td>
                      <td className="py-3 px-4">
                        <span className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                          row.source === 'stripe'
                            ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'
                        )}>
                          {row.source === 'stripe' ? 'Stripe' : 'Manual'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-medium text-emerald-600 dark:text-emerald-400">
                        +{Number(row.minutes_purchased)}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {row.price_cents > 0 ? `$${(row.price_cents / 100).toFixed(2)}` : '$0.00'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-8 text-center">
            <Package className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground text-sm">No purchases yet</p>
          </div>
        )}
      </div>

      {/* Invoices & Receipts */}
      <div>
        <h2 className="font-semibold mb-4">Invoices & Receipts</h2>
        {loadingInvoices ? (
          <div className="space-y-3">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-16 rounded-2xl animate-pulse bg-muted/60" />
            ))}
          </div>
        ) : invoices && invoices.length > 0 ? (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Date</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Description</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Amount</th>
                    <th className="text-left py-3 px-4 font-medium text-muted-foreground">Status</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv: any) => (
                    <tr key={inv.id} className="border-b border-border/50 last:border-0">
                      <td className="py-3 px-4 text-muted-foreground">{formatDate(inv.date)}</td>
                      <td className="py-3 px-4">{inv.description}</td>
                      <td className="py-3 px-4 text-right">${(inv.amount_cents / 100).toFixed(2)}</td>
                      <td className="py-3 px-4">
                        <span className={cn(
                          'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium',
                          inv.status === 'paid'
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                            : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
                        )}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        {inv.pdf_url ? (
                          <a
                            href={inv.pdf_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
                          >
                            <Download className="w-3 h-3" />
                            PDF
                          </a>
                        ) : (
                          <span className="text-muted-foreground text-xs">--</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-8 text-center">
            <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-muted-foreground text-sm">No invoices yet. They will appear after your first payment.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatCallDuration(seconds: number): string {
  if (!seconds || seconds === 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
