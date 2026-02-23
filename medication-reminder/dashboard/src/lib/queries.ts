import { createClient } from './supabase/client';

function getSupabase() {
  return createClient();
}

/**
 * Ensure a caregiver record exists for the current auth user.
 * Called after signup/login to cover paths that skip /auth/callback.
 * The DB trigger `grant_trial_credits` fires on INSERT to grant 15 free minutes.
 */
export async function ensureCaregiverExists() {
  const supabase = getSupabase();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (!user) {
    console.error('[ensureCaregiverExists] No user found', userError);
    return;
  }

  const { data: existing, error: selectError } = await supabase
    .from('caregivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!existing) {
    console.log('[ensureCaregiverExists] No caregiver found, creating for', user.email);
    const { data: inserted, error: insertError } = await supabase.from('caregivers').insert({
      name: user.email?.split('@')[0] || 'Caregiver',
      email: user.email,
      phone_number: '',
      auth_user_id: user.id,
    }).select('id').single();

    if (insertError) {
      console.error('[ensureCaregiverExists] Insert failed:', insertError);
    } else {
      console.log('[ensureCaregiverExists] Caregiver created:', inserted?.id);
    }
  }
}

export async function fetchDashboardStats() {
  const supabase = getSupabase();

  // Preferred path: fetch pre-aggregated stats from edge function.
  // This includes credits + escalations and keeps dashboard math consistent.
  try {
    const { data: { session } } = await supabase.auth.refreshSession();
    if (session) {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/dashboard-stats`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
          },
        }
      );
      if (response.ok) {
        return response.json();
      }
    }
  } catch {
    // Fallback to direct table queries below.
  }

  // Use UTC-based date boundaries for consistency
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  const todayEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);

  // Run all queries in parallel (including recent calls, escalations, and credits)
  const [callsResult, pendingResult, weekResult, patientsResult, recentResult, escalationsResult, balanceResult] = await Promise.all([
    // Today's call logs
    supabase
      .from('reminder_call_logs')
      .select('*, patients(name), medications(name, dosage)')
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString())
      .order('created_at', { ascending: false }),
    // Today's pending scheduled calls
    supabase
      .from('scheduled_reminder_calls')
      .select('*, patients(name), medications(name)')
      .eq('status', 'pending')
      .gte('scheduled_for', todayStart.toISOString())
      .lte('scheduled_for', todayEnd.toISOString()),
    // This week's calls for adherence
    supabase
      .from('reminder_call_logs')
      .select('medication_taken')
      .gte('created_at', weekStart.toISOString())
      .not('medication_taken', 'is', null),
    // All patients with medication count
    supabase
      .from('patients')
      .select('id, name, phone_number, timezone, medications(id)'),
    // Recent calls (last 10)
    supabase
      .from('reminder_call_logs')
      .select('*, patients(name), medications(name, dosage)')
      .order('created_at', { ascending: false })
      .limit(10),
    // Active escalations
    supabase
      .from('escalation_events')
      .select('*, patients(name)')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(5),
    // Credit balance
    supabase
      .from('credit_balances')
      .select('balance_minutes')
      .maybeSingle(),
  ]);

  // Check for errors
  const errors = [callsResult.error, pendingResult.error, weekResult.error, patientsResult.error, recentResult.error].filter(Boolean);
  if (errors.length > 0) {
    throw new Error(errors.map(e => e!.message).join('; '));
  }

  const todayCalls = callsResult.data || [];
  const pendingCalls = pendingResult.data || [];
  const weekCalls = weekResult.data || [];
  const patients = patientsResult.data || [];

  const taken = todayCalls.filter(c => c.medication_taken === true).length;
  // Only count missed when medication_taken is explicitly false AND not an unreached status
  const unreachedStatuses = ['no_answer', 'failed', 'voicemail'];
  const missed = todayCalls.filter(c =>
    c.medication_taken === false && !unreachedStatuses.includes(c.status)
  ).length;
  const unreached = todayCalls.filter(c =>
    unreachedStatuses.includes(c.status)
  ).length;
  const pending = pendingCalls.length +
    todayCalls.filter(c => ['initiated', 'answered'].includes(c.status) && c.medication_taken === null).length;

  const weekTotal = weekCalls.length;
  const weekTaken = weekCalls.filter(c => c.medication_taken === true).length;
  const weeklyAdherence = weekTotal > 0 ? Math.round((weekTaken / weekTotal) * 100) : 0;

  const escalations = escalationsResult.error ? [] : (escalationsResult.data || []);
  const credits = {
    balance_minutes: Number(balanceResult.data?.balance_minutes || 0),
  };

  return {
    today: { taken, pending, missed, unreached },
    patients,
    weekly_adherence: weeklyAdherence,
    recent_calls: recentResult.data || [],
    escalations,
    credits,
  };
}

export async function fetchPatients() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('patients')
    .select(`
      *,
      medications (id, name, dosage, reminder_time, is_active, refill_remaining_doses, refill_alert_threshold, last_refill_date)
    `)
    .order('name');

  if (error) throw error;
  return data;
}

export async function fetchPatient(id: string) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('patients')
    .select(`
      *,
      medications (id, name, description, dosage, reminder_time, reminder_days, is_active, refill_remaining_doses, refill_alert_threshold, last_refill_date),
      patient_caregivers (is_primary, caregivers (name, phone_number, email))
    `)
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

export async function fetchCallLogs(patientId?: string) {
  const supabase = getSupabase();
  let query = supabase
    .from('reminder_call_logs')
    .select('*, patients(name), medications(name, dosage)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (patientId) {
    query = query.eq('patient_id', patientId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function fetchWeeklyAdherence() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('weekly_adherence_rate')
    .select('*')
    .order('week_start', { ascending: true });

  if (error) throw error;
  return data;
}

export async function createPatient(patientData: {
  patient_name: string;
  patient_phone: string;
  medication_name: string;
  medication_dosage?: string;
  medication_description?: string;
  reminder_time: string;
  reminder_days?: number[];
  timezone?: string;
}) {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('No active session');

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/setup-patient`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(patientData),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || 'Failed to create patient');
  }
  return response.json();
}

export async function updatePatient(id: string, data: Record<string, any>) {
  const supabase = getSupabase();
  // Filter out empty strings that would overwrite DB defaults
  const cleanData = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== '')
  );

  const { error } = await supabase
    .from('patients')
    .update(cleanData)
    .eq('id', id);

  if (error) throw error;
}

export async function updateMedication(id: string, data: Record<string, any>) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('medications')
    .update(data)
    .eq('id', id);

  if (error) throw error;

  // If reminder_time, reminder_days, or is_active changed, update today's pending scheduled call
  // Wrap in try-catch so scheduled call sync doesn't block the main update
  if (data.reminder_time || data.reminder_days || data.is_active !== undefined) {
    try {
      const { data: med } = await supabase
        .from('medications')
        .select('patient_id, reminder_time, is_active, patients(timezone)')
        .eq('id', id)
        .single();

      if (med) {
        // Delete today's pending scheduled call for this medication
        await supabase
          .from('scheduled_reminder_calls')
          .delete()
          .eq('medication_id', id)
          .eq('status', 'pending')
          .gte('scheduled_for', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
          .lte('scheduled_for', new Date(new Date().setHours(23, 59, 59, 999)).toISOString());

        // If still active, regenerate today's call
        if (med.is_active) {
          const { data: { session } } = await supabase.auth.getSession();
          if (session) {
            fetch(
              `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/generate_daily_reminder_calls`,
              {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${session.access_token}`,
                  'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
                  'Content-Type': 'application/json',
                },
                body: '{}',
              }
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('Failed to sync scheduled calls:', e);
    }
  }
}

export async function deleteMedication(id: string) {
  const supabase = getSupabase();

  // Cancel any pending scheduled calls for this medication
  await supabase
    .from('scheduled_reminder_calls')
    .delete()
    .eq('medication_id', id)
    .eq('status', 'pending');

  const { error } = await supabase
    .from('medications')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function deletePatient(id: string) {
  const supabase = getSupabase();

  // Cancel any pending scheduled calls for this patient
  await supabase
    .from('scheduled_reminder_calls')
    .delete()
    .eq('patient_id', id)
    .eq('status', 'pending');

  // Delete patient (medications cascade-delete via DB FK)
  const { error } = await supabase
    .from('patients')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ── Credit & Plan Queries ──

export async function fetchCreditBalance() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('credit_balances')
    .select('balance_minutes, updated_at')
    .single();

  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || { balance_minutes: 0, updated_at: null };
}

export async function fetchCreditUsage(patientId?: string) {
  const supabase = getSupabase();
  let query = supabase
    .from('credit_usage')
    .select('*, patients(name)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (patientId) {
    query = query.eq('patient_id', patientId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function fetchCreditPurchases() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('credit_purchases')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;
  return data;
}

export async function updatePatientMaxDuration(patientId: string, minutes: number) {
  const supabase = getSupabase();
  const seconds = Math.max(60, Math.min(3600, minutes * 60));
  const { error } = await supabase
    .from('patients')
    .update({ max_call_duration_seconds: seconds })
    .eq('id', patientId);

  if (error) throw error;
}

// ── Stripe / Billing Queries ──

export async function purchaseCreditPack(packMinutes: number) {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const fnUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-checkout`;

  const response = await fetch(fnUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pack_minutes: packMinutes }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create checkout session');
  }

  const { url } = await response.json();
  return url as string;
}

export async function addManualCredits(minutes: number, note?: string) {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/admin-add-credits`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ minutes, note }),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to add credits');
  }

  return response.json();
}

export async function fetchAutoTopupSettings() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('auto_topup_settings')
    .select('*')
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function updateAutoTopupSettings(settings: {
  enabled: boolean;
  threshold_minutes: number;
  pack_minutes: number;
  pack_price_cents: number;
  pack_label: string;
}) {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: caregiver } = await supabase
    .from('caregivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!caregiver) throw new Error('Caregiver profile not found');

  const { error } = await supabase
    .from('auto_topup_settings')
    .upsert({
      caregiver_id: caregiver.id,
      ...settings,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'caregiver_id' });

  if (error) throw error;
}

export async function fetchCreditAnalytics() {
  const supabase = getSupabase();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [usageResult, purchasesResult] = await Promise.all([
    supabase
      .from('credit_usage')
      .select('created_at, minutes_deducted, balance_after')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: true }),
    supabase
      .from('credit_purchases')
      .select('created_at, minutes_purchased')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: true }),
  ]);

  if (usageResult.error) throw usageResult.error;
  if (purchasesResult.error) throw purchasesResult.error;

  return {
    usage: usageResult.data || [],
    purchases: purchasesResult.data || [],
  };
}

export async function fetchInvoices() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-invoices`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
      },
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to fetch invoices');
  }

  const { invoices } = await response.json();
  return invoices as any[];
}

export async function addMedication(data: {
  patient_id: string;
  name: string;
  dosage?: string;
  description?: string;
  reminder_time: string;
  reminder_days?: number[];
  refill_remaining_doses?: number | null;
  refill_alert_threshold?: number | null;
  last_refill_date?: string | null;
}) {
  const supabase = getSupabase();
  const { data: med, error } = await supabase
    .from('medications')
    .insert(data)
    .select()
    .single();

  if (error) throw error;

  // Generate today's scheduled call for the new medication
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      fetch(
        `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/generate_daily_reminder_calls`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'apikey': process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
            'Content-Type': 'application/json',
          },
          body: '{}',
        }
      ).catch(() => {});
    }
  } catch (e) {
    console.warn('Failed to generate scheduled call for new medication:', e);
  }

  return med;
}

export async function fetchCareTasks() {
  const supabase = getSupabase();
  const nowIso = new Date().toISOString();
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const [escalationsResult, missedResult, overdueCallsResult, refillResult, balanceResult] = await Promise.all([
    supabase
      .from('escalation_events')
      .select('id, level, type, details, created_at, patients(name)')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('reminder_call_logs')
      .select('id, status, medication_taken, created_at, patients(name), medications(name)')
      .or('medication_taken.eq.false,status.eq.no_answer,status.eq.failed,status.eq.voicemail')
      .gte('created_at', threeDaysAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('scheduled_reminder_calls')
      .select('id, scheduled_for, attempt_number, patients(name), medications(name)')
      .eq('status', 'pending')
      .lt('scheduled_for', nowIso)
      .order('scheduled_for', { ascending: true })
      .limit(20),
    supabase
      .from('medications')
      .select('id, name, refill_remaining_doses, refill_alert_threshold, patients(name)')
      .eq('is_active', true)
      .not('refill_remaining_doses', 'is', null)
      .order('refill_remaining_doses', { ascending: true })
      .limit(20),
    supabase
      .from('credit_balances')
      .select('balance_minutes')
      .maybeSingle(),
  ]);

  const tasks: Array<{
    id: string;
    type: 'escalation' | 'missed' | 'overdue_call' | 'refill' | 'low_credit';
    priority: 'high' | 'medium' | 'low';
    title: string;
    subtitle: string;
    created_at: string;
  }> = [];

  for (const e of (escalationsResult.data || []) as any[]) {
    const patientName = Array.isArray(e.patients) ? e.patients[0]?.name : e.patients?.name;
    tasks.push({
      id: `esc-${e.id}`,
      type: 'escalation',
      priority: e.level >= 3 ? 'high' : 'medium',
      title: `${patientName || 'Patient'} escalation`,
      subtitle: e.details || `Escalation level ${e.level}`,
      created_at: e.created_at,
    });
  }

  for (const c of (missedResult.data || []) as any[]) {
    const isUnreached = ['no_answer', 'failed', 'voicemail'].includes(c.status);
    const patientName = Array.isArray(c.patients) ? c.patients[0]?.name : c.patients?.name;
    const medName = Array.isArray(c.medications) ? c.medications[0]?.name : c.medications?.name;
    tasks.push({
      id: `call-${c.id}`,
      type: 'missed',
      priority: isUnreached ? 'medium' : 'high',
      title: `${patientName || 'Patient'} ${isUnreached ? 'was not reached' : 'missed medication'}`,
      subtitle: medName ? `Medication: ${medName}` : 'Recent call needs follow-up',
      created_at: c.created_at,
    });
  }

  for (const sc of (overdueCallsResult.data || []) as any[]) {
    const patientName = Array.isArray(sc.patients) ? sc.patients[0]?.name : sc.patients?.name;
    const medName = Array.isArray(sc.medications) ? sc.medications[0]?.name : sc.medications?.name;
    tasks.push({
      id: `due-${sc.id}`,
      type: 'overdue_call',
      priority: 'medium',
      title: `Pending reminder call is overdue`,
      subtitle: `${patientName || 'Patient'}${medName ? ` - ${medName}` : ''} (attempt ${sc.attempt_number || 1})`,
      created_at: sc.scheduled_for,
    });
  }

  for (const m of (refillResult.data || []) as any[]) {
    const remaining = Number(m.refill_remaining_doses || 0);
    const threshold = Number(m.refill_alert_threshold || 3);
    const patientName = Array.isArray(m.patients) ? m.patients[0]?.name : m.patients?.name;
    if (remaining <= threshold) {
      tasks.push({
        id: `refill-${m.id}`,
        type: 'refill',
        priority: remaining <= 1 ? 'high' : 'medium',
        title: `${patientName || 'Patient'} may need refill soon`,
        subtitle: `${m.name}: ${remaining} doses remaining`,
        created_at: new Date().toISOString(),
      });
    }
  }

  const balanceMinutes = Number(balanceResult.data?.balance_minutes || 0);
  if (balanceMinutes <= 10) {
    tasks.push({
      id: 'low-credit',
      type: 'low_credit',
      priority: balanceMinutes <= 5 ? 'high' : 'medium',
      title: 'Call credits are low',
      subtitle: `${Math.floor(balanceMinutes)} minutes remaining`,
      created_at: new Date().toISOString(),
    });
  }

  const priorityRank = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => {
    const p = priorityRank[a.priority] - priorityRank[b.priority];
    if (p !== 0) return p;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return tasks;
}
