import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const ELEVENLABS_API_KEY = Deno.env.get('ELEVENLABS_API_KEY')!;

// Simple in-memory cache (edge functions are short-lived, so this is per-instance)
let cachedVoices: any[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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

  try {
    // Return cached if fresh
    if (cachedVoices && Date.now() - cacheTime < CACHE_TTL_MS) {
      return new Response(JSON.stringify({ voices: cachedVoices }), {
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
      });
    }

    const response = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[list-voices] ElevenLabs API error:', errorText);
      return new Response(JSON.stringify({ error: 'Failed to fetch voices' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 502,
      });
    }

    const data = await response.json();

    // Filter to only premade/free voices
    const premadeVoices = (data.voices || [])
      .filter((v: any) => v.category === 'premade')
      .map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name,
        preview_url: v.preview_url,
        labels: v.labels || {},
      }));

    // Cache the result
    cachedVoices = premadeVoices;
    cacheTime = Date.now();

    return new Response(JSON.stringify({ voices: premadeVoices }), {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
    });
  } catch (error) {
    console.error('[list-voices] Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
