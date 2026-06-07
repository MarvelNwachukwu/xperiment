// ── Tech / Crypto Bio Filtering ───────────────────────────────
// Single source of truth shared by follow-bot and unfollow-bot so the
// two can never drift. If the lists drift, the unfollow bot can flag a
// freshly-followed crypto account as "not tech" and unfollow it.

export const TECH_KEYWORDS = [
  // Roles
  "developer", "dev", "engineer", "programmer", "coder", "hacker",
  "founder", "cto", "ceo", "co-founder", "cofounder",
  "designer", "ux", "ui",
  // Domains
  "software", "web3", "crypto", "blockchain", "bitcoin", "btc", "eth",
  "ethereum", "defi", "nft", "ai", "ml", "machine learning",
  "artificial intelligence", "data science", "data engineer",
  "devops", "sre", "cloud", "aws", "gcp", "azure",
  "cybersecurity", "infosec", "security",
  "frontend", "backend", "fullstack", "full-stack", "full stack",
  "mobile", "ios", "android", "flutter", "react native",
  // Technologies
  "javascript", "typescript", "python", "rust", "golang", "solidity",
  "react", "nextjs", "next.js", "vue", "angular", "svelte",
  "node", "nodejs", "deno", "bun",
  "docker", "kubernetes", "k8s", "terraform",
  "postgres", "mongodb", "redis", "graphql",
  "open source", "oss", "github", "api",
  // Startup / VC
  "startup", "saas", "b2b", "yc", "ycombinator", "techstars",
  "venture", "investor", "angel",
  // Tech media / community
  "tech", "hackathon", "buildinpublic", "building in public",
  "indie hacker", "indiehacker", "shipfast",

  // Crypto / Web3 chains & ecosystems
  "solana", "polygon", "avalanche", "avax", "arbitrum", "optimism",
  "polkadot", "cosmos", "cardano", "aptos", "sui", "near protocol",
  "cronos", "fantom", "ton", "tron", "base chain",
  // Crypto / Web3 primitives
  "protocol", "network", "ecosystem", "infrastructure", "platform", "labs",
  "token", "tokenize", "tokenizing", "tokenization", "stablecoin", "coin",
  "memecoin", "altcoin", "wallet", "dapp", "dao", "dex", "amm", "oracle",
  "liquidity", "yield", "staking", "stake", "validator", "node operator",
  "mining", "miner", "mine", "proof-of-work", "proof of work",
  "proof-of-stake", "proof of stake", "consensus",
  "layer", "l1", "l2", "rollup", "zk", "zero-knowledge", "zero knowledge",
  "snark", "stark", "evm", "svm", "smart contract", "onchain", "on-chain",
  "mainnet", "testnet", "airdrop", "mint", "minting",
  // Privacy / cryptography
  "privacy", "encryption", "encrypted", "cryptography", "cryptographic",
  // Verticals
  "ledger", "chain", "depin", "rwa", "real world asset", "real-world asset",
  "gamefi", "socialfi", "metaverse",
  // Fintech / trading
  "payments", "payment", "fintech", "exchange", "trading", "trader",
  "treasury", "custody", "settlement", "derivatives", "perpetuals", "perps",
  "lending", "swap", "bridge",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matchers. `(?<![\w])...(?![\w])` avoids false positives
// like "ai" inside "email" or "eth" inside "ethics", while still matching
// keywords that contain "." or "-" (e.g. "next.js", "proof-of-work") where
// the plain \b boundary would misbehave.
const KEYWORD_MATCHERS = TECH_KEYWORDS.map((kw) => ({
  kw,
  re: new RegExp(`(?<![\\w])${escapeRegExp(kw)}(?![\\w])`, "i"),
}));

// Structural crypto signals that catch protocol/company bios even when the
// prose contains no listed keyword (e.g. a bare ticker, or a posted contract
// address). These are what rescue accounts like @twousdstable ("$2") and
// @zinc_cash ("...CA: zinc155BS4mSPk8...").
const CRYPTO_SIGNALS = [
  /\$[a-z0-9]{1,12}(?![\w])/i,        // cashtag: $SOL, $BTC, $2
  /\bca\s*[:=]\s*[a-z0-9]{20,}/i,     // contract-address callout: "CA: ..."
  /\b[a-km-zA-HJ-NP-Z1-9]{32,44}\b/,  // base58 address (Solana)
  /\b0x[a-f0-9]{40}\b/i,              // EVM address
];

/**
 * Returns the list of tech/crypto signals found in a bio. Keyword matches are
 * returned verbatim; a structural crypto signal (with no keyword) reports
 * "crypto-signal". Empty array means no match.
 */
export function matchedTechKeywords(bio: string): string[] {
  const matched = KEYWORD_MATCHERS.filter(({ re }) => re.test(bio)).map((m) => m.kw);
  if (matched.length === 0 && CRYPTO_SIGNALS.some((re) => re.test(bio))) {
    matched.push("crypto-signal");
  }
  return matched;
}

export function matchesTechKeywords(bio: string): boolean {
  return (
    KEYWORD_MATCHERS.some(({ re }) => re.test(bio)) ||
    CRYPTO_SIGNALS.some((re) => re.test(bio))
  );
}
