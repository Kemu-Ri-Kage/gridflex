import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onTicketPrefill, prefillTicket, takeTicketPrefill } from './ticket-prefill.ts';

const MARKET = '0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604';

void test('a request is taken once, only by the ticket for its market, whatever the address case', () => {
  prefillTicket({ market: MARKET, side: 'YES', amount: '250' });
  assert.equal(takeTicketPrefill('0x845A05007aD577f37eDC8779afF28169a7321D77'), undefined);
  assert.deepEqual(takeTicketPrefill(MARKET.toLowerCase()), { market: MARKET, side: 'YES', amount: '250' });
  assert.equal(takeTicketPrefill(MARKET), undefined);
  assert.equal(takeTicketPrefill(undefined), undefined);
});

void test('a newer request replaces one not yet taken, and listeners hear each one until they unsubscribe', () => {
  const heard: string[] = [];
  const stop = onTicketPrefill((prefill) => heard.push(prefill.amount));
  prefillTicket({ market: MARKET, side: 'YES', amount: '1' });
  prefillTicket({ market: MARKET, side: 'NO', amount: '2' });
  stop();
  prefillTicket({ market: MARKET, side: 'YES', amount: '3' });
  assert.deepEqual(heard, ['1', '2']);
  assert.equal(takeTicketPrefill(MARKET)?.amount, '3');
});
