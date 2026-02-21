'use client';

import { useState } from 'react';
import { createPatient } from '@/lib/queries';
import { FormField, Input, Select, Button } from '@/components/form-field';
import { useToast } from '@/components/toast';

interface PatientFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

const dayOptions = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

export function PatientForm({ onSuccess, onCancel }: PatientFormProps) {
  const [loading, setLoading] = useState(false);
  const [reminderDays, setReminderDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 7]);
  const { toast } = useToast();

  function toggleReminderDay(day: number) {
    setReminderDays(prev => {
      const next = prev.includes(day)
        ? prev.filter(d => d !== day)
        : [...prev, day].sort();
      return next.length > 0 ? next : prev;
    });
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    const form = new FormData(e.currentTarget);

    try {
      await createPatient({
        patient_name: form.get('patient_name') as string,
        patient_phone: form.get('patient_phone') as string,
        medication_name: form.get('medication_name') as string,
        medication_dosage: form.get('medication_dosage') as string || undefined,
        medication_description: form.get('medication_description') as string || undefined,
        reminder_time: form.get('reminder_time') as string,
        reminder_days: reminderDays,
        timezone: form.get('timezone') as string || 'America/Toronto',
      });
      toast('Patient created successfully', 'success');
      onSuccess();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField label="Patient Name" required>
          <Input
            name="patient_name"
            required
            placeholder="e.g. Margaret Smith"
          />
        </FormField>
        <FormField label="Phone Number" required>
          <Input
            name="patient_phone"
            required
            type="tel"
            placeholder="+1234567890"
          />
        </FormField>
        <FormField label="Medication Name" required>
          <Input
            name="medication_name"
            required
            placeholder="e.g. Lisinopril"
          />
        </FormField>
        <FormField label="Dosage">
          <Input
            name="medication_dosage"
            placeholder="e.g. 10mg"
          />
        </FormField>
        <FormField label="Description">
          <Input
            name="medication_description"
            placeholder="e.g. small white pill for blood pressure"
          />
        </FormField>
        <FormField label="Reminder Time" required>
          <Input
            name="reminder_time"
            required
            type="time"
            defaultValue="09:00"
          />
        </FormField>
        <FormField label="Timezone">
          <Select name="timezone" defaultValue="America/Toronto">
            <option value="America/Toronto">Eastern (Toronto)</option>
            <option value="America/New_York">Eastern (New York)</option>
            <option value="America/Chicago">Central (Chicago)</option>
            <option value="America/Denver">Mountain (Denver)</option>
            <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
            <option value="America/Vancouver">Pacific (Vancouver)</option>
            <option value="Europe/London">GMT (London)</option>
          </Select>
        </FormField>
      </div>

      <FormField label="Reminder Days" helper="Select the days this medication should be reminded">
        <div className="flex flex-wrap gap-2">
          {dayOptions.map(day => (
            <button
              key={day.value}
              type="button"
              onClick={() => toggleReminderDay(day.value)}
              className={
                reminderDays.includes(day.value)
                  ? 'px-3 py-1.5 rounded-full text-xs font-medium bg-primary text-primary-foreground'
                  : 'px-3 py-1.5 rounded-full text-xs font-medium bg-muted text-muted-foreground hover:bg-muted/80'
              }
            >
              {day.label}
            </button>
          ))}
        </div>
      </FormField>

      <div className="flex gap-3">
        <Button type="submit" loading={loading}>
          Create Patient
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
