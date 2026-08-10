/**
 * Turns a raw headline into a human reason category, and filters out
 * generic market-roundup noise that explains nothing.
 */

const CATEGORY_RULES: [RegExp, string][] = [
  [/\b(earnings|revenue|results|profit|guidance|beat|beats|misses|quarterly|q[1-4]\b|fiscal)\b/i, "Earnings news"],
  [/\b(fda|approval|clinical|trial|phase\s|drug|therapy|treatment)\b/i, "Drug or trial news"],
  [/\b(upgrade[ds]?|downgrade[ds]?|price target|analyst|initiat(es|ed) coverage|rating)\b/i, "Analyst rating change"],
  [/\b(merger|acquisition|acquires?|acquired|buyout|takeover|take-private|stake in)\b/i, "Deal or takeover news"],
  [/\b(contract|partnership|partners? with|agreement|order[s]? (from|worth)|wins?\b)\b/i, "New contract or partnership"],
  [/\b(launch(es|ed)?|unveil(s|ed)?|introduc(es|ed)|new product|rollout|debut)\b/i, "Product launch"],
  [/\b(offering|dilution|reverse split|stock split|warrant|pricing of|registered direct|private placement)\b/i, "Share issue or dilution"],
  [/\b(bankruptcy|chapter 11|delisting|investigation|lawsuit|fraud|sec charges)\b/i, "Legal or listing trouble"],
  [/\b(short squeeze|squeeze|meme stock|retail traders)\b/i, "Trader chatter"],
  [/\b(etf|listing|listed on|coinbase|binance|upgrade|mainnet|token unlock|halving|airdrop|staking)\b/i, "Crypto project news"],
  [/\b(why is|rally(ing)?|surge[ds]?|soar(s|ed)?|jump(s|ed)?|spik(es|ed)|explod)\b/i, "Coverage of the move"]
];

const ROUNDUP_PATTERN = /\b(movers|top gainers|top losers|stocks to watch|stocks to buy|market wrap|midday|premarket movers|after-hours movers|newsletter|things to know|watchlist|weekly recap|best stocks|hot stocks|price today|live price|chart & market data|price prediction|price analysis|technical analysis|how to buy|where to buy)\b/i;

export function isRoundupHeadline(title: string): boolean {
  return ROUNDUP_PATTERN.test(title);
}

export function classifyHeadline(title: string): string | null {
  for (const [pattern, label] of CATEGORY_RULES) {
    if (pattern.test(title)) return label;
  }
  return null;
}
