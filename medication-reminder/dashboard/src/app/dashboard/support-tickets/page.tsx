'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ticket, CheckCircle2, Clock, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/form-field';
import { useToast } from '@/components/toast';
import { checkIsAdmin, fetchSupportTickets, resolveSupportTicket } from '@/lib/queries';
import { cn } from '@/lib/utils';

interface SupportTicket {
  id: string;
  email: string;
  subject: string;
  message: string;
  status: string;
  response: string | null;
  created_at: string;
}

export default function SupportTicketsPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    async function load() {
      const admin = await checkIsAdmin();
      if (!admin) {
        router.replace('/dashboard');
        return;
      }
      setAuthorized(true);
      try {
        const data = await fetchSupportTickets();
        setTickets(data || []);
      } catch (err) {
        toast('Failed to load tickets', 'error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleResolve(id: string) {
    setResolvingId(id);
    try {
      const response = responses[id]?.trim() || undefined;
      await resolveSupportTicket(id, response);
      setTickets((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: 'resolved', response: response || null } : t))
      );
      setResponses((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      toast('Ticket resolved', 'success');
    } catch (err) {
      toast('Failed to resolve ticket', 'error');
    } finally {
      setResolvingId(null);
    }
  }

  if (!authorized) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-primary/10">
          <Ticket className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Support Tickets</h1>
          <p className="text-sm text-muted-foreground">
            {tickets.filter((t) => t.status === 'open').length} open tickets
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading tickets...</div>
      ) : tickets.length === 0 ? (
        <div className="text-center py-12">
          <Ticket className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground">No support tickets yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              className={cn(
                'rounded-xl border p-4 transition-colors',
                ticket.status === 'resolved'
                  ? 'border-border/40 bg-muted/30'
                  : 'border-border/60 bg-background'
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                {ticket.status === 'open' ? (
                  <Clock className="w-4 h-4 text-amber-500 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                )}
                <h3 className="font-medium text-foreground truncate">
                  {ticket.subject}
                </h3>
              </div>
              <p className="text-sm text-muted-foreground mb-2 whitespace-pre-wrap">
                {ticket.message}
              </p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{ticket.email}</span>
                <span>
                  {new Date(ticket.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              {ticket.status === 'resolved' && ticket.response && (
                <div className="mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-3">
                  <p className="text-xs font-medium text-emerald-600 mb-1">Admin Response</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{ticket.response}</p>
                </div>
              )}

              {ticket.status === 'open' && (
                <div className="mt-3 space-y-2">
                  <textarea
                    value={responses[ticket.id] || ''}
                    onChange={(e) =>
                      setResponses((prev) => ({ ...prev, [ticket.id]: e.target.value }))
                    }
                    placeholder="Write a response (optional)..."
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg border border-border/60 bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-colors resize-none"
                  />
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={resolvingId === ticket.id}
                      onClick={() => handleResolve(ticket.id)}
                    >
                      {responses[ticket.id]?.trim() ? 'Respond & Resolve' : 'Resolve'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
