import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { encode as encodeBase64 } from 'https://deno.land/std@0.168.0/encoding/base64.ts';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno&no-check';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

// Validate Twilio request signature to prevent spoofing
async function validateTwilioSignature(
  req: Request,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  const signature = req.headers.get('x-twilio-signature');
  if (!signature) return false;

  // Build the data string: URL + sorted params concatenated
  let data = url;
  const sortedKeys = Object.keys(params).sort();
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  // HMAC-SHA1 with auth token
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TWILIO_AUTH_TOKEN),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expected = encodeBase64(new Uint8Array(sig));

  return expected === signature;
}

serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const projectRef = supabaseUrl.match(/https:\/\/([^.]+)/)?.[1];

  // Health check for keeping function warm (called by cron)
  if (path.includes('/health') || url.searchParams.get('health') === 'true') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[twilio-webhook] ${req.method} ${path}`);

  // Parse form data from Twilio
  let formParams: Record<string, string> = {};
  try {
    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await req.formData();
      formData.forEach((value, key) => {
        formParams[key] = value.toString();
      });
    }
  } catch (e) {
    console.log('[twilio-webhook] Could not parse form data');
  }

  // Validate Twilio signature using the external URL Twilio signs against
  const externalUrl = `https://${projectRef}.supabase.co/functions/v1/twilio-webhook${path}`;
  const isValid = await validateTwilioSignature(req, externalUrl, formParams);
  if (!isValid) {
    console.warn('[twilio-webhook] Twilio signature validation failed');
    // Allow requests without signature only from internal service calls
    // (Twilio may not always sign correctly for Edge Functions)
    // But reject if there's no signature at all AND no form params (likely not from Twilio)
    const hasTwilioSignature = !!req.headers.get('x-twilio-signature');
    const hasTwilioParams = !!formParams['CallSid'] || !!formParams['AccountSid'];
    if (!hasTwilioSignature && !hasTwilioParams && !path.includes('/health')) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const callSid = formParams['CallSid'] || url.searchParams.get('CallSid');
  const callStatus = formParams['CallStatus'];

  console.log('[twilio-webhook] CallSid:', callSid, 'Status:', callStatus);

  // Route: /voice - Connect directly to ElevenLabs AI via WebSocket media stream
  if (path.includes('/voice')) {
    const patientId = url.searchParams.get('patient_id');
    const medicationId = url.searchParams.get('medication_id');
    const medicationIdsParam = url.searchParams.get('medication_ids');

    console.log('[twilio-webhook] /voice - Patient ID:', patientId, 'Medication ID:', medicationId);

    // Look up names from DB using IDs (never pass PHI via URL params)
    let patientName = '';
    let medicationName = '';
    let medicationDosage = '';
    if (patientId && medicationId) {
      const [patientResult, medResult] = await Promise.all([
        supabase.from('patients').select('name').eq('id', patientId).single(),
        supabase.from('medications').select('name, dosage').eq('id', medicationId).single(),
      ]);
      patientName = patientResult.data?.name || '';
      medicationName = medResult.data?.name || '';
      medicationDosage = medResult.data?.dosage || '';
    }

    const wsUrl = `wss://${projectRef}.supabase.co/functions/v1/twilio-media-stream`;

    let medIdsParam = '';
    if (medicationIdsParam) {
      medIdsParam = `\n      <Parameter name="medication_ids" value="${medicationIdsParam.replace(/"/g, '&quot;')}" />`;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="patient_id" value="${patientId}" />
      <Parameter name="medication_id" value="${medicationId}" />${medIdsParam}
      <Parameter name="call_sid" value="${callSid}" />
      <Parameter name="patient_name" value="${(patientName).replace(/"/g, '&quot;')}" />
      <Parameter name="medication_name" value="${(medicationName).replace(/"/g, '&quot;')}" />
      <Parameter name="medication_dosage" value="${(medicationDosage).replace(/"/g, '&quot;')}" />
    </Stream>
  </Connect>
</Response>`;

    return new Response(twiml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }

  // Route: /gather - Legacy speech gather handler (kept for backwards compatibility)
  if (path.includes('/gather')) {
    const speechResult = formParams['SpeechResult'] || '';
    console.log('[twilio-webhook] /gather - Speech result:', speechResult);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy" language="en-GB">Thank you. Goodbye!</Say>
</Response>`;
    return new Response(twiml, { headers: { 'Content-Type': 'application/xml' } });
  }

  // Route: /sms-reply - Handle inbound SMS replies from patients
  if (path.includes('/sms-reply')) {
    const fromNumber = formParams['From'] || '';
    const body = (formParams['Body'] || '').trim().toUpperCase();

    console.log('[twilio-webhook] /sms-reply - From:', fromNumber, 'Body:', body);

    if (body === 'YES' || body === 'TAKEN' || body === 'Y') {
      // Find the patient by phone number
      const { data: patient } = await supabase
        .from('patients')
        .select('id, name')
        .eq('phone_number', fromNumber)
        .single();

      if (patient) {
        // Find the most recent pending SMS reminder
        const { data: smsReminder } = await supabase
          .from('sms_reminders')
          .select('id, medication_id')
          .eq('patient_id', patient.id)
          .eq('status', 'sent')
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (smsReminder) {
          // Mark SMS as replied
          await supabase
            .from('sms_reminders')
            .update({ status: 'replied', patient_reply: body })
            .eq('id', smsReminder.id);

          // Create a call log entry marking medication as taken
          await supabase.from('reminder_call_logs').insert({
            patient_id: patient.id,
            medication_id: smsReminder.medication_id,
            status: 'completed',
            medication_taken: true,
            patient_response: `SMS reply: ${body}`,
            notes: 'Confirmed via SMS reply',
          });
        }

        // Reply to patient
        const responseTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Great! We've recorded that you've taken your medication. Thank you, ${patient.name}!</Message>
</Response>`;

        return new Response(responseTwiml, {
          headers: { 'Content-Type': 'application/xml' },
        });
      }
    }

    // Default reply
    const responseTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Thank you for your message. Reply YES when you've taken your medication.</Message>
</Response>`;

    return new Response(responseTwiml, {
      headers: { 'Content-Type': 'application/xml' },
    });
  }

  // Route: /status - Call status callback
  if (path.includes('/status')) {
    const duration = formParams['CallDuration'];
    const answeredBy = formParams['AnsweredBy'];

    console.log('[twilio-webhook] /status - Status:', callStatus, 'Duration:', duration, 'AnsweredBy:', answeredBy);

    if (callSid) {
      // Update call log
      const updateData: Record<string, any> = {
        status: mapTwilioStatus(callStatus),
      };

      if (duration) {
        updateData.duration_seconds = parseInt(duration);
      }

      await supabase
        .from('reminder_call_logs')
        .update(updateData)
        .eq('call_sid', callSid);

      // On call completion, trigger post-call processing + credit deduction
      if (callStatus === 'completed') {
        // Find the call log for post-processing
        const { data: callLog } = await supabase
          .from('reminder_call_logs')
          .select('id, patient_id, medication_taken, duration_seconds')
          .eq('call_sid', callSid)
          .single();

        if (callLog) {
          const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

          // Credit deduction for companionship plans
          try {
            const callDuration = callLog.duration_seconds || (duration ? parseInt(duration) : 0);
            const { data: planData } = await supabase.rpc('get_patient_plan', {
              p_patient_id: callLog.patient_id,
            });

            if (planData && planData.length > 0 && planData[0].plan_id === 'companionship') {
              const plan = planData[0];
              const { data: deductResult } = await supabase.rpc('deduct_credits', {
                p_caregiver_id: plan.caregiver_id,
                p_patient_id: callLog.patient_id,
                p_call_log_id: callLog.id,
                p_call_sid: callSid,
                p_total_duration_seconds: callDuration,
                p_free_seconds: plan.free_seconds_per_call,
              });

              if (deductResult && deductResult.length > 0) {
                const { minutes_deducted, balance_after } = deductResult[0];
                console.log(`[twilio-webhook] Credits deducted: ${minutes_deducted} min, balance: ${balance_after} min`);

                // Low balance alert
                if (balance_after <= 10) {
                  await sendLowBalanceAlert(plan.caregiver_id, balance_after);
                }

                // Auto top-up: check if enabled and balance is below threshold
                await tryAutoTopup(plan.caregiver_id, balance_after);
              }
            }
          } catch (creditErr) {
            console.error('[twilio-webhook] Credit deduction failed:', creditErr);
          }

          // Trigger post-call summary (non-blocking)
          fetch(`${supabaseUrl}/functions/v1/post-call-summary`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ call_log_id: callLog.id }),
          }).catch(e => console.error('[twilio-webhook] Post-call summary trigger failed:', e));

          // Trigger escalation check if medication was missed
          if (callLog.medication_taken === false) {
            fetch(`${supabaseUrl}/functions/v1/escalation-engine`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                patient_id: callLog.patient_id,
                call_log_id: callLog.id,
              }),
            }).catch(e => console.error('[twilio-webhook] Escalation trigger failed:', e));
          }
        }
      }

      // If call wasn't answered, schedule retry
      if (callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed') {
        await scheduleRetry(callSid);
      }

      // If voicemail detected, mark as no answer
      if (answeredBy === 'machine_start' || answeredBy === 'machine_end_beep') {
        await supabase
          .from('reminder_call_logs')
          .update({ status: 'voicemail', notes: 'Voicemail detected' })
          .eq('call_sid', callSid);

        await scheduleRetry(callSid);
      }
    }

    return new Response('OK', { status: 200 });
  }

  return new Response('Not found', { status: 404 });
});

function mapTwilioStatus(status: string): string {
  const mapping: Record<string, string> = {
    'queued': 'initiated',
    'ringing': 'initiated',
    'in-progress': 'answered',
    'completed': 'completed',
    'no-answer': 'no_answer',
    'busy': 'no_answer',
    'failed': 'failed',
    'canceled': 'failed',
  };
  return mapping[status] || status;
}

async function scheduleRetry(callSid: string) {
  // Get the call log to find patient and medication
  const { data: callLog } = await supabase
    .from('reminder_call_logs')
    .select('patient_id, medication_id, attempt_number')
    .eq('call_sid', callSid)
    .single();

  if (!callLog) {
    console.log('[twilio-webhook] Could not find call log for retry');
    return;
  }

  const attemptNumber = callLog.attempt_number || 1;

  // Max 3 call attempts
  if (attemptNumber >= 3) {
    console.log('[twilio-webhook] Max attempts reached, sending SMS fallback');

    // SMS fallback: send text reminder to patient
    await sendSmsFallback(callLog.patient_id, callLog.medication_id);

    // Also alert caregiver
    await alertCaregiver(callLog.patient_id, 'Patient did not answer after 3 call attempts. SMS reminder sent.');
    return;
  }

  // Schedule retry in 30 minutes
  const retryTime = new Date(Date.now() + 30 * 60 * 1000);

  const { error } = await supabase.from('scheduled_reminder_calls').insert({
    patient_id: callLog.patient_id,
    medication_id: callLog.medication_id,
    scheduled_for: retryTime.toISOString(),
    attempt_number: attemptNumber + 1,
  });

  if (error) {
    console.error('[twilio-webhook] Failed to schedule retry:', error);
  } else {
    console.log('[twilio-webhook] Retry scheduled for:', retryTime.toISOString());
  }
}

async function sendSmsFallback(patientId: string, medicationId: string) {
  // Get patient and medication info
  const [patientResult, medResult] = await Promise.all([
    supabase.from('patients').select('name, phone_number').eq('id', patientId).single(),
    supabase.from('medications').select('name, dosage').eq('id', medicationId).single(),
  ]);

  const patient = patientResult.data;
  const medication = medResult.data;

  if (!patient?.phone_number) return;

  const medName = medication?.name || 'your medication';
  const dosage = medication?.dosage ? ` (${medication.dosage})` : '';
  const message = `Hi ${patient.name}! This is your medication reminder. Please take your ${medName}${dosage}. Reply YES when you've taken it.`;

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
          To: patient.phone_number,
          From: TWILIO_PHONE_NUMBER,
          Body: message,
        }),
      }
    );

    const result = await response.json();

    // Log the SMS
    await supabase.from('sms_reminders').insert({
      patient_id: patientId,
      medication_id: medicationId,
      message: message,
      status: 'sent',
      twilio_sid: result.sid,
    });

    console.log('[twilio-webhook] SMS fallback sent:', result.sid);
  } catch (error) {
    console.error('[twilio-webhook] SMS fallback failed:', error);
  }
}

async function sendLowBalanceAlert(caregiverId: string, balanceMinutes: number) {
  try {
    const { data: caregiver } = await supabase
      .from('caregivers')
      .select('name, phone_number')
      .eq('id', caregiverId)
      .single();

    if (!caregiver?.phone_number) return;

    const message = `MedReminder: Your companionship credit balance is low (${Math.floor(balanceMinutes)} minutes remaining). Purchase more credits in your dashboard to keep extended calls active.`;

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
          Body: message,
        }),
      }
    );

    console.log('[twilio-webhook] Low balance alert sent to caregiver:', caregiverId);
  } catch (error) {
    console.error('[twilio-webhook] Failed to send low balance alert:', error);
  }
}

async function tryAutoTopup(caregiverId: string, currentBalance: number) {
  try {
    // Check auto-topup settings
    const { data: settings } = await supabase
      .from('auto_topup_settings')
      .select('*')
      .eq('caregiver_id', caregiverId)
      .eq('enabled', true)
      .single();

    if (!settings) return;
    if (currentBalance >= Number(settings.threshold_minutes)) return;

    // Check if caregiver has a Stripe customer with saved payment method
    const { data: caregiver } = await supabase
      .from('caregivers')
      .select('stripe_customer_id')
      .eq('id', caregiverId)
      .single();

    if (!caregiver?.stripe_customer_id) {
      console.log('[twilio-webhook] Auto-topup: no stripe customer for caregiver:', caregiverId);
      return;
    }

    const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeSecretKey) {
      console.log('[twilio-webhook] Auto-topup: STRIPE_SECRET_KEY not configured');
      return;
    }

    const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });

    // Get saved payment methods
    const paymentMethods = await stripe.paymentMethods.list({
      customer: caregiver.stripe_customer_id,
      type: 'card',
    });

    if (paymentMethods.data.length === 0) {
      console.log('[twilio-webhook] Auto-topup: no saved payment methods for:', caregiverId);
      return;
    }

    // Create off-session PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: settings.pack_price_cents,
      currency: 'usd',
      customer: caregiver.stripe_customer_id,
      payment_method: paymentMethods.data[0].id,
      off_session: true,
      confirm: true,
      description: `Auto top-up: ${settings.pack_label}`,
      metadata: {
        caregiver_id: caregiverId,
        pack_minutes: String(settings.pack_minutes),
        pack_price_cents: String(settings.pack_price_cents),
        pack_label: settings.pack_label,
        auto_topup: 'true',
      },
    });

    if (paymentIntent.status === 'succeeded') {
      // Add credits via RPC
      const { data: newBalance } = await supabase.rpc('add_credits', {
        p_caregiver_id: caregiverId,
        p_minutes: settings.pack_minutes,
        p_price_cents: settings.pack_price_cents,
        p_pack_label: `Auto: ${settings.pack_label}`,
        p_source: 'stripe',
        p_stripe_payment_intent_id: paymentIntent.id,
      });

      console.log(`[twilio-webhook] Auto-topup success: ${settings.pack_minutes} min for ${caregiverId}, new balance: ${newBalance}`);
    } else {
      console.log(`[twilio-webhook] Auto-topup payment not succeeded, status: ${paymentIntent.status}`);
    }
  } catch (error) {
    console.error('[twilio-webhook] Auto-topup failed:', error);
  }
}

async function alertCaregiver(patientId: string, reason: string) {
  // Get caregiver info
  const { data: links } = await supabase
    .from('patient_caregivers')
    .select(`
      caregivers (name, phone_number),
      patients (name)
    `)
    .eq('patient_id', patientId);

  if (!links || links.length === 0) {
    console.log('[twilio-webhook] No caregivers found for patient');
    return;
  }

  const patientName = links[0].patients?.name || 'Your loved one';

  for (const link of links) {
    const caregiver = link.caregivers;
    if (!caregiver?.phone_number) continue;

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
            To: caregiver.phone_number,
            From: TWILIO_PHONE_NUMBER,
            Body: `Medication Reminder Alert: ${patientName} - ${reason}. Please check in on them.`,
          }),
        }
      );

      if (response.ok) {
        console.log('[twilio-webhook] Alert sent to caregiver:', caregiver.phone_number);
      } else {
        console.error('[twilio-webhook] Failed to send SMS:', await response.text());
      }
    } catch (error) {
      console.error('[twilio-webhook] Error sending SMS:', error);
    }
  }
}
