# Submission answers

Project summary in three lengths, written in the design brief's plain-language
dictionary (`shared/design-brief.md` §5). Every fact matches
`README.md` and `shared/addresses.json` as of 23 September 2026. Cashing out
before settlement, automated orders and dated futures don't exist yet and
appear only as roadmap.

## Three short paragraphs

GRIDFLEX lists YES/NO questions on the Texas power price, such as "Will Texas
power cost more than $45 on 2 Oct 2026?" Each YES pays 1 MockUSDT if that
day's price settles above the strike. It settles against the official published
price from ERCOT, Texas's official grid price: the average of the day's 24 hourly
day-ahead prices, published with a SHA-256 hash of its source files so anyone
can recompute it.

It's for traders who want exposure unrelated to crypto, since Texas power
moves on weather, gas prices and grid demand, and for anyone whose costs
depend on Texas power, such as bitcoin miners and data centres. Institutions
trade this risk on ICE through a futures broker; the first live GRIDFLEX
trade was 10 MockUSDT.

X Layer testnet carries the whole settlement path. `GridOracle` stores one
reading per day; `MarketFactory` creates each market; `BinaryMarket` holds
fully collateralised YES and NO tokens (`OutcomeToken`), lets a wallet Buy
YES, Buy NO or switch sides, and resolves against the oracle's reading.
Five markets exist: three trading, two resolved. Next: cashing out before
settlement, stop-loss and take-profit orders, and dated futures on a week or
month of prices.

## Under 100 words

GRIDFLEX lists YES/NO questions on the Texas power price, such as "Will Texas
power cost more than $45 on 2 Oct?", settled against the official published
price. Each YES pays 1 MockUSDT if it settles above the strike. It's for traders wanting exposure unrelated to crypto, and
businesses whose costs depend on Texas power, like bitcoin miners and data
centres. On X Layer testnet, `GridOracle` publishes each day's price with a
hash of its source; `MarketFactory` creates markets; `BinaryMarket`
holds fully collateralised YES/NO tokens and resolves against the oracle.
Next: cashing out before settlement, automated orders, dated futures.

## Under 50 words

GRIDFLEX: YES/NO questions on the Texas power price, settled against the
official published price, for traders and Texas power users like bitcoin
miners. On X Layer testnet, `GridOracle` publishes each day's price with a
source hash, `MarketFactory` creates markets and `BinaryMarket` settles them
in MockUSDT.
