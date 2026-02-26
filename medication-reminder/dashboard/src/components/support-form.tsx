'use client';

import { useState, useEffect } from 'react';
import { X, Clock, CheckCircle2, MessageSquare } from 'lucide-react';
import { FormField, Input, Button } from '@/components/form-field';
import { useToast } from '@/components/toast';
import { submitSupportTicket, fetchMyTickets } from '@/lib/queries';

interface SupportFormProps {
  open: boolean;
  onClose: () => void;
}

interface MyTicket {
  id: string;
  subject: string;
  message: string;
  status: string;
  response: string | null;
  created_at: string;
}

export function SupportForm({ open, onClose }: SupportFormProps) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [tickets, setTickets] = useState<MyTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setTicketsLoading(true);
      fetchMyTickets()
        .then((data) => setTickets(data || []))
        .catch(() => {})
        .finally(() => setTicketsLoading(false));
    }
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !message.trim()) return;

    setLoading(true);
    try {
      await submitSupportTicket(subject.trim(), message.trim());
      toast('Support ticket submitted — we\'ll get back to you soon!', 'success');
      setTickets((prev) => [
        {
          id: crypto.randomUUID(),
          subject: subject.trim(),
          message: message.trim(),
          status: 'open',
          response: null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      setSubject('');
      setMessage('');
    } catch (err) {
      toast((err as Error).message || 'Failed to submit ticket', 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md mx-4 bg-background rounded-2xl border border-border/60 shadow-xl p-6 animate-fade-in max-h-[85vh] overflow-y-auto">
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

        {/* Ticket History */}
        {ticketsLoading ? (
          <div className="mt-6 pt-4 border-t border-border/40 text-center text-sm text-muted-foreground">
            Loading your tickets...
          </div>
        ) : tickets.length > 0 && (
          <div className="mt-6 pt-4 border-t border-border/40">
            <h3 className="text-sm font-medium text-foreground mb-3">Your Tickets</h3>
            <div className="space-y-3">
              {tickets.map((ticket) => (
                <div
                  key={ticket.id}
                  className="rounded-xl border border-border/40 p-3 bg-muted/20"
                >
                  <div className="flex items-center gap-2 mb-1">
                    {ticket.status === 'open' ? (
                      <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    )}
                    <span className="text-sm font-medium text-foreground truncate">
                      {ticket.subject}
                    </span>
                    <span className={`ml-auto text-[11px] px-1.5 py-0.5 rounded-full font-medium ${
                      ticket.status === 'open'
                        ? 'bg-amber-500/10 text-amber-600'
                        : 'bg-emerald-500/10 text-emerald-600'
                    }`}>
                      {ticket.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {new Date(ticket.created_at).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </p>
                  {ticket.response && (
                    <div className="mt-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2.5">
                      <div className="flex items-center gap-1.5 mb-1">
                        <MessageSquare className="w-3 h-3 text-emerald-600" />
                        <span className="text-[11px] font-medium text-emerald-600">Response</span>
                      </div>
                      <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.response}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
