'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { FormField, Input, Button } from '@/components/form-field';
import { ToggleSwitch } from '@/components/toggle-switch';
import { useToast } from '@/components/toast';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';

export default function SettingsPage() {
  const supabase = createClient();
  const router = useRouter();
  const { toast } = useToast();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [smsAlerts, setSmsAlerts] = useState(true);
  const [escalationCalls, setEscalationCalls] = useState(true);
  const [firstSmsAfterMisses, setFirstSmsAfterMisses] = useState(1);
  const [allSmsAfterMisses, setAllSmsAfterMisses] = useState(2);
  const [callAfterMisses, setCallAfterMisses] = useState(3);

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      setUserEmail(user.email || '');

      const { data } = await supabase
        .from('caregivers')
        .select('*')
        .eq('auth_user_id', user.id)
        .single();

      if (data) {
        setProfile(data);
        const prefs = data.notification_prefs || {};
        setSmsAlerts(prefs.sms_alerts !== false);
        setEscalationCalls(prefs.escalation_calls !== false);
        setFirstSmsAfterMisses(Number(prefs.first_sms_after_misses || 1));
        setAllSmsAfterMisses(Number(prefs.all_sms_after_misses || 2));
        setCallAfterMisses(Number(prefs.call_after_misses || 3));
      }
      setLoading(false);
    }
    loadProfile();
  }, []);

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!profile) return;

    setSaving(true);

    const form = new FormData(e.currentTarget);

    const first = Math.max(1, Math.min(7, Number(firstSmsAfterMisses || 1)));
    const all = Math.max(first, Math.min(10, Number(allSmsAfterMisses || 2)));
    const call = Math.max(all, Math.min(14, Number(callAfterMisses || 3)));

    const { error } = await supabase
      .from('caregivers')
      .update({
        name: form.get('name') as string,
        phone_number: form.get('phone_number') as string,
        email: form.get('email') as string,
        notification_prefs: {
          sms_alerts: smsAlerts,
          escalation_calls: escalationCalls,
          first_sms_after_misses: first,
          all_sms_after_misses: all,
          call_after_misses: call,
        },
      })
      .eq('id', profile.id);

    setSaving(false);

    if (error) {
      toast(`Error: ${error.message}`, 'error');
    } else {
      toast('Profile updated successfully', 'success');
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/login');
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-32 rounded-2xl animate-pulse bg-muted/60" />
        <div className="h-64 rounded-2xl animate-pulse bg-muted/60" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Caregiver Profile */}
      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
        <h2 className="font-semibold mb-4">Caregiver Profile</h2>

        {profile ? (
          <form onSubmit={handleSave} className="space-y-4 max-w-md">
            <FormField label="Name" required>
              <Input
                name="name"
                defaultValue={profile.name}
              />
            </FormField>
            <FormField label="Email" required>
              <Input
                name="email"
                type="email"
                defaultValue={profile.email}
              />
            </FormField>
            <FormField label="Phone Number" helper="Used for receiving escalation alerts via SMS">
              <Input
                name="phone_number"
                type="tel"
                defaultValue={profile.phone_number}
                placeholder="+1234567890"
              />
            </FormField>

            <Button type="submit" loading={saving}>
              Save Changes
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground">Profile not found. Please sign out and sign in again.</p>
        )}
      </div>

      {/* Notification Preferences */}
      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
        <h2 className="font-semibold mb-2">Notification Preferences</h2>
        <div className="max-w-md divide-y divide-border/50">
          <ToggleSwitch
            checked={smsAlerts}
            onChange={setSmsAlerts}
            label="SMS Alerts"
            description="Receive text messages when a patient misses medication"
          />
          <ToggleSwitch
            checked={escalationCalls}
            onChange={setEscalationCalls}
            label="Escalation Calls"
            description="Receive phone calls for critical escalation events"
          />
          <div className="pt-4 space-y-3">
            <p className="text-sm font-medium">Escalation Rules</p>
            <FormField label="Primary caregiver SMS after consecutive misses">
              <Input
                type="number"
                min="1"
                max="7"
                value={firstSmsAfterMisses}
                onChange={e => setFirstSmsAfterMisses(Number(e.target.value || 1))}
              />
            </FormField>
            <FormField label="All caregiver SMS after consecutive misses">
              <Input
                type="number"
                min={String(firstSmsAfterMisses)}
                max="10"
                value={allSmsAfterMisses}
                onChange={e => setAllSmsAfterMisses(Number(e.target.value || 2))}
              />
            </FormField>
            <FormField label="Escalation call after consecutive misses">
              <Input
                type="number"
                min={String(allSmsAfterMisses)}
                max="14"
                value={callAfterMisses}
                onChange={e => setCallAfterMisses(Number(e.target.value || 3))}
              />
            </FormField>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Changes are saved when you click &quot;Save Changes&quot; above.
        </p>
      </div>

      {/* Account section */}
      <div className="rounded-2xl shadow-soft bg-white dark:bg-card p-6">
        <h2 className="font-semibold mb-4">Account</h2>
        <div className="flex items-center justify-between max-w-md">
          <div>
            <p className="text-sm font-medium">{userEmail}</p>
            <p className="text-xs text-muted-foreground">Logged in via magic link</p>
          </div>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut className="w-4 h-4" />
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
