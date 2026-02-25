import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY')!;
const ELEVENLABS_AGENT_ID = Deno.env.get('ELEVENLABS_AGENT_ID')!;

serve(async (req) => {
  // Only upgrade WebSocket requests; return 200 for health checks
  const upgradeHeader = req.headers.get('upgrade') || '';
  if (upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('OK', { status: 200 });
  }

  const { socket: twilioWs, response } = Deno.upgradeWebSocket(req);

  let elevenLabsWs: WebSocket | null = null;
  let streamSid: string | null = null;
  let patientId: string | null = null;
  let medicationId: string | null = null;
  let medicationIds: string[] = [];
  let callSid: string | null = null;
  let patientInfo: any = null;
  let medicationInfo: any = null;
  let allMedications: any[] = [];
  let conversationTranscript: string[] = [];
  let debugMessages: string[] = [];
  let elevenLabsReady = false;
  let audioChunkCount = 0;
  let audioReceivedCount = 0;
  let callStartTime: number | null = null;
  let pendingHangup = false;
  let hangupTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAudioTime = 0;
  let audioDrainTimer: ReturnType<typeof setTimeout> | null = null;

  // Debug helper: logs to console and stores for DB write
  function debug(msg: string) {
    const timestamp = new Date().toISOString().split('T')[1];
    const entry = `[${timestamp}] ${msg}`;
    console.log('[twilio-media]', msg);
    debugMessages.push(entry);
  }

  // Write debug log to the call log notes field
  async function flushDebugLog() {
    if (!callSid || debugMessages.length === 0) return;
    try {
      await supabase
        .from('reminder_call_logs')
        .update({ notes: debugMessages.join('\n') })
        .eq('call_sid', callSid);
    } catch (e) {
      console.error('[twilio-media] Failed to flush debug log:', e);
    }
  }

  // Terminate the call via Twilio API
  async function terminateCall() {
    if (!callSid) return;
    try {
      const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
      const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
      await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ Status: 'completed' }),
        }
      );
      debug('Call terminated via Twilio API');
    } catch (e) {
      debug(`Failed to terminate call: ${e.message}`);
    }
  }

  twilioWs.onopen = () => {
    debug('Twilio WebSocket connected');
  };

  twilioWs.onmessage = async (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.event) {
        case 'connected':
          debug('Twilio media stream connected');
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          const customParams = msg.start.customParameters || {};
          patientId = customParams.patient_id;
          medicationId = customParams.medication_id;
          callSid = customParams.call_sid || msg.start.callSid || null;

          // Use pre-passed names from webhook (avoids DB round-trip)
          const passedPatientName = customParams.patient_name || '';
          const passedMedName = customParams.medication_name || '';
          const passedMedDosage = customParams.medication_dosage || '';

          // Parse multi-medication IDs if provided
          if (customParams.medication_ids) {
            try {
              medicationIds = JSON.parse(customParams.medication_ids);
            } catch {
              medicationIds = medicationId ? [medicationId] : [];
            }
          } else {
            medicationIds = medicationId ? [medicationId] : [];
          }

          debug(`Stream started: streamSid=${streamSid}, patient=${patientId} (${passedPatientName}), med=${passedMedName}, call=${callSid}`);

          // Use passed names if available, skip DB queries for speed
          if (passedPatientName) {
            patientInfo = { name: passedPatientName };
            medicationInfo = { name: passedMedName, dosage: passedMedDosage };
            allMedications = [medicationInfo];
            debug(`Using pre-passed names: ${passedPatientName}, ${passedMedName}`);
            // Still need to fetch preferred_voice_id from DB (lightweight query)
            if (patientId) {
              const { data: voiceData } = await supabase
                .from('patients')
                .select('preferred_voice_id')
                .eq('id', patientId)
                .single();
              if (voiceData?.preferred_voice_id) {
                patientInfo.preferred_voice_id = voiceData.preferred_voice_id;
                debug(`Voice override: ${voiceData.preferred_voice_id}`);
              }
            }
          } else if (patientId) {
            // Fallback: fetch from DB if names weren't passed
            const [patientResult, ...medResults] = await Promise.all([
              supabase.from('patients').select('*').eq('id', patientId).single(),
              ...medicationIds.map(id =>
                supabase.from('medications').select('*').eq('id', id).single()
              ),
            ]);
            patientInfo = patientResult.data;
            allMedications = medResults.filter(r => r.data).map(r => r.data);
            medicationInfo = allMedications[0] || null;
            debug(`Fetched from DB: ${patientInfo?.name || 'NOT FOUND'}, ${allMedications.map(m => m.name).join(', ') || 'NONE'}`);
            if (patientInfo?.preferred_voice_id) {
              debug(`Voice override: ${patientInfo.preferred_voice_id}`);
            }
          }

          // Mark call start time for duration tracking
          callStartTime = Date.now();

          // Connect to ElevenLabs immediately — no more DB queries in the way
          await connectToElevenLabs();
          await flushDebugLog();
          break;

        case 'media':
          // Only forward audio after ElevenLabs conversation is initialized
          if (elevenLabsReady && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            audioChunkCount++;
            try {
              elevenLabsWs.send(JSON.stringify({
                user_audio_chunk: msg.media.payload,
              }));
            } catch (e) {
              debug(`Error sending audio chunk #${audioChunkCount}: ${e.message}`);
            }
            if (audioChunkCount === 1) {
              debug('First audio chunk forwarded to ElevenLabs');
            }
          }
          break;

        case 'stop':
          debug('Stream stopped');
          await saveTranscript();
          await updateCallDuration();
          await flushDebugLog();
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          break;

        default:
          debug(`Unknown Twilio event: ${msg.event}`);
      }
    } catch (error) {
      debug(`Error processing Twilio message: ${error.message}`);
      await flushDebugLog();
    }
  };

  twilioWs.onclose = async () => {
    debug('Twilio WebSocket closed');
    // Fallback: save transcript if 'stop' event was missed
    await saveTranscript();
    await flushDebugLog();
    if (elevenLabsWs) {
      elevenLabsWs.close();
    }
  };

  twilioWs.onerror = (error) => {
    debug(`Twilio WebSocket error: ${error}`);
    flushDebugLog();
  };

  async function connectToElevenLabs() {
    debug('Connecting to ElevenLabs (optimized path)...');

    // Build medication name/dosage strings from pre-passed data (no DB queries)
    let medicationName = 'your medication';
    let medicationDosage = '';
    if (allMedications.length > 1) {
      medicationName = allMedications.map(m => m.name).join(' and ');
      medicationDosage = allMedications.map(m => `${m.name} ${m.dosage || ''}`).join(', ');
    } else if (medicationInfo) {
      medicationName = medicationInfo.name;
      medicationDosage = medicationInfo.dosage || '';
    }

    // Build init message immediately — no DB fetches, no conversation history on critical path
    const initMessage: Record<string, any> = {
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        patient_name: patientInfo?.name || 'there',
        medication_name: medicationName,
        medication_dosage: medicationDosage,
        conversation_history: '',
      },
    };

    // Override TTS voice if patient has a preferred voice set
    // Requires "Allow TTS Override" enabled in ElevenLabs agent security settings
    if (patientInfo?.preferred_voice_id) {
      initMessage.conversation_config_override = {
        tts: { voice_id: patientInfo.preferred_voice_id },
      };
      debug(`TTS voice override: ${patientInfo.preferred_voice_id}`);
    }

    debug(`Init ready: patient=${patientInfo?.name}, med=${medicationName}`);

    // Note: WebSocket standard API does not support custom headers, so API key must be
    // passed as a query parameter. This is the ElevenLabs-recommended approach for server-side.
    // The URL is never logged to prevent key exposure.
    const wsUrl = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${ELEVENLABS_AGENT_ID}&output_format=ulaw_8000&xi-api-key=${ELEVENLABS_API_KEY}`;
    debug('Connecting ElevenLabs WS...');

    try {
      elevenLabsWs = new WebSocket(wsUrl);
    } catch (error) {
      debug(`Failed to create ElevenLabs WebSocket: ${error.message}`);
      await flushDebugLog();
      return;
    }

    elevenLabsWs.onopen = () => {
      debug('ElevenLabs WebSocket connected!');

      // Send init IMMEDIATELY — no async work before this
      elevenLabsWs!.send(JSON.stringify(initMessage));
      debug(`Sent init with dynamic variables: patient=${patientInfo?.name}, med=${medicationName}`);
    };

    elevenLabsWs.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Log every event type for debugging (skip audio to avoid spam)
        if (msg.type !== 'audio' && msg.type !== 'ping') {
          debug(`EL event: ${msg.type}`);
        }

        switch (msg.type) {
          case 'audio':
            // Forward audio from ElevenLabs to Twilio
            audioReceivedCount++;
            if (audioReceivedCount === 1) {
              debug(`First audio received from ElevenLabs. Keys: ${Object.keys(msg).join(', ')}. Audio keys: ${msg.audio ? Object.keys(msg.audio).join(', ') : 'N/A'}. Audio_event keys: ${msg.audio_event ? Object.keys(msg.audio_event).join(', ') : 'N/A'}`);
            }
            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
              const audioPayload = msg.audio?.chunk || msg.audio_event?.audio_base_64;
              if (audioPayload) {
                twilioWs.send(JSON.stringify({
                  event: 'media',
                  streamSid: streamSid,
                  media: {
                    payload: audioPayload,
                  },
                }));
                // Track last audio time for hangup drain detection
                if (pendingHangup) {
                  lastAudioTime = Date.now();
                  // Reset drain timer on each audio chunk — when audio stops for 2s, hang up
                  if (audioDrainTimer) clearTimeout(audioDrainTimer);
                  audioDrainTimer = setTimeout(async () => {
                    debug('Goodbye audio finished (no new audio for 2s), hanging up');
                    if (hangupTimer) clearTimeout(hangupTimer);
                    await terminateCall();
                  }, 2000);
                }
              } else {
                debug(`Audio event #${audioReceivedCount} no payload. Keys: ${Object.keys(msg).join(', ')}. Audio keys: ${msg.audio ? Object.keys(msg.audio).join(', ') : 'N/A'}. Audio_event keys: ${msg.audio_event ? Object.keys(msg.audio_event).join(', ') : 'N/A'}`);
              }
            }
            break;

          case 'agent_response':
            const agentText = msg.agent_response_event?.agent_response || msg.agent_response;
            if (agentText) {
              conversationTranscript.push(`Assistant: ${agentText}`);
              debug(`Agent: ${agentText}`);
            }
            break;

          case 'user_transcript':
            const userText = msg.user_transcription_event?.user_transcript || msg.user_transcript;
            if (userText) {
              conversationTranscript.push(`Patient: ${userText}`);
              debug(`Patient: ${userText}`);
            }
            break;

          case 'client_tool_call':
            handleToolCall(msg);
            break;

          case 'conversation_initiation_metadata':
            elevenLabsReady = true;
            debug(`Conversation initialized and ready. Metadata keys: ${Object.keys(msg).join(', ')}`);
            await flushDebugLog();
            break;

          case 'ping':
            if (msg.ping_event?.event_id) {
              elevenLabsWs!.send(JSON.stringify({
                type: 'pong',
                event_id: msg.ping_event.event_id,
              }));
            }
            break;

          case 'interruption':
            // Clear Twilio's audio queue when agent is interrupted
            if (twilioWs.readyState === WebSocket.OPEN && streamSid) {
              twilioWs.send(JSON.stringify({
                event: 'clear',
                streamSid: streamSid,
              }));
            }
            break;

          default:
            debug(`ElevenLabs event: ${msg.type} (keys: ${Object.keys(msg).join(', ')})`);
        }
      } catch (error) {
        debug(`Error processing ElevenLabs message: ${error.message}`);
      }
    };

    elevenLabsWs.onclose = async (event) => {
      elevenLabsReady = false;
      debug(`ElevenLabs WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'none'}. Audio sent: ${audioChunkCount}, received: ${audioReceivedCount}`);
      await flushDebugLog();
    };

    elevenLabsWs.onerror = async (error: Event) => {
      const errDetail = (error as any).message || (error as any).error || error.type || 'unknown';
      debug(`ElevenLabs WebSocket error: ${errDetail}`);
      await flushDebugLog();
    };
  }

  async function handleToolCall(msg: any) {
    const toolCall = msg.client_tool_call;
    if (!toolCall) return;

    const { tool_name, tool_call_id, parameters } = toolCall;
    debug(`Tool call: ${tool_name} id=${tool_call_id} params=${JSON.stringify(parameters)}`);

    let result: any = { success: true };

    try {
      switch (tool_name) {
        case 'confirm_medication_taken':
          if (callSid) {
            const { error: updateErr } = await supabase
              .from('reminder_call_logs')
              .update({
                medication_taken: true,
              })
              .eq('call_sid', callSid);
            if (updateErr) debug(`ERROR updating medication_taken=true: ${updateErr.message}`);
          } else {
            debug('WARN: callSid is null, cannot update medication_taken=true');
          }
          result = { confirmed: true, message: 'Medication logged as taken' };
          break;

        case 'medication_not_taken':
          if (callSid) {
            const { error: updateErr } = await supabase
              .from('reminder_call_logs')
              .update({
                medication_taken: false,
              })
              .eq('call_sid', callSid);
            if (updateErr) debug(`ERROR updating medication_taken=false: ${updateErr.message}`);
          } else {
            debug('WARN: callSid is null, cannot update medication_taken=false');
          }

          // Always schedule a callback when medication is not taken
          // (agent may or may not send schedule_callback param — don't rely on it)
          if (patientId && medicationId) {
            const callbackMinutes = parameters?.callback_minutes || 30;
            const callbackTime = new Date(Date.now() + callbackMinutes * 60 * 1000);

            const { error: insertErr } = await supabase.from('scheduled_reminder_calls').insert({
              patient_id: patientId,
              medication_id: medicationId,
              scheduled_for: callbackTime.toISOString(),
              attempt_number: 1,
            });

            if (insertErr) {
              debug(`ERROR scheduling callback: ${insertErr.message}`);
            } else {
              debug(`Callback scheduled for ${callbackTime.toISOString()}`);
            }

            result = { scheduled_callback: true, callback_time: callbackTime.toISOString() };
          } else {
            result = { acknowledged: true };
          }
          break;

        case 'alert_caregiver':
          await alertCaregiver(parameters?.reason || 'Concern reported', parameters?.urgency || 'medium');
          result = { alerted: true };
          break;

        case 'trigger_emergency':
          debug(`EMERGENCY TRIGGERED: ${parameters?.reason}`);
          await alertCaregiver('EMERGENCY: ' + (parameters?.reason || 'Patient needs help'), 'critical');
          result = { emergency_triggered: true };
          break;

        case 'end_call':
          result = { ending_call: true };
          // Schedule hangup — will be executed after goodbye audio finishes.
          // The ElevenLabs 'agent_response' handler detects end_call was triggered
          // and starts a shorter timer after the last audio chunk is sent.
          // This 12s timeout is a safety net in case that mechanism fails.
          if (callSid) {
            pendingHangup = true;
            hangupTimer = setTimeout(async () => {
              await terminateCall();
            }, 12000);
          }
          break;

        default:
          debug(`Unknown tool: ${tool_name}`);
          result = { error: 'Unknown tool' };
      }
    } catch (error) {
      debug(`Tool error: ${error.message}`);
      result = { error: error.message };
    }

    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
      const isError = !!result.error;
      const response = {
        type: 'client_tool_result',
        tool_call_id: tool_call_id,
        result: JSON.stringify(result),
        is_error: isError,
      };
      debug(`Tool result: ${JSON.stringify(response)}`);
      elevenLabsWs.send(JSON.stringify(response));
    }
  }

  async function alertCaregiver(reason: string, urgency: string) {
    if (!patientId) return;

    const { data: links } = await supabase
      .from('patient_caregivers')
      .select(`
        caregivers (name, phone_number),
        patients (name)
      `)
      .eq('patient_id', patientId);

    if (!links || links.length === 0) return;

    const patientName = links[0].patients?.name || 'Your loved one';
    const prefix = urgency === 'critical' ? 'URGENT: ' : '';

    const TWILIO_ACCOUNT_SID = Deno.env.get('TWILIO_ACCOUNT_SID')!;
    const TWILIO_AUTH_TOKEN = Deno.env.get('TWILIO_AUTH_TOKEN')!;
    const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER')!;

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
              Body: `${prefix}${patientName}: ${reason}`,
            }),
          }
        );
        debug(`Alert sent to: ${caregiver.phone_number}`);
      } catch (error) {
        debug(`Failed to send alert: ${error.message}`);
      }
    }
  }

  async function saveTranscript() {
    if (!callSid || conversationTranscript.length === 0) return;

    await supabase
      .from('reminder_call_logs')
      .update({
        patient_response: conversationTranscript.join('\n'),
      })
      .eq('call_sid', callSid);

    debug('Transcript saved');
  }

  async function updateCallDuration() {
    if (!callSid || !callStartTime) {
      debug('Skip duration update: missing callSid or startTime');
      return;
    }

    try {
      const durationSeconds = Math.ceil((Date.now() - callStartTime) / 1000);
      debug(`Call duration: ${durationSeconds}s`);

      // Update call log with duration (credit deduction handled by twilio-webhook/status callback)
      const { error: updateErr } = await supabase
        .from('reminder_call_logs')
        .update({
          duration_seconds: durationSeconds,
        })
        .eq('call_sid', callSid);

      if (updateErr) {
        debug(`ERROR updating duration: ${updateErr.message}`);
      }
    } catch (error) {
      debug(`Duration update error: ${error.message}`);
    }
  }

  return response;
});
