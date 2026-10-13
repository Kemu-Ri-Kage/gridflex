import assert from 'node:assert/strict';
import { test } from 'node:test';

import { payoutFigures, payoutLine } from './ticket-figures.ts';

const open = { side: 'YES', ready: true, tradingOpen: true, quoteUnavailable: false } as const;

void test('a quoted buy reads as plain money: premium, max payout if its side pays, and max loss', () => {
  assert.equal(
    payoutLine({ ...open, units: 100_000_000n, totalOut: 190_450_000n }),
    'Premium 100 mUSDT → max payout 190.45 mUSDT if Long pays (+90.45). Max loss 100 mUSDT.',
  );
  assert.equal(
    payoutLine({ ...open, side: 'NO', units: 25_500_000n, totalOut: 49_999_999n }),
    'Premium 25.5 mUSDT → max payout 50 mUSDT if Short pays (+24.5). Max loss 25.5 mUSDT.',
  );
});

void test('without a quote, a valid amount or open trading, the line says so and promises nothing', () => {
  assert.equal(payoutLine({ ...open, units: 100_000_000n, totalOut: undefined }), 'Premium 100 mUSDT → quoting…');
  assert.equal(
    payoutLine({ ...open, units: 100_000_000n, totalOut: undefined, quoteUnavailable: true }),
    'Premium 100 mUSDT → no live quote',
  );
  assert.equal(payoutLine({ ...open, units: undefined, totalOut: undefined }), 'Enter an amount in mUSDT.');
  assert.equal(
    payoutLine({ ...open, tradingOpen: false, units: 100_000_000n, totalOut: 190_450_000n }),
    'Trading closed.',
  );
  assert.equal(payoutLine({ ...open, ready: false, tradingOpen: false, units: 100_000_000n, totalOut: undefined }), '—');
});

void test('a quoted buy returns its figures in mUSDT units: premium, max payout and the gain', () => {
  assert.deepEqual(payoutFigures({ ...open, units: 100_000_000n, totalOut: 190_450_000n }), {
    kind: 'quote',
    pay: 100_000_000n,
    receive: 190_450_000n,
    gain: 90_450_000n,
  });
  assert.deepEqual(payoutFigures({ ...open, side: 'NO', units: 25_500_000n, totalOut: 49_999_999n }), {
    kind: 'quote',
    pay: 25_500_000n,
    receive: 49_999_999n,
    gain: 24_499_999n,
  });
});

void test('without a quote, a valid amount or open trading, the figures are the same one-line messages', () => {
  const message = (text: string) => ({ kind: 'message', text });
  assert.deepEqual(
    payoutFigures({ ...open, units: 100_000_000n, totalOut: undefined }),
    message('Premium 100 mUSDT → quoting…'),
  );
  assert.deepEqual(
    payoutFigures({ ...open, units: 100_000_000n, totalOut: undefined, quoteUnavailable: true }),
    message('Premium 100 mUSDT → no live quote'),
  );
  // A failed quote is reported even when an older totalOut is still passed in.
  assert.deepEqual(
    payoutFigures({ ...open, units: 100_000_000n, totalOut: 190_450_000n, quoteUnavailable: true }),
    message('Premium 100 mUSDT → no live quote'),
  );
  assert.deepEqual(
    payoutFigures({ ...open, units: undefined, totalOut: 190_450_000n }),
    message('Enter an amount in mUSDT.'),
  );
  assert.deepEqual(
    payoutFigures({ ...open, tradingOpen: false, units: 100_000_000n, totalOut: 190_450_000n }),
    message('Trading closed.'),
  );
  assert.deepEqual(
    payoutFigures({ ...open, ready: false, tradingOpen: false, units: 100_000_000n, totalOut: 190_450_000n }),
    message('—'),
  );
});
