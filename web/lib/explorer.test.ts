import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explorerAddressUrl, explorerTxUrl } from './explorer.ts';

// The first-trade mint (shared/demo-evidence.md), whose OKLink page is
// known to render in a normal browser.
const MINT_TX =
  '0x32aa67ca132bf362d910a1cdaea334b36bd4d7e9238b450a3692fe87e7a7255d';

void test('transaction links open the OKLink X Layer Testnet tx page', () => {
  assert.equal(
    explorerTxUrl(MINT_TX),
    `https://www.oklink.com/x-layer-testnet/tx/${MINT_TX}`,
  );
});

void test('address links open the OKLink X Layer Testnet address page', () => {
  assert.equal(
    explorerAddressUrl('0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604'),
    'https://www.oklink.com/x-layer-testnet/address/0xb22A449cdEfA3C4D226Ff69fd87d95f4FaadE604',
  );
});
