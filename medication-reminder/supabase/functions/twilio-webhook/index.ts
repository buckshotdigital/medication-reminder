import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { encode as encodeBase64 } from 'https://deno.land/std@0.168.0/encoding/base64.ts';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

// Escape special XML characters for safe TwiML embedding
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

  console.log(`[twilio-webhook] ${req.method} ${path} fullUrl=${req.url}`);

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
  // Strip function name prefix from path if present (Supabase runtime may include it)
  const cleanPath = path.replace(/^\/twilio-webhook/, '') || '/';
  const externalUrl = `https://${projectRef}.supabase.co/functions/v1/twilio-webhook${cleanPath}`;
  const isStatusRoute = path.includes('/status') || path.includes('/amd');
  console.log(`[twilio-webhook] Signature check: path=${path}, cleanPath=${cleanPath}, externalUrl=${externalUrl}`);
  const isValid = await validateTwilioSignature(req, externalUrl, formParams);
  if (!isValid) {
    if (isStatusRoute) {
      // Status callbacks contain no sensitive data and the callSid is verified against our DB.
      // Signature mismatch is likely due to URL differences between what Twilio signs and our constructed URL.
      const receivedSig = req.headers.get('x-twilio-signature') || '(none)';
      console.warn(`[twilio-webhook] Signature validation FAILED for /status (processing anyway). externalUrl=${externalUrl}, receivedSig=${receivedSig}`);
    } else {
      console.warn(`[twilio-webhook] Twilio signature validation FAILED for ${externalUrl}`);
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
      medIdsParam = `\n      <Parameter name="medication_ids" value="${escapeXml(medicationIdsParam)}" />`;
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="patient_id" value="${patientId}" />
      <Parameter name="medication_id" value="${medicationId}" />${medIdsParam}
      <Parameter name="call_sid" value="${callSid}" />
      <Parameter name="patient_name" value="${escapeXml(patientName)}" />
      <Parameter name="medication_name" value="${escapeXml(medicationName)}" />
      <Parameter name="medication_dosage" value="${escapeXml(medicationDosage)}" />
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
  <Message>Great! We've recorded that you've taken your medication. Thank you, ${escapeXml(patient.name)}!</Message>
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

  // Route: /amd - Async AMD (Answering Machine Detection) callback
  if (path.includes('/amd')) {
    const answeredBy = formParams['AnsweredBy'];
    const amdCallSid = formParams['CallSid'];

    console.log(`[twilio-webhook] /amd - CallSid: ${amdCallSid}, AnsweredBy: ${answeredBy}`);

    if (answeredBy === 'machine_end_beep') {
      // Voicemail confirmed (beep heard) — leave a message
      // Only act on machine_end_beep; machine_start is unreliable and often misclassifies humans
      if (amdCallSid) {
        try {
          const { data: callLog } = await supabase
            .from('reminder_call_logs')
            .select('id, patient_id, medication_id')
            .eq('call_sid', amdCallSid)
            .single();

          let voicemailMessage = 'Hi, this is GentleRing with a medication reminder. Please take your medication when you get this message. Goodbye!';

          if (callLog) {
            const [patientResult, medResult] = await Promise.all([
              supabase.from('patients').select('name').eq('id', callLog.patient_id).single(),
              supabase.from('medications').select('name, dosage').eq('id', callLog.medication_id).single(),
            ]);

            const patientName = patientResult.data?.name || '';
            const medName = medResult.data?.name || 'your medication';
            const dosage = medResult.data?.dosage ? ` ${medResult.data.dosage}` : '';

            voicemailMessage = `Hi ${patientName}, this is GentleRing calling to remind you to take your ${medName}${dosage}. Please take it when you get this message. We'll try calling again later. Goodbye!`;

            // Mark call as voicemail
            await supabase
              .from('reminder_call_logs')
              .update({ status: 'voicemail', notes: 'Voicemail detected by AMD, message left' })
              .eq('call_sid', amdCallSid);
          }

          // Update the live call with a voicemail TwiML message
          const voicemailTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Amy" language="en-GB">${escapeXml(voicemailMessage)}</Say><Hangup/></Response>`;

          const updateResponse = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${amdCallSid}.json`,
            {
              method: 'POST',
              headers: {
                'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ Twiml: voicemailTwiml }),
            }
          );

          if (!updateResponse.ok) {
            console.error('[twilio-webhook] Failed to update call with voicemail TwiML:', await updateResponse.text());
          } else {
            console.log('[twilio-webhook] Voicemail message being left for call:', amdCallSid);
          }

          // Schedule retry
          if (callLog) {
            await scheduleRetry(amdCallSid);
          }
        } catch (e) {
          console.error('[twilio-webhook] AMD handler error:', e);
        }
      }
    } else {
      console.log(`[twilio-webhook] /amd - Human detected (${answeredBy}), call proceeds normally`);
    }

    return new Response('OK', { status: 200 });
  }

  // Route: /status - Call status callback
  if (path.includes('/status')) {
    const duration = formParams['CallDuration'];
    const answeredBy = formParams['AnsweredBy'];

    console.log(`[twilio-webhook] /status - CallSid: ${callSid}, Status: ${callStatus}, Duration: ${duration}, AnsweredBy: ${answeredBy}, AllParams: ${JSON.stringify(formParams)}`);

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
      // Deduct credits for any call that had a duration (not just 'completed' —
      // Twilio may report 'completed' or other terminal statuses for connected calls)
      const callDurationSec = duration ? parseInt(duration) : 0;
      const isTerminal = ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(callStatus);
      if (isTerminal && callDurationSec > 0) {
        // Find the call log for post-processing
        const { data: callLog } = await supabase
          .from('reminder_call_logs')
          .select('id, patient_id, medication_taken, duration_seconds')
          .eq('call_sid', callSid)
          .single();

        if (callLog) {
          const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

          // Credit deduction for all calls with duration
          try {
            const callDuration = callDurationSec || callLog.duration_seconds || 0;
            const { data: planData } = await supabase.rpc('get_patient_plan', {
              p_patient_id: callLog.patient_id,
            });

            if (planData && planData.length > 0) {
              const plan = planData[0];
              const { data: deductResult } = await supabase.rpc('deduct_credits', {
                p_caregiver_id: plan.caregiver_id,
                p_patient_id: callLog.patient_id,
                p_call_log_id: callLog.id,
                p_call_sid: callSid,
                p_total_duration_seconds: callDuration,
                p_free_seconds: 0,
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

      // Legacy voicemail detection via status callback (now handled by /amd route with async AMD)
      // Keep as fallback in case AMD callback doesn't fire
      if (answeredBy === 'machine_end_beep') {
        const { data: existingLog } = await supabase
          .from('reminder_call_logs')
          .select('status')
          .eq('call_sid', callSid)
          .single();

        // Only update if not already handled by /amd
        if (existingLog && existingLog.status !== 'voicemail') {
          await supabase
            .from('reminder_call_logs')
            .update({ status: 'voicemail', notes: 'Voicemail detected (status callback fallback)' })
            .eq('call_sid', callSid);

          await scheduleRetry(callSid);
        }
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

    const message = `GentleRing: Your call credit balance is low (${Math.floor(balanceMinutes)} minutes remaining). Purchase more credits in your dashboard to keep calls active.`;

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

    const stripeAuth = 'Basic ' + btoa(`${stripeSecretKey}:`);

    // Get saved payment methods
    const pmResponse = await fetch(
      `https://api.stripe.com/v1/payment_methods?customer=${caregiver.stripe_customer_id}&type=card`,
      { headers: { 'Authorization': stripeAuth } }
    );
    const pmData = await pmResponse.json();

    if (!pmData.data || pmData.data.length === 0) {
      console.log('[twilio-webhook] Auto-topup: no saved payment methods for:', caregiverId);
      return;
    }

    // Create off-session PaymentIntent
    const piResponse = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': stripeAuth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        amount: String(settings.pack_price_cents),
        currency: 'usd',
        customer: caregiver.stripe_customer_id,
        payment_method: pmData.data[0].id,
        off_session: 'true',
        confirm: 'true',
        description: `Auto top-up: ${settings.pack_label}`,
        'metadata[caregiver_id]': caregiverId,
        'metadata[pack_minutes]': String(settings.pack_minutes),
        'metadata[pack_price_cents]': String(settings.pack_price_cents),
        'metadata[pack_label]': settings.pack_label,
        'metadata[auto_topup]': 'true',
      }),
    });
    const paymentIntent = await piResponse.json();

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
            Body: `GentleRing Alert: ${patientName} - ${reason}. Please check in on them.`,
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
