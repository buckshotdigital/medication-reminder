import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = Deno.env.get('ALLOWED_ORIGIN') || '';
  const allowedOrigins = allowed ? allowed.split(',').map(o => o.trim()) : [];
  const isAllowed = allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0] || '',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

serve(async (req) => {
  const cors = getCorsHeaders(req);

  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  // Auth check: allow service-role key (from pg_cron) or valid user JWT
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let authorized = false;

  // Check 1: direct match against service role key (used by pg_cron)
  if (token && token === serviceRoleKey) {
    authorized = true;
    console.log('[schedule-reminder] Auth: service role key match');
  }

  // Check 2: verify user JWT with Supabase Auth (for dashboard-triggered calls)
  if (!authorized && token) {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (!error && user) {
      authorized = true;
      console.log('[schedule-reminder] Auth: valid user JWT');
    }
  }

  if (!authorized) {
    console.log('[schedule-reminder] Unauthorized access attempt');
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 }
    );
  }

  console.log('[schedule-reminder] Checking for pending calls...');

  try {
    const now = new Date();

    // Find all pending scheduled calls that are due
    const { data: pendingCalls, error: fetchError } = await supabase
      .from('scheduled_reminder_calls')
      .select(`
        *,
        patients (id, name, phone_number),
        medications (id, name, description, dosage)
      `)
      .eq('status', 'pending')
      .lte('scheduled_for', now.toISOString())
      .order('scheduled_for', { ascending: true })
      .limit(10);

    if (fetchError) {
      throw fetchError;
    }

    if (!pendingCalls || pendingCalls.length === 0) {
      console.log('[schedule-reminder] No pending calls');
      return new Response(
        JSON.stringify({ success: true, message: 'No pending calls', calls_made: 0 }),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[schedule-reminder] Found ${pendingCalls.length} pending calls`);

    const results = [];

    for (const call of pendingCalls) {
      try {
        console.log(`[schedule-reminder] Processing call for ${call.patients?.name}`);

        // Mark as in progress
        await supabase
          .from('scheduled_reminder_calls')
          .update({ status: 'in_progress' })
          .eq('id', call.id);

        // Build medication_ids list for multi-med bundling
        const medicationIds = call.medication_ids?.length > 0
          ? call.medication_ids
          : [call.medications.id];

        // Initiate the call — pass names so media stream skips DB lookups
        const callResult = await initiateCall(
          call.patients.phone_number,
          call.patients.id,
          call.medications.id,
          call.attempt_number,
          medicationIds,
          call.patients.name,
          call.medications.name,
          call.medications.dosage || ''
        );

        // Create call log
        await supabase.from('reminder_call_logs').insert({
          patient_id: call.patients.id,
          medication_id: call.medications.id,
          call_sid: callResult.sid,
          status: 'initiated',
          attempt_number: call.attempt_number,
        });

        // Mark scheduled call as completed
        await supabase
          .from('scheduled_reminder_calls')
          .update({ status: 'completed' })
          .eq('id', call.id);

        results.push({
          scheduled_call_id: call.id,
          patient: call.patients.name,
          status: 'success',
          call_sid: callResult.sid,
        });

        console.log(`[schedule-reminder] Call initiated: ${callResult.sid}`);

      } catch (error) {
        console.error(`[schedule-reminder] Failed to initiate call:`, error);

        // Mark as failed
        await supabase
          .from('scheduled_reminder_calls')
          .update({ status: 'failed' })
          .eq('id', call.id);

        results.push({
          scheduled_call_id: call.id,
          patient: call.patients?.name,
          status: 'failed',
          error: error.message,
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        calls_made: results.filter(r => r.status === 'success').length,
        results,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[schedule-reminder] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

async function initiateCall(
  toNumber: string,
  patientId: string,
  medicationId: string,
  attemptNumber: number,
  medicationIds: string[] = [],
  patientName: string = '',
  medicationName: string = '',
  medicationDosage: string = ''
): Promise<{ sid: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1];

  const webhookBase = `https://${projectRef}.supabase.co/functions/v1/twilio-webhook`;
  const wsUrl = `wss://${projectRef}.supabase.co/functions/v1/twilio-media-stream`;

  console.log(`[schedule-reminder] Calling ${toNumber} via ${TWILIO_PHONE_NUMBER}`);

  // Build medication_ids param for Stream parameter
  let medIdsStreamParam = '';
  if (medicationIds.length > 0) {
    medIdsStreamParam = `\n      <Parameter name="medication_ids" value="${JSON.stringify(medicationIds).replace(/"/g, '&quot;')}" />`;
  }

  // Build inline TwiML — skips the webhook round trip entirely
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="patient_id" value="${patientId}" />
      <Parameter name="medication_id" value="${medicationId}" />${medIdsStreamParam}
      <Parameter name="patient_name" value="${patientName.replace(/"/g, '&quot;')}" />
      <Parameter name="medication_name" value="${medicationName.replace(/"/g, '&quot;')}" />
      <Parameter name="medication_dosage" value="${medicationDosage.replace(/"/g, '&quot;')}" />
    </Stream>
  </Connect>
</Response>`;

  console.log(`[schedule-reminder] Using inline TwiML (no webhook round trip)`);

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: toNumber,
        From: TWILIO_PHONE_NUMBER,
        Twiml: twiml,
        StatusCallback: `${webhookBase}/status`,
        StatusCallbackEvent: 'initiated ringing answered completed',
        Timeout: '30',
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${errorText}`);
  }

  const result = await response.json();
  return { sid: result.sid };
}
