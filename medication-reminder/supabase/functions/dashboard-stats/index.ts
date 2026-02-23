import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = Deno.env.get('ALLOWED_ORIGIN') || '';
  const allowedOrigins = allowed ? allowed.split(',').map(o => o.trim()) : [];
  const isAllowed = allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0] || '',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // Verify JWT using a user-scoped client
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');

    if (!token) {
      return new Response(
        JSON.stringify({ error: 'Authentication required' }),
        { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    // Verify the user's token
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    // Get caregiver record
    const { data: caregiver } = await supabase
      .from('caregivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();

    if (!caregiver) {
      return new Response(
        JSON.stringify({ error: 'Caregiver profile not found' }),
        { headers: { ...cors, 'Content-Type': 'application/json' }, status: 404 }
      );
    }

    // Get linked patient IDs
    const { data: links } = await supabase
      .from('patient_caregivers')
      .select('patient_id')
      .eq('caregiver_id', caregiver.id);

    const patientIds = links?.map(l => l.patient_id) || [];

    if (patientIds.length === 0) {
      return new Response(
        JSON.stringify({
          today: { taken: 0, pending: 0, missed: 0, unreached: 0 },
          patients: [],
          weekly_adherence: 0,
          recent_calls: [],
          escalations: [],
        }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    // Today's date range
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    // Get today's call logs for linked patients
    const { data: todayCalls } = await supabase
      .from('reminder_call_logs')
      .select('*, patients(name), medications(name, dosage)')
      .in('patient_id', patientIds)
      .gte('created_at', todayStart.toISOString())
      .lte('created_at', todayEnd.toISOString())
      .order('created_at', { ascending: false });

    // Get today's pending scheduled calls
    const { data: pendingCalls } = await supabase
      .from('scheduled_reminder_calls')
      .select('*, patients(name), medications(name)')
      .in('patient_id', patientIds)
      .eq('status', 'pending')
      .gte('scheduled_for', todayStart.toISOString())
      .lte('scheduled_for', todayEnd.toISOString());

    // Count today's statuses
    const taken = todayCalls?.filter(c => c.medication_taken === true).length || 0;
    const missed = todayCalls?.filter(c => c.medication_taken === false).length || 0;
    const unreached = todayCalls?.filter(c =>
      ['no_answer', 'failed', 'voicemail'].includes(c.status)
    ).length || 0;
    const pending = (pendingCalls?.length || 0) +
      (todayCalls?.filter(c => ['initiated', 'answered'].includes(c.status) && c.medication_taken === null).length || 0);

    // Get this week's adherence rate
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const { data: weekCalls } = await supabase
      .from('reminder_call_logs')
      .select('medication_taken')
      .in('patient_id', patientIds)
      .gte('created_at', weekStart.toISOString())
      .not('medication_taken', 'is', null);

    const weekTotal = weekCalls?.length || 0;
    const weekTaken = weekCalls?.filter(c => c.medication_taken === true).length || 0;
    const weeklyAdherence = weekTotal > 0 ? Math.round((weekTaken / weekTotal) * 100) : 0;

    // Get patient list with latest status
    const { data: patients } = await supabase
      .from('patients')
      .select('id, name, phone_number, timezone')
      .in('id', patientIds);

    // Get recent calls (last 10)
    const { data: recentCalls } = await supabase
      .from('reminder_call_logs')
      .select('*, patients(name), medications(name, dosage)')
      .in('patient_id', patientIds)
      .order('created_at', { ascending: false })
      .limit(10);

    // Get active escalations (if table exists)
    let escalations: any[] = [];
    try {
      const { data: escData } = await supabase
        .from('escalation_events')
        .select('*, patients(name)')
        .in('patient_id', patientIds)
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(5);
      escalations = escData || [];
    } catch {
      // escalation_events table may not exist yet
    }

    // Get credit balance
    let credits = { balance_minutes: 0 };
    try {
      const { data: balanceData } = await supabase
        .from('credit_balances')
        .select('balance_minutes')
        .eq('caregiver_id', caregiver.id)
        .single();

      if (balanceData) {
        credits.balance_minutes = Number(balanceData.balance_minutes) || 0;
      }
    } catch {
      // credit tables may not exist yet
    }

    return new Response(
      JSON.stringify({
        today: { taken, pending, missed, unreached },
        patients: patients || [],
        weekly_adherence: weeklyAdherence,
        recent_calls: recentCalls || [],
        escalations,
        credits,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[dashboard-stats] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
