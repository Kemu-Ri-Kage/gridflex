# Submission answers

Project summary in three lengths, written in the design brief's plain-language
dictionary (`shared/design-brief.md` §5). Every fact matches
`README.md` and `shared/addresses.json` as of 23 September 2026. Cashing out
before settlement, automated orders and dated futures don't exist yet and
appear only as roadmap.

## Three short paragraphs

Bitcoin miners in Texas pay one of the most volatile power prices in the
world, and electricity is their largest cost. They have no way to hedge it
onchain. Institutions can, on ICE, through a futures broker, in contracts of
hundreds of megawatt-hours.

GRIDFLEX lists YES/NO questions on that price, such as "Will Texas power cost
more than $45 on 2 Oct 2026?" Each YES pays 1 MockUSDT if that day's price
settles above the strike; the first live trade was 10 MockUSDT. It settles
against ERCOT's official published price: the average of the day's 24 hourly
day-ahead prices, published with a SHA-256 hash of its source files so anyone
can recompute it.

X Layer testnet carries the whole settlement path. `GridOracle` stores one
reading per day; `MarketFactory` creates each market; `BinaryMarket` holds
fully collateralised YES and NO tokens (`OutcomeToken`), lets a wallet Buy
YES, Buy NO or switch sides, and resolves against the oracle's reading.
Seventeen markets exist: fifteen trading, a daily ladder from 26 Sep to 2 Oct, and two resolved. A Hedge tab sizes a ladder
of YES tokens for a power bill in megawatts, and a price API serves the
verified price and hedge quotes to AI agents, registered on OKX.AI as agent
#13881 (free today; $0.01 a call in USDT0 on X Layer through x402 once
payments switch on). Next: cashing out before settlement,
an AI agent that keeps a load hedged, and dated futures on a week or month
of prices.

## Under 100 words

Bitcoin miners in Texas pay one of the world's most volatile power prices,
and electricity is their largest cost, but they can't hedge it
onchain. Institutions can, on ICE, through a broker, in contracts of hundreds
of megawatt-hours. GRIDFLEX lists YES/NO questions on that price, such as
"Will Texas power cost more than $45 on 2 Oct?" Each YES pays 1 MockUSDT if
the official published price settles above the strike. On X Layer testnet,
`GridOracle` publishes each day's price with a source hash;
`MarketFactory` creates markets; `BinaryMarket` holds fully collateralised
YES/NO tokens and resolves against the oracle.

## Under 50 words

Bitcoin miners in Texas can't hedge their largest cost, one of the world's
most volatile power prices, onchain; institutions do, on ICE, through a
broker, in contracts of hundreds of megawatt-hours. GRIDFLEX lists YES/NO
questions on that price, settled in MockUSDT on X Layer testnet against a
hash-verified oracle.
