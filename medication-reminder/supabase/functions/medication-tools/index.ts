import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

function verifyServiceAuth(req: Request): boolean {
  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.replace('Bearer ', '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return token === serviceRoleKey;
}

// In-memory rate limiter: max 30 requests per minute per source
const requestCounts = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(key);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(key, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 30) return false;
  entry.count++;
  return true;
}

// This endpoint handles tool calls from ElevenLabs (alternative to WebSocket tool handling)
// Requires service role key authentication
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 204 });
  }

  if (!verifyServiceAuth(req)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Rate limit by source IP
  const sourceIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(sourceIp)) {
    return new Response(
      JSON.stringify({ error: 'Rate limit exceeded' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const { tool_name, parameters, call_sid, patient_id, medication_id } = await req.json();

    // Validate tool_name
    const validTools = ['confirm_medication_taken', 'medication_not_taken', 'schedule_callback',
      'alert_caregiver', 'trigger_emergency', 'get_patient_info', 'get_medication_info'];
    if (!tool_name || !validTools.includes(tool_name)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid tool_name' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Validate UUID format for IDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (patient_id && !uuidRegex.test(patient_id)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid patient_id format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (medication_id && !uuidRegex.test(medication_id)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid medication_id format' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[medication-tools] Tool: ${tool_name}`);

    let result: any = { success: true };

    switch (tool_name) {
      case 'confirm_medication_taken':
        result = await confirmMedicationTaken(call_sid, parameters);
        break;

      case 'medication_not_taken':
        result = await medicationNotTaken(call_sid, patient_id, medication_id, parameters);
        break;

      case 'schedule_callback':
        result = await scheduleCallback(patient_id, medication_id, parameters);
        break;

      case 'alert_caregiver':
        result = await alertCaregiver(patient_id, parameters);
        break;

      case 'trigger_emergency':
        result = await triggerEmergency(patient_id, parameters);
        break;

      case 'get_patient_info':
        result = await getPatientInfo(patient_id);
        break;

      case 'get_medication_info':
        result = await getMedicationInfo(medication_id);
        break;

      default:
        result = { success: false, error: `Unknown tool: ${tool_name}` };
    }

    return new Response(
      JSON.stringify({ result, success: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[medication-tools] Error:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});

async function confirmMedicationTaken(callSid: string, parameters: any) {
  if (callSid) {
    await supabase
      .from('reminder_call_logs')
      .update({
        medication_taken: true,
        notes: parameters?.notes || 'Confirmed taken by patient',
      })
      .eq('call_sid', callSid);
  }

  return {
    confirmed: true,
    message: 'Great! Medication has been logged as taken.',
  };
}

async function medicationNotTaken(
  callSid: string,
  patientId: string,
  medicationId: string,
  parameters: any
) {
  if (callSid) {
    await supabase
      .from('reminder_call_logs')
      .update({
        medication_taken: false,
        notes: parameters?.reason || 'Patient indicated not taken',
      })
      .eq('call_sid', callSid);
  }

  // Schedule callback if requested
  if (parameters?.schedule_callback && patientId && medicationId) {
    const minutes = parameters?.callback_minutes || 30;
    const callbackTime = new Date(Date.now() + minutes * 60 * 1000);

    await supabase.from('scheduled_reminder_calls').insert({
      patient_id: patientId,
      medication_id: medicationId,
      scheduled_for: callbackTime.toISOString(),
      attempt_number: 1,
    });

    return {
      acknowledged: true,
      callback_scheduled: true,
      callback_time: callbackTime.toISOString(),
      message: `I'll call back in ${minutes} minutes to remind you again.`,
    };
  }

  return {
    acknowledged: true,
    message: 'Noted. Please try to take your medication when you can.',
  };
}

async function scheduleCallback(patientId: string, medicationId: string, parameters: any) {
  const minutes = parameters?.minutes || 30;
  const callbackTime = new Date(Date.now() + minutes * 60 * 1000);

  await supabase.from('scheduled_reminder_calls').insert({
    patient_id: patientId,
    medication_id: medicationId,
    scheduled_for: callbackTime.toISOString(),
    attempt_number: 1,
  });

  return {
    scheduled: true,
    callback_time: callbackTime.toISOString(),
    message: `Callback scheduled for ${callbackTime.toLocaleTimeString()}`,
  };
}

async function alertCaregiver(patientId: string, parameters: any) {
  const reason = parameters?.reason || 'General concern';
  const urgency = parameters?.urgency || 'medium';

  const { data: links } = await supabase
    .from('patient_caregivers')
    .select(`
      caregivers (name, phone_number),
      patients (name)
    `)
    .eq('patient_id', patientId);

  if (!links || links.length === 0) {
    return { alerted: false, message: 'No caregivers found' };
  }

  const patientName = links[0].patients?.name || 'Patient';
  const prefix = urgency === 'high' ? '⚠️ ' : '';
  let alertsSent = 0;

  for (const link of links) {
    const caregiver = link.caregivers;
    if (!caregiver?.phone_number) continue;

    try {
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: caregiver.phone_number,
            From: TWILIO_PHONE_NUMBER,
            Body: `${prefix}GentleRing Alert for ${patientName}: ${reason}`,
          }),
        }
      );
      alertsSent++;
    } catch (error) {
      console.error('[medication-tools] Failed to send SMS:', error);
    }
  }

  return {
    alerted: true,
    alerts_sent: alertsSent,
    message: `Caregiver has been notified about: ${reason}`,
  };
}

async function triggerEmergency(patientId: string, parameters: any) {
  const reason = parameters?.reason || 'Emergency reported by patient';

  console.error('[medication-tools] EMERGENCY:', patientId, reason);

  // Alert all caregivers urgently
  const { data: links } = await supabase
    .from('patient_caregivers')
    .select(`
      caregivers (name, phone_number),
      patients (name, phone_number)
    `)
    .eq('patient_id', patientId);

  if (links && links.length > 0) {
    const patientName = links[0].patients?.name || 'Patient';
    const patientPhone = links[0].patients?.phone_number || 'Unknown';

    for (const link of links) {
      const caregiver = link.caregivers;
      if (!caregiver?.phone_number) continue;

      try {
        // Send urgent SMS
        await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              To: caregiver.phone_number,
              From: TWILIO_PHONE_NUMBER,
              Body: `🚨 EMERGENCY: ${patientName} (${patientPhone}) needs immediate help! Reason: ${reason}. Call them or emergency services immediately!`,
            }),
          }
        );
      } catch (error) {
        console.error('[medication-tools] Failed to send emergency SMS:', error);
      }
    }
  }

  // Log the emergency
  await supabase.from('reminder_call_logs').insert({
    patient_id: patientId,
    status: 'emergency',
    notes: `EMERGENCY: ${reason}`,
  });

  return {
    emergency_triggered: true,
    message: 'Emergency services and caregivers have been notified. Help is on the way.',
  };
}

async function getPatientInfo(patientId: string) {
  const { data, error } = await supabase
    .from('patients')
    .select('*')
    .eq('id', patientId)
    .single();

  if (error) {
    return { error: error.message };
  }

  return {
    name: data.name,
    timezone: data.timezone,
  };
}

async function getMedicationInfo(medicationId: string) {
  const { data, error } = await supabase
    .from('medications')
    .select('*')
    .eq('id', medicationId)
    .single();

  if (error) {
    return { error: error.message };
  }

  return {
    name: data.name,
    description: data.description,
    dosage: data.dosage,
    reminder_time: data.reminder_time,
  };
}
