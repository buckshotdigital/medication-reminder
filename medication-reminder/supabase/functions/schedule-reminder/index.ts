import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { encode as encodeBase64Url } from 'https://deno.land/std@0.168.0/encoding/base64url.ts';

async function verifyServiceRoleJWT(token: string): Promise<boolean> {
  const jwtSecret = Deno.env.get('SUPABASE_JWT_SECRET');
  if (!jwtSecret) {
    // Fallback: if JWT secret not available, verify role claim only
    // (gateway still validates signature when deployed without --no-verify-jwt)
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.role === 'service_role';
  }

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  // Verify HMAC-SHA256 signature
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(jwtSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  const expectedSig = encodeBase64Url(new Uint8Array(signature));
  if (expectedSig !== parts[2]) return false;

  // Signature valid — now check claims
  const payload = JSON.parse(atob(parts[1]));
  if (payload.role !== 'service_role') return false;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return false;

  return true;
}

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
const TWILIO_TEST_MODE = (Deno.env.get('TWILIO_TEST_MODE') || '').toLowerCase() === 'true';
const TWILIO_TEST_TO_NUMBER = Deno.env.get('TWILIO_TEST_TO_NUMBER') || '';

serve(async (req) => {
  const cors = getCorsHeaders(req);

  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  // Auth check: service-role only (from pg_cron / trusted backend)
  // Verifies HMAC-SHA256 signature + role claim when SUPABASE_JWT_SECRET is set,
  // otherwise falls back to role claim check (gateway still validates signature).
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');

  try {
    const isValid = await verifyServiceRoleJWT(token);
    if (!isValid) {
      console.log('[schedule-reminder] Unauthorized: JWT verification failed');
      return new Response(
        JSON.stringify({ success: false, error: 'Unauthorized' }),
        { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 }
      );
    }
  } catch (e) {
    console.log('[schedule-reminder] Unauthorized: invalid token -', e.message);
    return new Response(
      JSON.stringify({ success: false, error: 'Unauthorized' }),
      { headers: { ...cors, 'Content-Type': 'application/json' }, status: 401 }
    );
  }
  console.log('[schedule-reminder] Auth: service_role verified');

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
      .limit(20);

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

    // Claim all pending rows atomically first (sequential to avoid race conditions)
    const claimedCalls = [];
    for (const call of pendingCalls) {
      const { data: claimedRows, error: claimError } = await supabase
        .from('scheduled_reminder_calls')
        .update({ status: 'in_progress' })
        .eq('id', call.id)
        .eq('status', 'pending')
        .select('id');

      if (claimError) {
        console.error(`[schedule-reminder] Claim error for ${call.id}:`, claimError);
        continue;
      }
      if (!claimedRows || claimedRows.length === 0) {
        console.log(`[schedule-reminder] Call ${call.id} already claimed, skipping`);
        continue;
      }
      claimedCalls.push(call);
    }

    console.log(`[schedule-reminder] Claimed ${claimedCalls.length} of ${pendingCalls.length} calls`);

    // Dispatch all claimed calls in parallel
    const results = await Promise.all(claimedCalls.map(async (call) => {
      try {
        console.log(`[schedule-reminder] Dispatching call for ${call.patients?.name}`);

        // Look up patient's max call duration, cap by available credits
        let maxDuration = 300; // Default: 5 minutes
        try {
          const { data: planData } = await supabase.rpc('get_patient_plan', {
            p_patient_id: call.patients.id,
          });
          if (planData && planData.length > 0) {
            const plan = planData[0];
            const configMax = plan.max_call_duration_seconds;
            const balanceMin = plan.balance_minutes;
            maxDuration = configMax;
            if (balanceMin > 0) {
              const creditSeconds = Math.floor(balanceMin * 60);
              maxDuration = Math.min(maxDuration, creditSeconds);
            } else {
              maxDuration = Math.min(maxDuration, 60);
            }
            console.log(`[schedule-reminder] Patient ${call.patients.name}: configMax=${configMax}s, balance=${balanceMin}min, creditCap=${Math.floor(balanceMin * 60)}s, final maxDuration=${maxDuration}s`);
          } else {
            console.log(`[schedule-reminder] Patient ${call.patients.name}: no plan data, using default ${maxDuration}s`);
          }
        } catch (planErr) {
          console.warn('[schedule-reminder] Plan lookup failed, using default 300s:', planErr);
        }

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
          call.medications.dosage || '',
          maxDuration
        );

        // Create call log + mark scheduled call as completed (parallel)
        const [insertResult, updateResult] = await Promise.all([
          supabase.from('reminder_call_logs').insert({
            patient_id: call.patients.id,
            medication_id: call.medications.id,
            call_sid: callResult.sid,
            status: 'initiated',
            attempt_number: call.attempt_number,
          }),
          supabase
            .from('scheduled_reminder_calls')
            .update({ status: 'completed' })
            .eq('id', call.id),
        ]);

        if (insertResult.error) {
          console.error(`[schedule-reminder] FAILED to insert call log for ${call.patients.name}:`, insertResult.error);
        }
        if (updateResult.error) {
          console.error(`[schedule-reminder] FAILED to update scheduled call:`, updateResult.error);
        }

        console.log(`[schedule-reminder] Call initiated: ${callResult.sid}`);

        return {
          scheduled_call_id: call.id,
          patient: call.patients.name,
          status: 'success',
          call_sid: callResult.sid,
        };

      } catch (error) {
        console.error(`[schedule-reminder] Failed to initiate call:`, error);

        await supabase
          .from('scheduled_reminder_calls')
          .update({ status: 'failed' })
          .eq('id', call.id);

        return {
          scheduled_call_id: call.id,
          patient: call.patients?.name,
          status: 'failed',
          error: error.message,
        };
      }
    }));

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
  medicationDosage: string = '',
  maxDuration: number = 300
): Promise<{ sid: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1];

  const webhookBase = `https://${projectRef}.supabase.co/functions/v1/twilio-webhook`;
  const wsUrl = `wss://${projectRef}.supabase.co/functions/v1/twilio-media-stream`;

  const targetNumber = TWILIO_TEST_MODE && TWILIO_TEST_TO_NUMBER
    ? TWILIO_TEST_TO_NUMBER
    : toNumber;
  if (TWILIO_TEST_MODE && TWILIO_TEST_TO_NUMBER) {
    console.log(`[schedule-reminder] TEST MODE ON: routing call ${toNumber} -> ${TWILIO_TEST_TO_NUMBER}`);
  }
  console.log(`[schedule-reminder] Calling ${targetNumber} via ${TWILIO_PHONE_NUMBER}`);

  // Build medication_ids param for Stream parameter
  let medIdsStreamParam = '';
  if (medicationIds.length > 0) {
    medIdsStreamParam = `\n      <Parameter name="medication_ids" value="${JSON.stringify(medicationIds).replace(/"/g, '&quot;')}" />`;
  }

  // Build inline TwiML — skips the webhook round trip entirely
  // Pause gives callee ~1 second to settle after picking up before AI speaks
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
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
        To: targetNumber,
        From: TWILIO_PHONE_NUMBER,
        Twiml: twiml,
        StatusCallback: `${webhookBase}/status`,
        StatusCallbackEvent: 'initiated ringing answered completed',
        Timeout: '30',
        TimeLimit: String(maxDuration),
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
