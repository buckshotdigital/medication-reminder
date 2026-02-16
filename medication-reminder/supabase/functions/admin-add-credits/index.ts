import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || '';
  const allowed = Deno.env.get('ALLOWED_ORIGIN') || '';
  const allowedOrigins = allowed ? allowed.split(',').map(o => o.trim()) : [];
  const isAllowed = allowedOrigins.includes(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0] || '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Vary': 'Origin',
  };
}

serve(async (req) => {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 405,
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  try {
    // Verify JWT
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      return new Response(JSON.stringify({ error: 'Authentication required' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // Admin authorization check
    const adminEmails = (Deno.env.get('ADMIN_EMAILS') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminEmails.length === 0 || !adminEmails.includes((user.email || '').toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 403,
      });
    }

    // Get or create caregiver
    let { data: caregiver } = await supabase
      .from('caregivers')
      .select('id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (!caregiver) {
      console.log('[admin-add-credits] Auto-creating caregiver for:', user.id, user.email);
      const { data: newCg, error: insertErr } = await supabase
        .from('caregivers')
        .insert({
          name: user.email?.split('@')[0] || 'Caregiver',
          email: user.email,
          phone_number: '',
          auth_user_id: user.id,
        })
        .select('id')
        .single();

      if (insertErr || !newCg) {
        console.error('[admin-add-credits] Caregiver insert error:', insertErr);
        return new Response(JSON.stringify({ error: 'Could not create caregiver: ' + (insertErr?.message || 'unknown') }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
          status: 500,
        });
      }
      caregiver = newCg;
    }

    // Parse and validate
    const { minutes, note } = await req.json();
    if (!minutes || typeof minutes !== 'number' || minutes <= 0 || minutes > 10000) {
      return new Response(JSON.stringify({ error: 'Invalid minutes (must be 1-10000)' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // Add credits via RPC
    const packLabel = note ? `Manual: ${note}` : 'Manual addition';
    const { data: newBalance, error: rpcError } = await supabase.rpc('add_credits', {
      p_caregiver_id: caregiver.id,
      p_minutes: minutes,
      p_price_cents: 0,
      p_pack_label: packLabel,
      p_source: 'manual',
    });

    if (rpcError) {
      console.error('[admin-add-credits] add_credits failed:', rpcError);
      return new Response(JSON.stringify({ error: 'Failed to add credits' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 500,
      });
    }

    return new Response(JSON.stringify({ balance_minutes: newBalance }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[admin-add-credits] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
