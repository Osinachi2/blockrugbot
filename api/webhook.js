const EVM_CHAINS = {
  ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137", robinhood: "4663",
};

const EXPLORERS = {
  ethereum: "https://etherscan.io",
  bsc: "https://bscscan.com",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
  polygon: "https://polygonscan.com",
  robinhood: "https://robinhoodchain.blockscout.com",
};

// DexScreener chain name -> Uniswap interface chain name (fallback trade button)
const UNISWAP_CHAINS = { ethereum: "ethereum", base: "base", arbitrum: "arbitrum", polygon: "polygon" };

// Chains where Honeypot.is runs its own buy/sell simulation (edit if you verify more)
const HONEYPOT_IS_CHAINS = { ethereum: "1", bsc: "56", base: "8453" };

// Telegram trading bots. Your referral links come from Vercel environment variables.
// "chains" = where each bot trades. Check each bot's own chain list and edit if needed.
const TRADE_BOTS = [
  { name: "Banana Gun", emoji: "🍌", env: "REF_BANANA", solEnv: "REF_BANANA_SOL", chains: ["ethereum", "base", "bsc", "robinhood", "solana"] },
  { name: "Maestro", emoji: "🤖", env: "REF_MAESTRO", solEnv: "REF_MAESTRO_SOL", chains: ["ethereum", "base", "bsc", "arbitrum", "solana"] },
  { name: "BasedBot", emoji: "🔵", env: "REF_BASED", solEnv: "REF_BASED_SOL", chains: ["ethereum", "base", "bsc", "arbitrum", "robinhood", "solana"] },
];

function botLink(bot, chain) {
  const raw = chain === "solana" ? process.env[bot.solEnv] || process.env[bot.env] : process.env[bot.env];
  const url = (raw || "").trim();
  return url.startsWith("https://t.me/") ? url : null;
}

const BURN = [
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000000",
  "1nc1nerator11111111111111111111111111111111",
];

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const esc = escapeHtml;

async function send(chatId, text, buttons, html) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (html) payload.parse_mode = "HTML";
  if (buttons && buttons.length) payload.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// fetch JSON with a timeout; returns null on any failure
async function getJson(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const num = (x) => parseFloat(x || "0") || 0;
const pct = (x) => (x * 100).toFixed(1) + "%";
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const known = (v) => v !== undefined && v !== null && v !== "";
const usd = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`;
const ageText = (h) => (h === null ? "n/a" : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

const isBurn = (h) => {
  const addr = (h.address || h.token_account || "").toLowerCase();
  return BURN.includes(addr) || /burn|incinerator/i.test(h.tag || "");
};

function parseTime(t) {
  if (!t) return null;
  const n = Number(t);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(t);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function analyzeLiquidity(lpHolders) {
  if (!Array.isArray(lpHolders) || lpHolders.length === 0) return null;
  let burned = 0;
  let locked = 0;
  const unlocks = [];
  for (const h of lpHolders) {
    const share = num(h.percent);
    if (isBurn(h)) {
      burned += share;
      continue;
    }
    if (Number(h.is_locked) === 1 || Number(h.locked) === 1) {
      locked += share;
      for (const d of h.locked_detail || []) {
        const t = parseTime(d.end_time);
        if (t) unlocks.push(t);
      }
    }
  }
  unlocks.sort((a, b) => a - b);
  return {
    burned,
    locked,
    soonest: unlocks.length ? unlocks[0] : null,
    latest: unlocks.length ? unlocks[unlocks.length - 1] : null,
  };
}

const LOCK_UNKNOWN =
  "LP lock: could not be read. This is common with concentrated-liquidity pools (Uniswap V3/V4 style). Verify the lock using the pool button.";

function lockSummary(lp, add, source) {
  const total = lp.locked + lp.burned;
  if (total === 0) {
    add(25, "No liquidity lock or burn detected (unlocked liquidity can be withdrawn by whoever holds it)");
    return {
      row: "🔒 LP lock: none detected ⚠️",
      detail: `LP lock: none detected (${source}). Lock coverage can be incomplete on newer chains, so verify with the pool button.`,
    };
  }
  let detail = `LP locked or burned: ${pct(total)} (burned ${pct(lp.burned)}, locked ${pct(lp.locked)}) per ${source}`;
  let extra = "";
  if (lp.soonest) {
    const days = Math.round((lp.soonest - Date.now()) / 864e5);
    detail += days < 0
      ? `\nSoonest unlock: ${fmtDate(lp.soonest)} (already passed)`
      : `\nSoonest unlock: ${fmtDate(lp.soonest)} (in ${days} days)`;
    if (lp.latest && lp.latest !== lp.soonest) {
      detail += `\nLatest unlock: ${fmtDate(lp.latest)} (in ${Math.round((lp.latest - Date.now()) / 864e5)} days)`;
    }
    if (days <= 30) add(20, "Part of the liquidity unlocks within 30 days (or already has)");
    extra = days < 0 ? " (unlock passed)" : ` · unlocks in ${days}d`;
  }
  if (total < 0.5) add(25, `Only ${pct(total)} of liquidity is locked or burned`);
  return { row: `🔒 LP lock: ${pct(total)}${extra} ${total >= 0.8 ? "✅" : "⚠️"}`, detail };
}

// ---------- EVM scan (GoPlus + Honeypot.is) ----------
function scanEvm(sec, hp, add) {
  const rows = [];
  const details = [];

  const sim = hp && hp.simulationResult ? hp.simulationResult : null;
  const hpBuy = sim && typeof sim.buyTax === "number" ? sim.buyTax / 100 : null;
  const hpSell = sim && typeof sim.sellTax === "number" ? sim.sellTax / 100 : null;
  const gpBuy = known(sec.buy_tax) ? num(sec.buy_tax) : null;
  const gpSell = known(sec.sell_tax) ? num(sec.sell_tax) : null;
  const worst = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
  const buyTax = worst(gpBuy, hpBuy);
  const sellTax = worst(gpSell, hpSell);
  const taxStr = (v) => (v === null ? "?" : (v * 100).toFixed(1) + "%");

  if (sellTax !== null && sellTax > 0.1) add(30, `High sell tax (${(sellTax * 100).toFixed(0)}%)`);
  if (buyTax !== null && buyTax > 0.1) add(15, `High buy tax (${(buyTax * 100).toFixed(0)}%)`);
  if (sec.is_open_source === "0") add(20, "Contract code is not verified");
  if (sec.is_mintable === "1") add(15, "Owner can mint new tokens");
  if (sec.hidden_owner === "1") add(20, "Hidden owner detected");
  if (sec.can_take_back_ownership === "1") add(20, "Ownership can be taken back");
  if (sec.owner_change_balance === "1") add(25, "Owner can change balances");
  if (sec.transfer_pausable === "1") add(15, "Transfers can be paused");
  if (sec.is_blacklisted === "1") add(10, "Has a blacklist function");
  if (sec.cannot_sell_all === "1") add(25, "Cannot sell the full balance");
  if (sec.is_proxy === "1") add(10, "Upgradeable proxy: contract code can be changed");
  if (num(sec.creator_percent) > 0.2) add(15, `Creator holds ${pct(num(sec.creator_percent))} of supply`);

  // liquidity lock
  const lp = analyzeLiquidity(sec.lp_holders);
  if (lp) {
    const l = lockSummary(lp, add, "GoPlus");
    rows.push(l.row);
    details.push(l.detail);
  } else {
    rows.push("🔒 LP lock: unreadable (V3/V4 pool?) ❔");
    details.push(LOCK_UNKNOWN);
    add(10, "Liquidity lock could not be verified");
  }

  // ownership and code
  const ownerAddr = (sec.owner_address || "").toLowerCase();
  const renounced = !ownerAddr || BURN.includes(ownerAddr);
  rows.push(renounced ? "👤 Owner: renounced ✅" : `👤 Owner: NOT renounced (${short(ownerAddr)}) ⚠️`);
  rows.push(sec.is_open_source === "1" ? "📄 Code: verified ✅" : "📄 Code: NOT verified ❌");
  rows.push(`💸 Tax buy/sell: ${taxStr(buyTax)} / ${taxStr(sellTax)}`);

  // holders
  const holdersList = (sec.holders || []).filter((h) => !isBurn(h));
  const top10 = holdersList.slice(0, 10).reduce((sum, h) => sum + num(h.percent), 0);
  let line = "👥 ";
  if (holdersList.length) {
    line += `Top 10: ${pct(top10)}`;
    if (top10 > 0.5) add(15, `Top 10 holders own ${pct(top10)} of supply`);
  }
  if (sec.holder_count) line += `${holdersList.length ? " · " : ""}Holders: ${Number(sec.holder_count).toLocaleString()}`;
  if (line.length > 3) rows.push(line);

  details.push(`Taxes per GoPlus: ${taxStr(gpBuy)} / ${taxStr(gpSell)}`);
  if (sim) details.push(`Taxes per Honeypot.is simulation: ${taxStr(hpBuy)} / ${taxStr(hpSell)}`);
  details.push(`Mintable: ${sec.is_mintable === "1" ? "yes" : "no"} · Proxy: ${sec.is_proxy === "1" ? "yes" : "no"} · Creator holds: ${pct(num(sec.creator_percent))}`);
  details.push("Top 10 holders can include pools and exchanges.");

  return { rows, details };
}

// ---------- Solana scan (GoPlus + RugCheck) ----------
function scanSolana(sec, rc, add) {
  const rows = [];
  const details = [];
  const notes = [];
  const trusted = String(sec.trusted_token) === "1";
  const on = (field) => sec[field] && String(sec[field].status) === "1";

  if (!trusted) {
    if (on("mintable")) add(30, "Mint authority is NOT revoked: the creator can create unlimited new tokens");
    if (on("freezable")) add(30, "Freeze authority is NOT revoked: the creator can freeze your tokens");
    if (on("closable")) add(20, "Creator can close the token program");
    if (on("balance_mutable_authority")) add(30, "Creator can change holder balances");
  }
  if (Array.isArray(sec.transfer_hook) && sec.transfer_hook.length > 0) add(20, "Token has a transfer hook (can block trading)");
  if (String(sec.non_transferable) === "1") add(40, "Token is non-transferable");
  if (String(sec.default_account_state) === "2") add(40, "New accounts are frozen by default");

  const fee = num(sec.transfer_fee && sec.transfer_fee.current_fee_rate && sec.transfer_fee.current_fee_rate.fee_rate) / 10000;
  if (fee > 0.1) add(25, `Transfer fee of ${pct(fee)}`);

  const creators = sec.creator || sec.creators || [];
  if (Array.isArray(creators) && creators.some((c) => String(c.malicious_address) === "1")) {
    add(50, "Creator address is flagged as malicious");
  }
  if (trusted) notes.push("This is a well-known, trusted token, so authority flags were not counted as risks.");

  // liquidity lock: GoPlus first, RugCheck as backup
  const dexes = Array.isArray(sec.dex) ? [...sec.dex].sort((a, b) => num(b.tvl) - num(a.tvl)) : [];
  let lp = dexes.length ? analyzeLiquidity(dexes[0].lp_holders) : null;
  let source = "GoPlus";
  if (!lp && rc && typeof rc.lpLockedPct === "number") {
    lp = { burned: 0, locked: rc.lpLockedPct / 100, soonest: null, latest: null };
    source = "RugCheck";
  }
  if (lp) {
    const l = lockSummary(lp, add, source);
    rows.push(l.row);
    details.push(l.detail);
  } else {
    rows.push("🔒 LP lock: unreadable ❔");
    details.push(LOCK_UNKNOWN);
    add(10, "Liquidity lock could not be verified");
  }

  rows.push(`🔑 Mint authority: ${on("mintable") ? "ACTIVE ⚠️" : "revoked ✅"}`);
  rows.push(`🧊 Freeze authority: ${on("freezable") ? "ACTIVE ⚠️" : "revoked ✅"}`);

  // unlabeled wallets only (skips burn, lockers and tagged pools/entities)
  const holdersList = (sec.holders || []).filter((h) => !isBurn(h) && !h.tag && Number(h.is_locked) !== 1);
  const top10 = holdersList.slice(0, 10).reduce((sum, h) => sum + num(h.percent), 0);
  let line = "👥 ";
  if (holdersList.length) {
    line += `Top 10: ${pct(top10)}`;
    if (top10 > 0.5) add(15, `Top 10 unlabeled wallets own ${pct(top10)} of supply`);
  }
  if (sec.holder_count) line += `${holdersList.length ? " · " : ""}Holders: ${Number(sec.holder_count).toLocaleString()}`;
  if (line.length > 3) rows.push(line);

  details.push(`Can close program: ${on("closable") ? "yes" : "no"} · Can change balances: ${on("balance_mutable_authority") ? "yes" : "no"} · Metadata can change: ${on("metadata_mutable") ? "yes" : "no"}`);
  details.push("Holder percentages skip burn addresses, lockers and labeled pools.");

  return { rows, details, notes };
}

// ---------- Buttons ----------
function tradeButtons(pair, address, isEvm, score, blocked) {
  const rows = [];
  const chain = pair.chainId;
  let hasBots = false;
  let hasTrade = false;

  if (!blocked) {
    const prefix = score >= 60 ? "⚠️ " : "";

    // 1. Telegram trading bots (with your referral links)
    const botRow = [];
    for (const bot of TRADE_BOTS) {
      if (!bot.chains.includes(chain)) continue;
      const url = botLink(bot, chain);
      if (url) botRow.push({ text: `${prefix}${bot.emoji} ${bot.name}`, url });
    }
    if (botRow.length) {
      rows.push(botRow);
      hasBots = true;
      hasTrade = true;
    } else {
      // 2. Fallback: the DEX's own website
      let url = null;
      let name = null;
      if (!isEvm) {
        url = `https://jup.ag/swap/SOL-${address}`;
        name = "Jupiter";
      } else if (chain === "bsc") {
        url = `https://pancakeswap.finance/swap?chain=bsc&outputCurrency=${address}`;
        name = "PancakeSwap";
      } else if (UNISWAP_CHAINS[chain]) {
        url = `https://app.uniswap.org/swap?chain=${UNISWAP_CHAINS[chain]}&outputCurrency=${address}`;
        name = "Uniswap";
      }
      if (url) {
        rows.push([{ text: score >= 60 ? `⚠️ Trade anyway on ${name} (high risk)` : `🔄 Trade on ${name}`, url }]);
        hasTrade = true;
      }
    }
  }
  return { rows, hasBots, hasTrade };
}

function verifyButtons(pair, address, isEvm) {
  const row1 = [];
  const row2 = [];
  if (isEvm) {
    const ex = EXPLORERS[pair.chainId];
    if (ex) {
      row1.push({ text: "🔍 Contract", url: `${ex}/token/${address}` });
      row1.push({ text: "👥 Holders", url: `${ex}/token/${address}${pair.chainId === "robinhood" ? "?tab=holders" : "#balances"}` });
      if (pair.pairAddress && pair.pairAddress.length === 42) row1.push({ text: "💧 Pool", url: `${ex}/address/${pair.pairAddress}` });
    }
    row2.push({ text: "🛡 GoPlus", url: `https://gopluslabs.io/token-security/${EVM_CHAINS[pair.chainId]}/${address}` });
    if (HONEYPOT_IS_CHAINS[pair.chainId]) {
      row2.push({ text: "🍯 Honeypot.is", url: `https://honeypot.is/${pair.chainId}?address=${address}` });
    }
  } else {
    row1.push({ text: "🔍 Token", url: `https://solscan.io/token/${address}` });
    row1.push({ text: "👥 Holders", url: `https://solscan.io/token/${address}#holders` });
    if (pair.pairAddress) row1.push({ text: "💧 Pool", url: `https://solscan.io/account/${pair.pairAddress}` });
    row2.push({ text: "🛡 RugCheck", url: `https://rugcheck.xyz/tokens/${address}` });
  }
  if (pair.url) row2.push({ text: "📈 Chart", url: pair.url });
  return [row1, row2].filter((r) => r.length);
}

// ---------- The scan ----------
async function checkToken(address) {
  const isEvm = address.startsWith("0x");

  // 1. DexScreener: find the token's trading pairs
  const dex = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  let pairs = ((dex && dex.pairs) || []).filter((p) => (isEvm ? EVM_CHAINS[p.chainId] : p.chainId === "solana"));

  // prefer pairs where this token is the main (base) token
  const mine = pairs.filter(
    (p) => p.baseToken && p.baseToken.address && p.baseToken.address.toLowerCase() === address.toLowerCase()
  );
  if (mine.length) pairs = mine;

  if (pairs.length === 0) {
    return {
      text: "I couldn't find this token on Ethereum, BSC, Base, Arbitrum, Polygon, Robinhood Chain or Solana. Check the address and try again.",
      buttons: [],
    };
  }

  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const pair = pairs[0];
  const chainLabel = pair.chainId === "robinhood" ? "Robinhood Chain" : pair.chainId;
  const liquidity = (pair.liquidity && pair.liquidity.usd) || 0;
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 36e5 : null;
  const symbol = pair.baseToken ? pair.baseToken.symbol : "?";

  let score = 0;
  const flags = [];
  const add = (points, text) => { score += points; flags.push(text); };

  if (liquidity < 10000) add(20, `Low liquidity (${usd(liquidity)})`);
  if (ageHours !== null && ageHours < 24) add(15, "Trading pair is less than 24 hours old");

  // 2. Security sources, queried at the same time
  const evmChainId = EVM_CHAINS[pair.chainId];
  const gpUrl = isEvm
    ? `https://api.gopluslabs.io/api/v1/token_security/${evmChainId}?contract_addresses=${address}`
    : `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`;
  const hpChain = isEvm ? HONEYPOT_IS_CHAINS[pair.chainId] : null;

  const [gp, hpRaw, rcRaw] = await Promise.all([
    getJson(gpUrl),
    hpChain ? getJson(`https://api.honeypot.is/v2/IsHoneypot?address=${address}&chainID=${hpChain}`) : Promise.resolve(null),
    !isEvm ? getJson(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`) : Promise.resolve(null),
  ]);

  const sec = (gp && gp.result && (gp.result[address] || gp.result[address.toLowerCase()])) || null;
  const hp = hpRaw && (hpRaw.honeypotResult || hpRaw.simulationResult) ? hpRaw : null;
  const rc = rcRaw && typeof rcRaw === "object" && !rcRaw.error ? rcRaw : null;

  const rows = [];
  const details = [];
  const notes = [];

  // honeypot check (EVM): any source flagging it counts
  let honeypot = false;
  if (isEvm) {
    const flagged = [];
    const checked = [];
    if (sec) {
      checked.push("GoPlus");
      if (sec.is_honeypot === "1") flagged.push("GoPlus");
    }
    if (hp) {
      checked.push("Honeypot.is");
      if (hp.honeypotResult && hp.honeypotResult.isHoneypot) flagged.push("Honeypot.is");
    }
    if (flagged.length) {
      honeypot = true;
      add(100, `HONEYPOT: flagged by ${flagged.join(" + ")}`);
      rows.push(`🍯 Honeypot: YES ❌ (${flagged.join(" + ")})`);
    } else if (checked.length) {
      rows.push(`🍯 Honeypot: not detected ✅ (${checked.join(" + ")})`);
    } else {
      rows.push("🍯 Honeypot: not checked ❔");
    }
    if (pair.chainId === "robinhood" && sec && (sec.is_honeypot === "1" || sec.hidden_owner === "1" || sec.owner_change_balance === "1")) {
      notes.push("Note: GoPlus has been reported to flag some Uniswap-factory tokens on Robinhood Chain as honeypot or hidden-owner because of a default Permit2 allowance. Confirm with the buttons below before trusting these flags.");
    }
  }

  // contract-level scan
  if (sec) {
    const scan = isEvm ? scanEvm(sec, hp, add) : scanSolana(sec, rc, add);
    rows.push(...scan.rows);
    details.push(...scan.details);
    if (scan.notes) notes.push(...scan.notes);
  } else {
    add(30, "No contract security data available (common for brand-new tokens)");
    rows.push("🔒 LP lock: unavailable ❔");
  }

  // RugCheck (Solana)
  if (!isEvm && rc) {
    if (typeof rc.score_normalised === "number") {
      rows.push(`🛡 RugCheck risk: ${rc.score_normalised}/100 (higher = riskier)`);
      if (rc.score_normalised >= 60) add(10, "RugCheck rates this token as high risk");
    }
    const risks = Array.isArray(rc.risks) ? rc.risks : [];
    risks.filter((r) => r && r.level === "danger").slice(0, 4).forEach((r) => add(0, `RugCheck: ${r.name}`));
    const warns = risks.filter((r) => r && r.level === "warn").map((r) => r.name);
    if (warns.length) details.push(`RugCheck warnings: ${warns.join(", ")}`);
  }

  if (isEvm && hp && hp.summary && hp.summary.risk) details.push(`Honeypot.is rating: ${hp.summary.risk}`);
  details.push(
    "Sources: DexScreener ✅ · GoPlus " + (sec ? "✅" : "❌") +
      (isEvm ? (hpChain ? ` · Honeypot.is ${hp ? "✅" : "❌"}` : "") : ` · RugCheck ${rc ? "✅" : "❌"}`)
  );
  details.push(...notes);

  score = Math.min(score, 100);
  const level = score >= 60 ? "🔴 HIGH RISK" : score >= 30 ? "🟠 MEDIUM RISK" : "🟢 LOWER RISK";
  const trade = tradeButtons(pair, address, isEvm, score, honeypot);

  // ----- build the message (HTML) -----
  const blocks = [];
  blocks.push(`🔎 <b>${esc(symbol)}</b> · ${esc(chainLabel)}\n$${esc(pair.priceUsd || "n/a")} · Liq ${usd(liquidity)} · Age ${ageText(ageHours)}`);
  blocks.push(`<b>${level} · ${score}/100</b>`);
  blocks.push(rows.map(esc).join("\n"));
  blocks.push(flags.length ? flags.map((f) => "⚠️ " + esc(f)).join("\n") : "✅ No major red flags found");
  if (honeypot) blocks.push("🚫 <i>Trade buttons hidden: this token was flagged as a honeypot.</i>");
  blocks.push(`<blockquote expandable><b>📋 Details</b>\n${esc(details.join("\n"))}</blockquote>`);

  if (trade.hasBots) {
    blocks.push(
      `💱 <b>Trade in Telegram</b>\nTap a bot below and paste this address:\n<code>${esc(address)}</code>\n` +
        "<i>Third-party bots: you create a wallet inside them, so only fund what you can afford to lose. Links may include our referral code, which supports Blockrugbot. We never handle your funds.</i>"
    );
  } else if (trade.hasTrade) {
    blocks.push("<i>Trade buttons open the DEX's own website. Blockrugbot never handles your funds.</i>");
  }
  blocks.push("<i>Automated check, not financial advice. A low score does not mean a token is safe.</i>");

  return {
    text: blocks.join("\n\n"),
    buttons: [...trade.rows, ...verifyButtons(pair, address, isEvm)],
  };
}

// ---------- Database (Supabase) ----------
async function db(fn, body) {
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const key = (process.env.SUPABASE_SECRET_KEY || "").trim();
  if (!url) return { ok: false, error: "SUPABASE_URL is missing in Vercel." };
  if (!key) return { ok: false, error: "SUPABASE_SECRET_KEY is missing in Vercel." };
  if (key.startsWith("sb_publishable_")) {
    return { ok: false, error: "SUPABASE_SECRET_KEY holds the publishable key. Use the key that starts with sb_secret_." };
  }
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (e) {
    return { ok: false, error: `Could not reach Supabase (${e.message}). Check SUPABASE_URL.` };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Bot is running");

  // Only accept requests that really come from Telegram
  const secret = process.env.WEBHOOK_SECRET;
  const verified = Boolean(secret) && req.headers["x-telegram-bot-api-secret-token"] === secret;
  if (secret && !verified) return res.status(401).send("unauthorized");

  const message = req.body && req.body.message;
  if (message && message.text) {
    const chatId = message.chat.id;
    const from = message.from || {};
    const text = message.text;
    const cmd = text.startsWith("/") ? text.split(/[\s@]/)[0].toLowerCase() : null;
    const evm = text.match(/0x[a-fA-F0-9]{40}/);
    const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const target = evm ? evm[0] : sol ? sol[0] : null;
    const isAdmin =
      verified && Boolean(process.env.ADMIN_ID) && String(from.id) === String(process.env.ADMIN_ID);

    // Record the user (runs while we build the reply)
    const tracking = from.id
      ? db("track_user", {
          p_id: from.id,
          p_username: from.username || null,
          p_first_name: from.first_name || null,
          p_scan: Boolean(target) && cmd !== "/feedback",
        }).then((r) => {
          if (!r.ok) console.error("track_user failed:", r.error);
          return r;
        })
      : Promise.resolve(null);

    try {
      if (cmd === "/myid") {
        await send(chatId, `Your Telegram ID: ${from.id}`);
      } else if (cmd === "/stats" && isAdmin) {
        await tracking;
        const r = await db("bot_stats");
        if (!r.ok) {
          await send(chatId, `Stats unavailable.\n${r.error}`);
        } else {
          const s = r.data;
          await send(
            chatId,
            `📊 Blockrugbot stats\n\nTotal users: ${s.total_users}\nNew (24h): ${s.new_24h}\nActive (24h): ${s.active_24h}\nActive (7 days): ${s.active_7d}\nTotal scans: ${s.total_scans}`
          );
        }
      } else if (cmd === "/refcheck" && isAdmin) {
        const lines = TRADE_BOTS.map(
          (b) => `${b.emoji} ${b.name}: ${botLink(b, "ethereum") ? "set ✅" : "missing ❌"} (separate Solana link: ${process.env[b.solEnv] ? "set ✅" : "not set"})`
        );
        await send(chatId, "Referral links in Vercel:\n\n" + lines.join("\n"));
      } else if (cmd === "/start") {
        await send(chatId, "Welcome to Blockrugbot 🛡️\n\nSend me a token contract address and I'll scan it for rug-pull red flags: liquidity lock, ownership or authorities, holders and contract risks.\n\nTap the Menu button or send /help to see everything I can do.");
      } else if (cmd === "/help") {
        await send(chatId, "How to use Blockrugbot 🛡️\n\n1. Send a token contract address, or use /scan followed by the address.\n2. I check the liquidity lock, contract controls, holders and known scam patterns using several data sources.\n3. You get a risk score from 0 to 100, buttons to verify everything yourself, and buttons to trade in Telegram.\n\nScore guide:\n🟢 0-29 lower risk\n🟠 30-59 medium risk\n🔴 60-100 high risk\n\nA low score does not mean a token is safe. This is not financial advice. Trade buttons open third-party bots and may include our referral code.\n\nCommands:\n/scan - scan a token\n/chains - supported blockchains\n/feedback - send us a suggestion or bug report\n/help - this message");
      } else if (cmd === "/chains") {
        await send(chatId, "Supported chains:\n\n• Ethereum\n• BNB Chain (BSC)\n• Base\n• Arbitrum\n• Polygon\n• Robinhood Chain\n• Solana\n\nSend any token address from these chains.");
      } else if (cmd === "/feedback") {
        const note = text.replace(/^\/feedback(@\w+)?\s*/i, "").trim().slice(0, 1000);
        if (!note) {
          await send(chatId, "Tell me what you think. Send your message after the command, for example:\n/feedback Please add Optimism support");
        } else if (!process.env.ADMIN_ID) {
          await send(chatId, "Feedback isn't available right now. Please try again later.");
        } else {
          const who = from.username ? `@${from.username}` : from.first_name || "unknown";
          await send(process.env.ADMIN_ID, `📩 Feedback from ${who} (ID ${from.id}):\n\n${note}`);
          await send(chatId, "Thanks! Your feedback was sent to the team 🙏");
        }
      } else if (target) {
        const result = await checkToken(target);
        await send(chatId, result.text, result.buttons, true);
      } else if (cmd === "/scan") {
        await send(chatId, "Send the command with a token address, for example:\n/scan 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      } else {
        await send(chatId, "Send me a token contract address (0x... or a Solana address) to check it, or tap the Menu button to see my commands.");
      }
    } catch (err) {
      await send(chatId, "Something went wrong while checking that token. Please try again in a moment.");
    }
    await tracking;
  }
  res.status(200).send("ok");
};
