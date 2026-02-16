import { createClient } from './supabase/client';

function getSupabase() {
  return createClient();
}

export async function fetchDashboardStats() {
  const supabase = getSupabase();

  // Use UTC-based date boundaries for consistency
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0));
  const todayEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  const weekStart = new Date(todayStart);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);

  // Run all queries in parallel (including recentCalls)
  const [callsResult, pendingResult, weekResult, patientsResult, recentResult] = await Promise.all([
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

  return {
    today: { taken, pending, missed, unreached },
    patients,
    weekly_adherence: weeklyAdherence,
    recent_calls: recentResult.data || [],
    escalations: [],
  };
}

export async function fetchPatients() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('patients')
    .select(`
      *,
      medications (id, name, dosage, reminder_time, is_active)
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
      medications (id, name, description, dosage, reminder_time, reminder_days, is_active),
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

export async function fetchPatientPlans() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('patient_plans')
    .select('*, patients(name), plans(*)')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

export async function updatePatientPlan(patientId: string, planId: string) {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Get caregiver id
  const { data: caregiver } = await supabase
    .from('caregivers')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!caregiver) throw new Error('Caregiver profile not found');

  // Deactivate existing plan for this patient
  await supabase
    .from('patient_plans')
    .update({ is_active: false, ended_at: new Date().toISOString() })
    .eq('patient_id', patientId)
    .eq('caregiver_id', caregiver.id)
    .eq('is_active', true);

  // Insert new plan assignment
  const { error } = await supabase
    .from('patient_plans')
    .upsert({
      patient_id: patientId,
      caregiver_id: caregiver.id,
      plan_id: planId,
      is_active: true,
      started_at: new Date().toISOString(),
      ended_at: null,
    }, {
      onConflict: 'patient_id,caregiver_id',
    });

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

export async function createSubscription() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-subscribe`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create subscription');
  }

  const { url } = await response.json();
  return url as string;
}

export async function createPortalSession() {
  const supabase = getSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/stripe-portal`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to create portal session');
  }

  const { url } = await response.json();
  return url as string;
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
