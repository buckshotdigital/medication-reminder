'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Pill, Mail, Lock, ArrowLeft, KeyRound } from 'lucide-react';
import { Button } from '@/components/form-field';
import { Input } from '@/components/form-field';

type AuthMode = 'login' | 'signup' | 'magic-link-sent' | 'forgot-password' | 'reset-sent';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [magicLinkLoading, setMagicLinkLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const supabase = createClient();

  // Read error from URL query params (e.g. from auth callback failure)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'auth') {
      setError('Authentication failed. Please try again.');
    }
  }, []);

  const anyLoading = passwordLoading || magicLinkLoading || resetLoading;

  async function handlePasswordAuth(e: React.FormEvent) {
    e.preventDefault();
    if (anyLoading) return;
    setPasswordLoading(true);
    setError('');
    setSuccessMessage('');

    if (authMode === 'signup') {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });

      if (signUpError) {
        setError(signUpError.message);
        setPasswordLoading(false);
        return;
      }

      // If session is returned, user was auto-confirmed — redirect immediately
      if (signUpData.session) {
        window.location.href = '/dashboard';
        return;
      }

      // If no session, email confirmation is required
      // Check if identities is empty — means email already registered
      if (signUpData.user?.identities?.length === 0) {
        setError('An account with this email already exists. Try signing in instead.');
        setPasswordLoading(false);
        return;
      }

      // Email confirmation required — try auto sign-in
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        // Confirmation required
        setSuccessMessage('Account created! Check your email to confirm, then sign in.');
        setAuthMode('login');
        setPassword('');
        setPasswordLoading(false);
        return;
      }

      window.location.href = '/dashboard';
      return;
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        setError(signInError.message);
        setPasswordLoading(false);
        return;
      }

      window.location.href = '/dashboard';
      return;
    }
  }

  async function handleMagicLink() {
    if (anyLoading || !email.trim()) return;

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setMagicLinkLoading(true);
    setError('');
    setSuccessMessage('');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setMagicLinkLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setAuthMode('magic-link-sent');
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    if (anyLoading || !email.trim()) return;

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setResetLoading(true);
    setError('');

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/dashboard/settings`,
    });

    setResetLoading(false);

    if (error) {
      setError(error.message);
    } else {
      setAuthMode('reset-sent');
    }
  }

  function switchMode(mode: AuthMode) {
    setAuthMode(mode);
    setError('');
    setSuccessMessage('');
    setPassword('');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-primary/10 px-4">
      <div className="w-full max-w-sm animate-slide-up">
        <div className="bg-card rounded-2xl shadow-soft-lg p-8">
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
              <Pill className="w-6 h-6 text-primary" />
            </div>
            <h1 className="text-2xl font-bold text-foreground">
              MedReminder
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {authMode === 'signup'
                ? 'Start free — 15 minutes of calls included'
                : 'Caregiver Dashboard'}
            </p>
          </div>

          {authMode === 'magic-link-sent' ? (
            <div className="text-center animate-fade-in">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Mail className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-lg font-semibold">Check your email</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                We sent a magic link to <strong>{email}</strong>.
                Click the link to sign in.
              </p>
              <button
                onClick={() => switchMode('login')}
                className="mt-4 text-primary text-sm hover:underline inline-flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                Back to login
              </button>
            </div>
          ) : authMode === 'reset-sent' ? (
            <div className="text-center animate-fade-in">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <KeyRound className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-lg font-semibold">Reset link sent</h2>
              <p className="text-muted-foreground mt-2 text-sm">
                We sent a password reset link to <strong>{email}</strong>.
                Check your inbox and follow the instructions.
              </p>
              <button
                onClick={() => switchMode('login')}
                className="mt-4 text-primary text-sm hover:underline inline-flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" />
                Back to login
              </button>
            </div>
          ) : authMode === 'forgot-password' ? (
            <form onSubmit={handleForgotPassword} className="space-y-4 animate-fade-in">
              <div className="text-center mb-2">
                <h2 className="text-lg font-semibold">Forgot password?</h2>
                <p className="text-muted-foreground text-sm mt-1">
                  Enter your email and we&apos;ll send you a reset link.
                </p>
              </div>

              <div>
                <label htmlFor="email" className="block text-sm font-medium mb-1.5">
                  Email address
                </label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>

              {error && (
                <p className="text-destructive text-sm">{error}</p>
              )}

              <Button
                type="submit"
                loading={resetLoading}
                disabled={anyLoading}
                className="w-full"
              >
                <KeyRound className="w-4 h-4" />
                Send Reset Link
              </Button>

              <p className="text-center">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className="text-primary text-sm hover:underline inline-flex items-center gap-1"
                >
                  <ArrowLeft className="w-3 h-3" />
                  Back to login
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handlePasswordAuth} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium mb-1.5">
                  Email address
                </label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium mb-1.5">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  minLength={6}
                />
                {authMode === 'login' && (
                  <button
                    type="button"
                    onClick={() => switchMode('forgot-password')}
                    className="text-primary text-xs hover:underline mt-1.5"
                  >
                    Forgot password?
                  </button>
                )}
              </div>

              {error && (
                <p className="text-destructive text-sm">{error}</p>
              )}

              {successMessage && (
                <p className="text-emerald-600 dark:text-emerald-400 text-sm">{successMessage}</p>
              )}

              <Button
                type="submit"
                loading={passwordLoading}
                disabled={anyLoading}
                className="w-full"
              >
                <Lock className="w-4 h-4" />
                {authMode === 'signup' ? 'Start Free Trial' : 'Sign In'}
              </Button>

              <div className="relative my-2">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-border/60" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-card px-2 text-muted-foreground">or</span>
                </div>
              </div>

              <Button
                type="button"
                variant="secondary"
                onClick={handleMagicLink}
                loading={magicLinkLoading}
                disabled={anyLoading || !email.trim()}
                className="w-full"
              >
                <Mail className="w-4 h-4" />
                Send Magic Link
              </Button>

              <p className="text-center text-sm text-muted-foreground">
                {authMode === 'login' ? (
                  <>
                    Don&apos;t have an account?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('signup')}
                      className="text-primary hover:underline font-medium"
                    >
                      Sign up
                    </button>
                  </>
                ) : (
                  <>
                    Already have an account?{' '}
                    <button
                      type="button"
                      onClick={() => switchMode('login')}
                      className="text-primary hover:underline font-medium"
                    >
                      Sign in
                    </button>
                  </>
                )}
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
