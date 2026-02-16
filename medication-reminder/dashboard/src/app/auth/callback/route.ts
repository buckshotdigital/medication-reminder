import { createServerSupabase } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');

  // Validate redirect target against allowlist to prevent open redirect
  const requestedNext = searchParams.get('next') ?? '/dashboard';
  const allowedPaths = ['/dashboard', '/dashboard/patients', '/dashboard/calls',
    '/dashboard/adherence', '/dashboard/medications/new', '/dashboard/settings',
    '/dashboard/credits'];
  const next = allowedPaths.some(p => requestedNext === p || requestedNext.startsWith('/dashboard/patients/'))
    ? requestedNext
    : '/dashboard';

  if (code) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Check if caregiver record exists, create if not
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: caregiver } = await supabase
          .from('caregivers')
          .select('id')
          .eq('auth_user_id', user.id)
          .single();

        if (!caregiver) {
          const { error: insertError } = await supabase.from('caregivers').upsert(
            {
              name: user.email?.split('@')[0] || 'Caregiver',
              email: user.email,
              phone_number: '',
              auth_user_id: user.id,
            },
            { onConflict: 'auth_user_id' }
          );

          if (insertError) {
            console.error('Failed to create caregiver record:', insertError);
            return NextResponse.redirect(`${origin}/login?error=auth`);
          }
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
