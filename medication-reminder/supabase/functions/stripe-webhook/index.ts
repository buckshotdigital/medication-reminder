import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import Stripe from 'https://esm.sh/stripe@13.10.0?target=deno&no-check';

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripeSecretKey = Deno.env.get('STRIPE_SECRET_KEY');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');

  if (!stripeSecretKey || !webhookSecret) {
    console.error('[stripe-webhook] Missing Stripe configuration');
    return new Response('Stripe not configured', { status: 500 });
  }

  const stripe = new Stripe(stripeSecretKey, { apiVersion: '2023-10-16' });
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Verify Stripe signature
  const body = await req.text();
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    // Use constructEventAsync for Deno compatibility (sync crypto not available)
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  console.log(`[stripe-webhook] Event received: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      // ── Credit Pack Payment ──
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(`[stripe-webhook] checkout.session.completed — mode: ${session.mode}, session: ${session.id}`);
        console.log(`[stripe-webhook] Session metadata:`, JSON.stringify(session.metadata));

        if (session.mode !== 'payment') {
          console.log(`[stripe-webhook] Skipping non-payment mode: ${session.mode}`);
          break;
        }

        const metadata = session.metadata || {};
        const caregiverId = metadata.caregiver_id;
        const packMinutes = Number(metadata.pack_minutes);
        const packPriceCents = Number(metadata.pack_price_cents);
        const packLabel = metadata.pack_label;

        if (!caregiverId || !packMinutes) {
          console.error('[stripe-webhook] Missing metadata on session:', session.id, 'metadata:', JSON.stringify(metadata));
          break;
        }

        // Idempotency check: skip if stripe_session_id already in credit_purchases
        const { data: existing } = await supabase
          .from('credit_purchases')
          .select('id')
          .eq('stripe_session_id', session.id)
          .limit(1);

        if (existing && existing.length > 0) {
          console.log('[stripe-webhook] Duplicate session, skipping:', session.id);
          break;
        }

        // Add credits via RPC
        console.log(`[stripe-webhook] Calling add_credits: caregiver=${caregiverId}, minutes=${packMinutes}, price=${packPriceCents}, label=${packLabel}`);
        const { data: newBalance, error: rpcError } = await supabase.rpc('add_credits', {
          p_caregiver_id: caregiverId,
          p_minutes: packMinutes,
          p_price_cents: packPriceCents,
          p_pack_label: packLabel,
          p_source: 'stripe',
          p_stripe_session_id: session.id,
          p_stripe_payment_intent_id: session.payment_intent as string || null,
        });

        if (rpcError) {
          console.error('[stripe-webhook] add_credits FAILED:', JSON.stringify(rpcError));
        } else {
          console.log(`[stripe-webhook] Credits added successfully: ${packMinutes} min for caregiver ${caregiverId}, new balance: ${newBalance}`);
        }
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    }
  } catch (error) {
    console.error('[stripe-webhook] Processing error:', error);
    return new Response('Processing error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
