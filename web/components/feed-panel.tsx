'use client';

import * as React from 'react';
import { AlertTriangle, Clock3, ExternalLink, History, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { xLayerTestnet } from '@/lib/contracts';
import { formatElapsed } from '@/lib/feed-verification';
import { formatPrice, formatUpdated } from '@/lib/format';
import { useFeedData, type VerifiedRow } from '@/lib/feed-data';
import { dayLabel } from '@/lib/markets';

/**
 * shared/feed-spec.md §4: exactly one indicator per row, one of four states.
 *
 * `now` is passed in rather than read via Date.now() here so this component
 * stays pure during render - the impure clock read lives in FeedPanel's
 * effect below, not in render.
 *
 * MISMATCH is deliberately not a Badge: it renders as a solid filled block,
 * never as inline text/border colour, so it can never be mistaken for a
 * transient check failure or a passing verification pill.
 */
function VerificationBadge({ row, now }: { row: VerifiedRow; now: number }) {
  const { status, lastVerifiedAt } = row.verification;
  const ago = lastVerifiedAt !== null ? formatElapsed(now - lastVerifiedAt) : null;

  switch (status) {
    case 'VERIFIED':
      return (
        <Badge variant="outline" className="rounded-[2px] border-up/30 text-up">
          <ShieldCheck className="size-3" />
          Verified {ago} ago
        </Badge>
      );
    case 'LAST_VERIFIED':
      return (
        <Badge variant="secondary" className="rounded-[2px] text-muted-foreground">
          <History className="size-3" />
          Last verified {ago} ago
        </Badge>
      );
    case 'MISMATCH':
      return (
        <span className="inline-flex items-center gap-1.5 border-l-2 border-mismatch-accent bg-mismatch px-2 py-1 text-xs font-medium text-mismatch-foreground">
          <AlertTriangle className="size-3" />
          MISMATCH
        </span>
      );
    case 'UNVERIFIED':
    default:
      return (
        <Badge variant="secondary" className="rounded-[2px] text-muted-foreground/70">
          <Clock3 className="size-3" />
          Not yet verified
        </Badge>
      );
  }
}

function explorerTxUrl(txHash: string): string {
  return `${xLayerTestnet.blockExplorers.default.url}/tx/${txHash}`;
}

/**
 * The Proof section's table: every published Texas power price, each with
 * its live verification state against the oracle (shared/feed-spec.md §4).
 */
export function FeedPanel() {
  const { loading, totalLocalCandidates, submittedCount, updatedAt, rows } = useFeedData();
  const updated = formatUpdated(updatedAt);

  // "now" lives in state, updated from an effect, so render itself stays
  // pure - "Verified Xs ago" still advances without a full refetch.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Card>
      <CardHeader className="border-b border-border pb-4">
        <div>
          <CardTitle className="text-base text-foreground">Verified prices</CardTitle>
          <CardDescription>
            <span className="font-mono tabular-nums">
              {submittedCount.toLocaleString('en-US')} of{' '}
              {totalLocalCandidates.toLocaleString('en-US')}
            </span>{' '}
            days published onchain.
          </CardDescription>
          {updated && (
            <p className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
              Updated {updated}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-1">
        {rows.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            {loading ? 'Loading…' : 'No prices published yet.'}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Texas power price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Oracle tx</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.record.dayKey}>
                  <TableCell className="font-mono tabular-nums text-muted-foreground">
                    {dayLabel(row.record.dayKey, true)}
                  </TableCell>
                  <TableCell className="font-mono tabular-nums text-foreground">
                    {formatPrice(row.record.value, 'MWh')}
                  </TableCell>
                  <TableCell title={`sha256 ${row.record.sourceHash}`}>
                    <VerificationBadge row={row} now={now} />
                  </TableCell>
                  <TableCell>
                    {row.record.txHash && (
                      <a
                        className="inline-flex items-center gap-1 font-mono text-xs text-chart-1 transition-colors duration-200 hover:text-foreground hover:underline"
                        href={explorerTxUrl(row.record.txHash)}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {row.record.txHash.slice(0, 10)}…
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
