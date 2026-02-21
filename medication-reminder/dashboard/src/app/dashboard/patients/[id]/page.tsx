'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchPatient, fetchCallLogs, updatePatient, updateMedication, deleteMedication, deletePatient, fetchPatientPlans, updatePatientPlan, fetchCreditBalance } from '@/lib/queries';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { CallTranscript } from '@/components/call-transcript';
import { MedicationForm } from '@/components/medication-form';
import { StatusBadge, getCallStatusVariant, getCallStatusLabel } from '@/components/status-badge';
import { Avatar } from '@/components/avatar';
import { EmptyState } from '@/components/empty-state';
import { PatientDetailSkeleton } from '@/components/skeletons';
import { Button, Input, Select } from '@/components/form-field';
import { useToast } from '@/components/toast';
import { formatDate, formatTime, formatDuration } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { useState, useCallback } from 'react';
import { ArrowLeft, Plus, Pencil, Check, X, Pill, Phone, Power, Trash2, Clock, Heart } from 'lucide-react';

const dayLabels = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const dayOptions = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

const TIMEZONE_OPTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Pacific/Auckland',
];

export default function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const [showMedForm, setShowMedForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editTimezone, setEditTimezone] = useState('');
  const [saving, setSaving] = useState(false);

  // Medication editing state
  const [editingMedId, setEditingMedId] = useState<string | null>(null);
  const [editMed, setEditMed] = useState({
    name: '',
    dosage: '',
    description: '',
    reminder_time: '',
    reminder_days: [] as number[],
    refill_remaining_doses: '',
    refill_alert_threshold: '3',
    last_refill_date: '',
  });
  const [savingMed, setSavingMed] = useState(false);
  const [togglingMedId, setTogglingMedId] = useState<string | null>(null);

  const [switchingPlan, setSwitchingPlan] = useState(false);
  const [pendingPlanSwitch, setPendingPlanSwitch] = useState<string | null>(null);

  const { data: patient, isLoading: loadingPatient, refetch: refetchPatient } = useQuery({
    queryKey: ['patient', id],
    queryFn: () => fetchPatient(id),
  });

  const { data: calls, isLoading: loadingCalls } = useQuery({
    queryKey: ['calls', id],
    queryFn: () => fetchCallLogs(id),
  });

  const { data: patientPlans, refetch: refetchPlans } = useQuery({
    queryKey: ['patient-plans'],
    queryFn: fetchPatientPlans,
  });

  const { data: creditBalance } = useQuery({
    queryKey: ['credit-balance'],
    queryFn: fetchCreditBalance,
  });

  const currentPlan = patientPlans?.find((pp: any) => pp.patient_id === id && pp.is_active)?.plan_id || 'basic';

  const handlePlanClick = useCallback((planId: string) => {
    if (planId === currentPlan) return;
    setPendingPlanSwitch(planId);
  }, [currentPlan]);

  const confirmPlanSwitch = useCallback(async () => {
    if (!pendingPlanSwitch) return;
    setSwitchingPlan(true);
    try {
      await updatePatientPlan(id, pendingPlanSwitch);
      await refetchPlans();
      toast(`Switched to ${pendingPlanSwitch === 'companionship' ? 'Companionship' : 'Basic'} plan`, 'success');
    } catch (e) {
      toast('Failed to switch plan: ' + (e as Error).message, 'error');
    } finally {
      setSwitchingPlan(false);
      setPendingPlanSwitch(null);
    }
  }, [id, pendingPlanSwitch, refetchPlans, toast]);

  const startEditMed = useCallback((med: any) => {
    setEditingMedId(med.id);
    setEditMed({
      name: med.name || '',
      dosage: med.dosage || '',
      description: med.description || '',
      reminder_time: med.reminder_time || '09:00',
      reminder_days: med.reminder_days || [1, 2, 3, 4, 5, 6, 7],
      refill_remaining_doses: med.refill_remaining_doses != null ? String(med.refill_remaining_doses) : '',
      refill_alert_threshold: med.refill_alert_threshold != null ? String(med.refill_alert_threshold) : '3',
      last_refill_date: med.last_refill_date || '',
    });
  }, []);

  const toggleMedDay = useCallback((day: number) => {
    setEditMed(prev => {
      const next = prev.reminder_days.includes(day)
        ? prev.reminder_days.filter(d => d !== day)
        : [...prev.reminder_days, day].sort();
      if (next.length === 0) return prev;
      return { ...prev, reminder_days: next };
    });
  }, []);

  const saveMedEdit = useCallback(async () => {
    if (!editingMedId) return;
    if (!editMed.name.trim()) {
      toast('Medication name is required', 'error');
      return;
    }
    if (editMed.reminder_days.length === 0) {
      toast('Select at least one reminder day', 'error');
      return;
    }
    setSavingMed(true);
    try {
      await updateMedication(editingMedId, {
        name: editMed.name.trim(),
        dosage: editMed.dosage.trim() || null,
        description: editMed.description.trim() || null,
        reminder_time: editMed.reminder_time,
        reminder_days: editMed.reminder_days,
        refill_remaining_doses: editMed.refill_remaining_doses === ''
          ? null
          : Number(editMed.refill_remaining_doses),
        refill_alert_threshold: editMed.refill_alert_threshold === ''
          ? null
          : Number(editMed.refill_alert_threshold),
        last_refill_date: editMed.last_refill_date || null,
      });
      await refetchPatient();
      setEditingMedId(null);
      toast('Medication updated', 'success');
    } catch (e) {
      toast('Failed to save: ' + (e as Error).message, 'error');
    } finally {
      setSavingMed(false);
    }
  }, [editingMedId, editMed, refetchPatient, toast]);

  const toggleMedActive = useCallback(async (med: any) => {
    setTogglingMedId(med.id);
    try {
      await updateMedication(med.id, { is_active: !med.is_active });
      await refetchPatient();
      toast(med.is_active ? 'Medication reminder deactivated' : 'Medication reminder activated', 'success');
    } catch (e) {
      toast('Failed to update: ' + (e as Error).message, 'error');
    } finally {
      setTogglingMedId(null);
    }
  }, [refetchPatient, toast]);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingMedId, setDeletingMedId] = useState<string | null>(null);
  const [confirmDeletePatient, setConfirmDeletePatient] = useState(false);
  const [deletingPatient, setDeletingPatient] = useState(false);

  const handleDeleteMed = useCallback(async (medId: string) => {
    setDeletingMedId(medId);
    try {
      await deleteMedication(medId);
      await refetchPatient();
      setConfirmDeleteId(null);
      toast('Medication deleted', 'success');
    } catch (e) {
      toast('Failed to delete: ' + (e as Error).message, 'error');
    } finally {
      setDeletingMedId(null);
    }
  }, [refetchPatient, toast]);

  if (loadingPatient) {
    return <PatientDetailSkeleton />;
  }

  if (!patient) {
    return <p className="text-destructive">Patient not found</p>;
  }

  function validateEditForm(): string | null {
    if (!editName.trim()) return 'Name is required';
    if (!editPhone.trim()) return 'Phone number is required';
    if (!/^\+\d{10,15}$/.test(editPhone.trim())) return 'Phone must be in E.164 format (e.g. +1234567890)';
    if (!editTimezone) return 'Timezone is required';
    return null;
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard/patients" className="text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        {editing ? (
          <div className="flex-1 space-y-3 animate-fade-in">
            <Input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="text-lg font-bold"
              placeholder="Patient name"
              required
            />
            <div className="flex gap-2">
              <Input
                value={editPhone}
                onChange={e => setEditPhone(e.target.value)}
                className="text-sm"
                placeholder="+1234567890"
                type="tel"
              />
              <Select
                value={editTimezone}
                onChange={e => setEditTimezone(e.target.value)}
                className="text-sm w-56"
              >
                <option value="">Select timezone</option>
                {TIMEZONE_OPTIONS.map(tz => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </Select>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                loading={saving}
                onClick={async () => {
                  const validationError = validateEditForm();
                  if (validationError) {
                    toast(validationError, 'error');
                    return;
                  }
                  setSaving(true);
                  try {
                    await updatePatient(id, {
                      name: editName.trim(),
                      phone_number: editPhone.trim(),
                      timezone: editTimezone,
                    });
                    await refetchPatient();
                    setEditing(false);
                    toast('Patient updated successfully', 'success');
                  } catch (e) {
                    toast('Failed to save: ' + (e as Error).message, 'error');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                <Check className="w-4 h-4" /> Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(false)}
              >
                <X className="w-4 h-4" /> Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Avatar name={patient.name} size="lg" />
              <div>
                <h1 className="text-2xl font-bold">{patient.name}</h1>
                <p className="text-muted-foreground">{patient.phone_number} &middot; {patient.timezone}</p>
              </div>
            </div>
            {confirmDeletePatient ? (
              <div className="flex items-center gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  loading={deletingPatient}
                  onClick={async () => {
                    setDeletingPatient(true);
                    try {
                      await deletePatient(id);
                      toast('Patient deleted', 'success');
                      router.push('/dashboard/patients');
                    } catch (e) {
                      toast('Failed to delete: ' + (e as Error).message, 'error');
                      setDeletingPatient(false);
                    }
                  }}
                >
                  Delete Patient
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDeletePatient(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setEditName(patient.name);
                    setEditPhone(patient.phone_number);
                    setEditTimezone(patient.timezone || 'America/Toronto');
                    setEditing(true);
                  }}
                  className="text-muted-foreground hover:text-foreground p-2 rounded-xl hover:bg-muted transition-colors"
                  title="Edit patient details"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setConfirmDeletePatient(true)}
                  className="text-muted-foreground hover:text-destructive p-2 rounded-xl hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                  title="Delete patient"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Subscription Plan */}
      <div>
        <h2 className="font-semibold mb-4">Subscription Plan</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Basic Plan Card */}
          <button
            onClick={() => handlePlanClick('basic')}
            disabled={switchingPlan}
            className={cn(
              'rounded-2xl p-5 text-left transition-all border-2',
              currentPlan === 'basic'
                ? 'border-primary bg-primary/5 shadow-soft-lg'
                : 'border-border bg-white dark:bg-card shadow-soft hover:border-primary/50'
            )}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center',
                currentPlan === 'basic' ? 'bg-primary/10' : 'bg-muted'
              )}>
                <Clock className={cn('w-5 h-5', currentPlan === 'basic' ? 'text-primary' : 'text-muted-foreground')} />
              </div>
              <div>
                <p className="font-semibold">Basic</p>
                <p className="text-sm text-muted-foreground">$49/month</p>
              </div>
              {currentPlan === 'basic' && (
                <span className="ml-auto text-xs font-medium text-primary bg-primary/10 px-2 py-1 rounded-full">Current</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              5-minute medication reminder calls. Enough for reminders plus a brief chat.
            </p>
          </button>

          {/* Companionship Plan Card */}
          <button
            onClick={() => handlePlanClick('companionship')}
            disabled={switchingPlan}
            className={cn(
              'rounded-2xl p-5 text-left transition-all border-2',
              currentPlan === 'companionship'
                ? 'border-primary bg-primary/5 shadow-soft-lg'
                : 'border-border bg-white dark:bg-card shadow-soft hover:border-primary/50'
            )}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={cn(
                'w-10 h-10 rounded-full flex items-center justify-center',
                currentPlan === 'companionship' ? 'bg-primary/10' : 'bg-muted'
              )}>
                <Heart className={cn('w-5 h-5', currentPlan === 'companionship' ? 'text-primary' : 'text-muted-foreground')} />
              </div>
              <div>
                <p className="font-semibold">Companionship</p>
                <p className="text-sm text-muted-foreground">$49/month + credits</p>
              </div>
              {currentPlan === 'companionship' && (
                <span className="ml-auto text-xs font-medium text-primary bg-primary/10 px-2 py-1 rounded-full">Current</span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Up to 30-minute calls with extended companionship conversation. First 3 minutes free per call, then uses credits.
            </p>
          </button>
        </div>

        {/* Plan Switch Confirmation Modal */}
        {pendingPlanSwitch && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPendingPlanSwitch(null)}>
            <div
              className="bg-white dark:bg-card rounded-2xl shadow-lg p-6 max-w-md mx-4 animate-slide-up"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="font-semibold text-lg mb-3">Confirm Plan Change</h3>
              {pendingPlanSwitch === 'companionship' ? (
                <p className="text-sm text-muted-foreground mb-4">
                  This patient&apos;s calls will use credits beyond the first 3 minutes.
                  Your current balance is <span className="font-semibold text-foreground">{Math.floor(Number(creditBalance?.balance_minutes ?? 0))} minutes</span>.
                  Make sure you have enough credits for extended calls.
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mb-4">
                  This patient&apos;s calls will be capped at 5 minutes.
                  Extended companionship conversations will no longer be available for this patient.
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setPendingPlanSwitch(null)}>
                  Cancel
                </Button>
                <Button size="sm" loading={switchingPlan} onClick={confirmPlanSwitch}>
                  Confirm Switch
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Medications */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Medications</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowMedForm(!showMedForm)}>
            <Plus className="w-4 h-4" />
            Add Medication
          </Button>
        </div>

        {showMedForm && (
          <div className="rounded-2xl shadow-soft-lg bg-white dark:bg-card p-5 mb-4 animate-slide-up">
            <MedicationForm
              patientId={id}
              onSuccess={() => {
                setShowMedForm(false);
                refetchPatient();
              }}
              onCancel={() => setShowMedForm(false)}
            />
          </div>
        )}

        <div className="space-y-3">
          {patient.medications?.map((med: any) => (
            <div
              key={med.id}
              className={cn(
                'rounded-2xl shadow-soft bg-white dark:bg-card p-4',
                med.is_active ? 'border-l-4 border-l-emerald-400' : 'border-l-4 border-l-muted'
              )}
            >
              {editingMedId === med.id ? (
                /* ── Inline Edit Mode ── */
                <div className="space-y-4 animate-fade-in">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Name <span className="text-destructive">*</span>
                      </label>
                      <Input
                        value={editMed.name}
                        onChange={e => setEditMed(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="Medication name"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Dosage</label>
                      <Input
                        value={editMed.dosage}
                        onChange={e => setEditMed(prev => ({ ...prev, dosage: e.target.value }))}
                        placeholder="e.g. 500mg"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Description</label>
                      <Input
                        value={editMed.description}
                        onChange={e => setEditMed(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="e.g. round white pill"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Reminder Time <span className="text-destructive">*</span>
                      </label>
                      <Input
                        type="time"
                        value={editMed.reminder_time}
                        onChange={e => setEditMed(prev => ({ ...prev, reminder_time: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Remaining Doses</label>
                      <Input
                        type="number"
                        min="0"
                        value={editMed.refill_remaining_doses}
                        onChange={e => setEditMed(prev => ({ ...prev, refill_remaining_doses: e.target.value }))}
                        placeholder="e.g. 30"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Refill Alert Threshold</label>
                      <Input
                        type="number"
                        min="0"
                        value={editMed.refill_alert_threshold}
                        onChange={e => setEditMed(prev => ({ ...prev, refill_alert_threshold: e.target.value }))}
                        placeholder="e.g. 3"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Last Refill Date</label>
                      <Input
                        type="date"
                        value={editMed.last_refill_date}
                        onChange={e => setEditMed(prev => ({ ...prev, last_refill_date: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">
                      Reminder Days <span className="text-destructive">*</span>
                    </label>
                    <div className="flex gap-2">
                      {dayOptions.map(day => (
                        <button
                          key={day.value}
                          type="button"
                          onClick={() => toggleMedDay(day.value)}
                          className={cn(
                            'w-10 h-10 rounded-full text-sm font-medium transition-colors',
                            editMed.reminder_days.includes(day.value)
                              ? 'bg-primary text-primary-foreground shadow-sm'
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          )}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" loading={savingMed} onClick={saveMedEdit}>
                      <Check className="w-4 h-4" /> Save
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditingMedId(null)}>
                      <X className="w-4 h-4" /> Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                /* ── Display Mode ── */
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className={cn(
                      'w-9 h-9 rounded-full flex items-center justify-center mt-0.5 shrink-0',
                      med.is_active ? 'bg-emerald-50 dark:bg-emerald-950/30' : 'bg-muted'
                    )}>
                      <Pill className={cn(
                        'w-4 h-4',
                        med.is_active ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
                      )} />
                    </div>
                    <div>
                      <p className="font-medium">
                        {med.name}
                        {med.dosage && <span className="text-muted-foreground ml-1">({med.dosage})</span>}
                      </p>
                      {med.description && (
                        <p className="text-sm text-muted-foreground mt-0.5">{med.description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                        <span>{med.reminder_time}</span>
                        <div className="flex gap-1">
                          {med.reminder_days?.map((d: number) => (
                            <span
                              key={d}
                              className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-xs font-medium"
                            >
                              {dayLabels[d] || '?'}
                            </span>
                          ))}
                        </div>
                      </div>
                      {(med.refill_remaining_doses != null || med.last_refill_date) && (
                        <div className="mt-2 text-xs text-muted-foreground space-x-2">
                          {med.refill_remaining_doses != null && (
                            <span
                              className={cn(
                                'inline-flex px-2 py-0.5 rounded-full',
                                Number(med.refill_remaining_doses) <= Number(med.refill_alert_threshold || 3)
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                                  : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {med.refill_remaining_doses} doses left
                            </span>
                          )}
                          {med.last_refill_date && (
                            <span>Last refill: {med.last_refill_date}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEditMed(med)}
                      className="text-muted-foreground hover:text-foreground p-1.5 rounded-lg hover:bg-muted transition-colors"
                      title="Edit medication"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => toggleMedActive(med)}
                      disabled={togglingMedId === med.id}
                      className={cn(
                        'p-1.5 rounded-lg transition-colors',
                        med.is_active
                          ? 'text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
                          : 'text-muted-foreground hover:bg-muted'
                      )}
                      title={med.is_active ? 'Deactivate reminder' : 'Activate reminder'}
                    >
                      <Power className={cn('w-3.5 h-3.5', togglingMedId === med.id && 'animate-pulse')} />
                    </button>
                    {confirmDeleteId === med.id ? (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="destructive"
                          size="sm"
                          loading={deletingMedId === med.id}
                          onClick={() => handleDeleteMed(med.id)}
                        >
                          Delete
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(med.id)}
                        className="text-muted-foreground hover:text-destructive p-1.5 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                        title="Delete medication"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <StatusBadge variant={med.is_active ? 'active' : 'inactive'}>
                      {med.is_active ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  </div>
                </div>
              )}
            </div>
          ))}
          {(!patient.medications || patient.medications.length === 0) && (
            <EmptyState
              icon={Pill}
              title="No medications"
              description="Add a medication to start sending reminders"
              className="py-12"
            />
          )}
        </div>
      </div>

      {/* Recent calls */}
      <div>
        <h2 className="font-semibold mb-4">Recent Calls</h2>

        {loadingCalls ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-20 rounded-2xl animate-pulse bg-muted/60" />
            ))}
          </div>
        ) : calls && calls.length > 0 ? (
          <div className="space-y-3">
            {calls.map((call: any) => {
              const variant = getCallStatusVariant(call.medication_taken, call.status);
              const borderColor =
                variant === 'taken' ? 'border-l-emerald-400' :
                variant === 'missed' ? 'border-l-rose-400' :
                variant === 'unreached' ? 'border-l-slate-300' :
                'border-l-amber-400';

              return (
                <div key={call.id} className={cn('rounded-2xl shadow-soft bg-white dark:bg-card p-4 border-l-4', borderColor)}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <StatusBadge variant={variant}>
                        {getCallStatusLabel(call.medication_taken, call.status)}
                      </StatusBadge>
                      <span className="text-sm text-muted-foreground">
                        {call.medications?.name}
                      </span>
                    </div>
                    <div className="text-right text-sm text-muted-foreground">
                      <p>{formatDate(call.created_at)} {formatTime(call.created_at)}</p>
                      {call.duration_seconds != null && call.duration_seconds > 0 && (
                        <p className="text-xs">{formatDuration(call.duration_seconds)}</p>
                      )}
                    </div>
                  </div>
                  <CallTranscript
                    transcript={call.patient_response}
                    callSid={call.call_sid}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={Phone}
            title="No calls yet"
            description="Calls will appear here once reminders are sent"
            className="py-12"
          />
        )}
      </div>
    </div>
  );
}
