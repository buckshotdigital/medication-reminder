import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;
const TWILIO_TEST_MODE = (Deno.env.get('TWILIO_TEST_MODE') || '').toLowerCase() === 'true';
const TWILIO_TEST_TO_NUMBER = Deno.env.get('TWILIO_TEST_TO_NUMBER') || '';

function verifyServiceAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return token === serviceRoleKey;
}

// In-memory rate limiter: max 5 escalations per patient per hour
const escalationCounts = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(patientId: string): boolean {
  const now = Date.now();
  const entry = escalationCounts.get(patientId);
  if (!entry || now > entry.resetAt) {
    escalationCounts.set(patientId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

serve(async (req) => {
  if (!verifyServiceAuth(req)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { patient_id, call_log_id } = await req.json();

    // Validate required fields and UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!patient_id || !uuidRegex.test(patient_id)) {
      return new Response(
        JSON.stringify({ error: 'Valid patient_id required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('[escalation-engine] Checking escalation for patient');

    // Rate limit: max 5 escalations per patient per hour
    if (!checkRateLimit(patient_id)) {
      console.log('[escalation-engine] Rate limit exceeded for patient');
      return new Response(
        JSON.stringify({ escalated: false, reason: 'Rate limit exceeded' }),
        { status: 429, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get consecutive misses
    const { data: missData } = await supabase
      .rpc('get_consecutive_misses', { p_patient_id: patient_id });

    const consecutiveMisses = missData || 0;
    console.log(`[escalation-engine] Consecutive misses: ${consecutiveMisses}`);

    if (consecutiveMisses === 0) {
      return new Response(
        JSON.stringify({ escalated: false, reason: 'No misses' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get patient and caregiver info
    const { data: patient } = await supabase
      .from('patients')
      .select('name, phone_number')
      .eq('id', patient_id)
      .single();

    const { data: links } = await supabase
      .from('patient_caregivers')
      .select('is_primary, caregivers(id, name, phone_number, notification_prefs)')
      .eq('patient_id', patient_id);

    if (!links || links.length === 0 || !patient) {
      console.log('[escalation-engine] No caregivers found');
      return new Response(
        JSON.stringify({ escalated: false, reason: 'No caregivers' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const primaryCaregivers = links.filter(l => l.is_primary);
    const allCaregivers = links;

    let escalationLevel = 0;
    let escalationType = 'missed_dose';
    const actions: string[] = [];

    // Configurable thresholds from primary caregiver preferences
    const primaryPrefs = (primaryCaregivers[0]?.caregivers as any)?.notification_prefs || {};
    const firstSmsAfterMisses = Math.max(1, Number(primaryPrefs.first_sms_after_misses || 1));
    const allSmsAfterMisses = Math.max(firstSmsAfterMisses, Number(primaryPrefs.all_sms_after_misses || 2));
    const callAfterMisses = Math.max(allSmsAfterMisses, Number(primaryPrefs.call_after_misses || 3));

    if (consecutiveMisses < firstSmsAfterMisses) {
      return new Response(
        JSON.stringify({
          escalated: false,
          reason: `Below threshold (${consecutiveMisses}/${firstSmsAfterMisses})`,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Escalation ladder
    if (consecutiveMisses >= callAfterMisses) {
      // Level 3: SMS to all + automated call to primary
      escalationLevel = 3;
      for (const link of allCaregivers) {
        const cg = link.caregivers as any;
        if (cg?.phone_number && cg?.notification_prefs?.sms_alerts !== false) {
          await sendSMS(
            cg.phone_number,
            `URGENT: ${patient.name} has missed ${consecutiveMisses} consecutive medication doses. Immediate attention needed. Patient phone: ${patient.phone_number}`
          );
          actions.push(`Urgent SMS sent to: ${cg.name}`);
        }
      }

      // Call primary caregiver
      for (const link of primaryCaregivers) {
        const cg = link.caregivers as any;
        if (cg?.phone_number && cg?.notification_prefs?.escalation_calls !== false) {
          await makeEscalationCall(cg.phone_number, patient.name, consecutiveMisses);
          actions.push(`Escalation call made to: ${cg.name}`);
        }
      }
    } else if (consecutiveMisses >= allSmsAfterMisses) {
      // Level 2: SMS to ALL caregivers
      escalationLevel = 2;
      for (const link of allCaregivers) {
        const cg = link.caregivers as any;
        if (cg?.phone_number && cg?.notification_prefs?.sms_alerts !== false) {
          await sendSMS(
            cg.phone_number,
            `ALERT: ${patient.name} has missed ${consecutiveMisses} consecutive medication doses. Please check in on them as soon as possible.`
          );
          actions.push(`SMS sent to caregiver: ${cg.name}`);
        }
      }
    } else {
      // Level 1: SMS to primary caregiver
      escalationLevel = 1;
      for (const link of primaryCaregivers) {
        const cg = link.caregivers as any;
        if (cg?.phone_number && cg?.notification_prefs?.sms_alerts !== false) {
          await sendSMS(
            cg.phone_number,
            `GentleRing: ${patient.name} missed their dose today. This is their first consecutive miss. Please check in on them.`
          );
          actions.push(`SMS sent to primary caregiver: ${cg.name}`);
        }
      }
    }

    // Record the escalation event
    await supabase.from('escalation_events').insert({
      patient_id,
      type: escalationType,
      level: escalationLevel,
      details: `${consecutiveMisses} consecutive misses. Actions: ${actions.join('; ')}`,
    });

    console.log(`[escalation-engine] Escalation level ${escalationLevel}, actions: ${actions.join(', ')}`);

    return new Response(
      JSON.stringify({
        escalated: true,
        level: escalationLevel,
        consecutive_misses: consecutiveMisses,
        actions,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[escalation-engine] Error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

async function sendSMS(to: string, body: string) {
  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: to,
          From: TWILIO_PHONE_NUMBER,
          Body: body,
        }),
      }
    );

    if (!response.ok) {
      console.error('[escalation-engine] SMS failed:', await response.text());
    } else {
      console.log(`[escalation-engine] SMS sent to ${to}`);
    }
  } catch (error) {
    console.error('[escalation-engine] SMS error:', error);
  }
}

async function makeEscalationCall(to: string, patientName: string, misses: number) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1];

  // Use a simple TwiML Say for the escalation call
  const twiml = encodeURIComponent(
    `<Response><Say voice="Polly.Amy">This is an urgent alert from GentleRing. ${patientName} has missed ${misses} consecutive medication doses and may need your help. Please check on them as soon as possible. Thank you.</Say></Response>`
  );

  try {
    const targetNumber = TWILIO_TEST_MODE && TWILIO_TEST_TO_NUMBER
      ? TWILIO_TEST_TO_NUMBER
      : to;
    if (TWILIO_TEST_MODE && TWILIO_TEST_TO_NUMBER) {
      console.log(`[escalation-engine] TEST MODE ON: routing call ${to} -> ${TWILIO_TEST_TO_NUMBER}`);
    }

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
          Twiml: `<Response><Say voice="Polly.Amy">This is an urgent alert from GentleRing. ${patientName} has missed ${misses} consecutive medication doses and may need your help. Please check on them as soon as possible. Thank you.</Say></Response>`,
          Timeout: '30',
        }),
      }
    );

    if (!response.ok) {
      console.error('[escalation-engine] Escalation call failed:', await response.text());
    } else {
      console.log(`[escalation-engine] Escalation call made to ${to}`);
    }
  } catch (error) {
    console.error('[escalation-engine] Call error:', error);
  }
}
