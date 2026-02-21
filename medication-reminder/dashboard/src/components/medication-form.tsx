'use client';

import { useState } from 'react';
import { addMedication } from '@/lib/queries';
import { FormField, Input, Button } from '@/components/form-field';
import { useToast } from '@/components/toast';
import { cn } from '@/lib/utils';

interface MedicationFormProps {
  patientId: string;
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

export function MedicationForm({ patientId, onSuccess, onCancel }: MedicationFormProps) {
  const [loading, setLoading] = useState(false);
  const [selectedDays, setSelectedDays] = useState([1, 2, 3, 4, 5, 6, 7]);
  const { toast } = useToast();

  function toggleDay(day: number) {
    setSelectedDays(prev => {
      const next = prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort();
      // Prevent deselecting all days
      if (next.length === 0) return prev;
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (selectedDays.length === 0) {
      toast('Please select at least one reminder day', 'error');
      return;
    }
    setLoading(true);

    const form = new FormData(e.currentTarget);

    try {
      await addMedication({
        patient_id: patientId,
        name: form.get('name') as string,
        dosage: form.get('dosage') as string || undefined,
        description: form.get('description') as string || undefined,
        reminder_time: form.get('reminder_time') as string,
        reminder_days: selectedDays,
        refill_remaining_doses: form.get('refill_remaining_doses')
          ? Number(form.get('refill_remaining_doses'))
          : null,
        refill_alert_threshold: form.get('refill_alert_threshold')
          ? Number(form.get('refill_alert_threshold'))
          : null,
        last_refill_date: form.get('last_refill_date')
          ? String(form.get('last_refill_date'))
          : null,
      });
      toast('Medication added successfully', 'success');
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
        <FormField label="Medication Name" required>
          <Input
            name="name"
            required
            placeholder="e.g. Metformin"
          />
        </FormField>
        <FormField label="Dosage">
          <Input
            name="dosage"
            placeholder="e.g. 500mg"
          />
        </FormField>
        <FormField label="Description">
          <Input
            name="description"
            placeholder="e.g. round white pill for diabetes"
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
        <FormField label="Remaining Doses">
          <Input
            name="refill_remaining_doses"
            type="number"
            min="0"
            placeholder="e.g. 30"
          />
        </FormField>
        <FormField label="Refill Alert Threshold">
          <Input
            name="refill_alert_threshold"
            type="number"
            min="0"
            defaultValue="3"
            placeholder="e.g. 3"
          />
        </FormField>
        <FormField label="Last Refill Date">
          <Input
            name="last_refill_date"
            type="date"
          />
        </FormField>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">
          Reminder Days <span className="text-destructive">*</span>
        </label>
        <div className="flex gap-2">
          {dayOptions.map((day) => (
            <button
              key={day.value}
              type="button"
              onClick={() => toggleDay(day.value)}
              className={cn(
                'w-10 h-10 rounded-full text-sm font-medium transition-colors',
                selectedDays.includes(day.value)
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              )}
            >
              {day.label}
            </button>
          ))}
        </div>
        {selectedDays.length === 0 && (
          <p className="text-xs text-destructive mt-1">At least one day is required</p>
        )}
      </div>

      <div className="flex gap-3">
        <Button type="submit" loading={loading}>
          Add Medication
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
