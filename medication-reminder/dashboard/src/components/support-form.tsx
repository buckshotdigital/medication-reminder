'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { FormField, Input, Button } from '@/components/form-field';
import { useToast } from '@/components/toast';
import { submitSupportTicket } from '@/lib/queries';

interface SupportFormProps {
  open: boolean;
  onClose: () => void;
}

export function SupportForm({ open, onClose }: SupportFormProps) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;

    setLoading(true);
    try {
      await submitSupportTicket(subject.trim(), message.trim());
      toast('Support ticket submitted — we\'ll get back to you soon!', 'success');
      setSubject('');
      setMessage('');
      onClose();
    } catch (err) {
      toast((err as Error).message || 'Failed to submit ticket', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-background rounded-2xl border border-border/60 shadow-xl p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">Contact Support</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <FormField label="Subject" required>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Brief description of the issue"
              required
            />
          </FormField>

          <FormField label="Message" required>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe the issue in detail..."
              rows={4}
              required
              className="w-full px-4 py-2.5 rounded-xl border border-border/60 bg-background text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors resize-none"
            />
          </FormField>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={loading}>
              Submit Ticket
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
