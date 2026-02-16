import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno&no-check';

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

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 405,
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');

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
      console.error('[stripe-invoices] Auth error:', authError?.message, 'token prefix:', token.substring(0, 20));
      return new Response(JSON.stringify({ error: 'Invalid token: ' + (authError?.message || 'unknown') }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
        status: 401,
      });
    }

    // Get or create caregiver
    let { data: caregiver } = await supabase
      .from('caregivers')
      .select('id, stripe_customer_id')
      .eq('auth_user_id', user.id)
      .maybeSingle();

    if (!caregiver) {
      console.log('[stripe-invoices] Auto-creating caregiver for:', user.id, user.email);
      const { data: newCg, error: insertErr } = await supabase
        .from('caregivers')
        .insert({
          name: user.email?.split('@')[0] || 'Caregiver',
          email: user.email,
          phone_number: '',
          auth_user_id: user.id,
        })
        .select('id, stripe_customer_id')
        .single();

      if (insertErr || !newCg) {
        console.error('[stripe-invoices] Caregiver insert error:', insertErr);
        return new Response(JSON.stringify({ error: 'Could not create caregiver: ' + (insertErr?.message || 'unknown') }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
          status: 500,
        });
      }
      caregiver = newCg;
    }

    if (!caregiver?.stripe_customer_id) {
      return new Response(JSON.stringify({ invoices: [] }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Fetch invoices and charges in parallel
    const [invoicesResult, chargesResult] = await Promise.all([
      stripe.invoices.list({
        customer: caregiver.stripe_customer_id,
        limit: 20,
      }),
      stripe.charges.list({
        customer: caregiver.stripe_customer_id,
        limit: 20,
      }),
    ]);

    // Build merged list
    const items: any[] = [];

    // Add invoices (subscription payments)
    for (const inv of invoicesResult.data) {
      items.push({
        id: inv.id,
        date: new Date(inv.created * 1000).toISOString(),
        description: inv.lines.data[0]?.description || 'Subscription payment',
        amount_cents: inv.amount_paid,
        status: inv.status,
        type: 'invoice',
        pdf_url: inv.invoice_pdf || null,
      });
    }

    // Add one-time charges (credit packs) that aren't already covered by invoices
    const invoiceChargeIds = new Set(invoicesResult.data.map(i => i.charge).filter(Boolean));
    for (const charge of chargesResult.data) {
      if (invoiceChargeIds.has(charge.id)) continue;
      if (!charge.paid) continue;

      items.push({
        id: charge.id,
        date: new Date(charge.created * 1000).toISOString(),
        description: charge.description || 'Credit pack purchase',
        amount_cents: charge.amount,
        status: charge.refunded ? 'refunded' : 'paid',
        type: 'charge',
        pdf_url: charge.receipt_url || null,
      });
    }

    // Sort by date descending
    items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return new Response(JSON.stringify({ invoices: items }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[stripe-invoices] Error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
