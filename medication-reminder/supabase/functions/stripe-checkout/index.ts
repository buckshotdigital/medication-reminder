import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno&no-check';

const ALLOWED_PACKS: Record<number, number> = {
  60: 1200,
  150: 2500,
  500: 7000,
};

const PACK_LABELS: Record<number, string> = {
  60: '60 minutes',
  150: '150 minutes',
  500: '500 minutes',
};

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
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const dashboardUrl = Deno.env.get('DASHBOARD_URL') || 'http://localhost:3000';

  if (!stripeSecretKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 500,
    });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
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
      console.error('[stripe-checkout] Auth error:', authError?.message, 'token prefix:', token.substring(0, 20));
      return new Response(JSON.stringify({ error: 'Invalid token: ' + (authError?.message || 'unknown') }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // Get or create caregiver
    let { data: caregiver } = await supabase
      .from('caregivers')
      .select('id, name, email, stripe_customer_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (!caregiver) {
      console.log('[stripe-checkout] Auto-creating caregiver for:', user.id, user.email);
      const { data: newCg, error: insertErr } = await supabase
        .from('caregivers')
        .insert({
          name: user.email?.split('@')[0] || 'Caregiver',
          email: user.email,
          phone_number: '',
          auth_user_id: user.id,
        })
        .select('id, name, email, stripe_customer_id')
        .single();

      if (insertErr || !newCg) {
        console.error('[stripe-checkout] Caregiver insert error:', insertErr);
        return new Response(JSON.stringify({ error: 'Could not create caregiver: ' + (insertErr?.message || 'unknown') }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
          status: 500,
        });
      }
      caregiver = newCg;
    }

    // Parse and validate request
    const { pack_minutes } = await req.json();
    const priceCents = ALLOWED_PACKS[pack_minutes];
    if (!priceCents) {
      return new Response(JSON.stringify({ error: 'Invalid credit pack' }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 400,
      });
    }

    // Create or reuse Stripe Customer
    let customerId = caregiver.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: caregiver.email || user.email,
        name: caregiver.name,
        metadata: { caregiver_id: caregiver.id },
      });
      customerId = customer.id;

      await supabase
        .from('caregivers')
        .update({ stripe_customer_id: customerId })
        .eq('id', caregiver.id);
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `MedReminder Credits — ${PACK_LABELS[pack_minutes]}`,
            description: `${pack_minutes} minutes of call credits`,
          },
          unit_amount: priceCents,
        },
        quantity: 1,
      }],
      metadata: {
        caregiver_id: caregiver.id,
        pack_minutes: String(pack_minutes),
        pack_price_cents: String(priceCents),
        pack_label: PACK_LABELS[pack_minutes],
      },
      payment_intent_data: {
        setup_future_usage: 'off_session',
      },
      success_url: `${dashboardUrl}/dashboard/credits?success=true`,
      cancel_url: `${dashboardUrl}/dashboard/credits?canceled=true`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[stripe-checkout] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
