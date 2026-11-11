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

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(chatId, text, buttons, address) {
  const payload = { chat_id: chatId, text, disable_web_page_preview: true };
  if (address) {
    // makes the token address tap-to-copy
    payload.text = escapeHtml(text).replace("{{ADDR}}", `<code>${address}</code>`);
    payload.parse_mode = "HTML";
  }
  if (buttons && buttons.length) payload.reply_markup = { inline_keyboard: buttons };
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const num = (x) => parseFloat(x || "0") || 0;
const pct = (x) => (x * 100).toFixed(1) + "%";
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const known = (v) => v !== undefined && v !== null && v !== "";
const taxText = (v) => (known(v) ? (num(v) * 100).toFixed(1) + "%" : "unknown");

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

function lockReport(lp, add) {
  const total = lp.locked + lp.burned;
  let text = `Locked or burned: ${pct(total)} of LP (top LP holders)\n`;
  text += `  Burned: ${pct(lp.burned)}\n  Locked: ${pct(lp.locked)}\n`;
  if (lp.soonest) {
    const days = Math.round((lp.soonest - Date.now()) / 864e5);
    text += days < 0
      ? `Soonest unlock: ${fmtDate(lp.soonest)} (already passed)\n`
      : `Soonest unlock: ${fmtDate(lp.soonest)} (in ${days} days)\n`;
    if (lp.latest && lp.latest !== lp.soonest) {
      text += `Latest unlock: ${fmtDate(lp.latest)} (in ${Math.round((lp.latest - Date.now()) / 864e5)} days)\n`;
    }
    if (days <= 30) add(20, "Part of the liquidity unlocks within 30 days (or already has)");
  } else if (lp.locked > 0) {
    text += "Unlock date not available\n";
  }
  if (total < 0.5) add(25, `Only ${pct(total)} of liquidity is locked or burned`);
  return text;
}

const LOCK_UNKNOWN =
  "Could not read LP lock data. This is common with concentrated-liquidity pools (Uniswap V3/V4 style). Verify the lock manually using the links below.\n";

// ---------- EVM scan (Ethereum, BSC, Base, Arbitrum, Polygon, Robinhood Chain) ----------
function scanEvm(sec, chain, add) {
  const notes = [];

  if (sec.is_honeypot === "1") add(100, "HONEYPOT: you may not be able to sell");
  if (num(sec.sell_tax) > 0.1) add(30, `High sell tax (${(num(sec.sell_tax) * 100).toFixed(0)}%)`);
  if (num(sec.buy_tax) > 0.1) add(15, `High buy tax (${(num(sec.buy_tax) * 100).toFixed(0)}%)`);
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

  if (chain === "robinhood" && (sec.is_honeypot === "1" || sec.hidden_owner === "1" || sec.owner_change_balance === "1")) {
    notes.push("Note: GoPlus has been reported to flag some Uniswap-factory tokens on Robinhood Chain as honeypot or hidden-owner because of a default Permit2 allowance. Confirm with the links below before trusting these flags.");
  }

  let lock = "\n🔒 LIQUIDITY LOCK\n";
  const lp = analyzeLiquidity(sec.lp_holders);
  if (!lp) {
    lock += LOCK_UNKNOWN;
    add(10, "Liquidity lock could not be verified");
  } else {
    lock += lockReport(lp, add);
  }

  const ownerAddr = (sec.owner_address || "").toLowerCase();
  const renounced = !ownerAddr || BURN.includes(ownerAddr);
  let owner = "\n👤 CONTRACT\n";
  owner += renounced ? "Ownership: renounced / no owner ✅\n" : `Ownership: NOT renounced (owner ${short(ownerAddr)})\n`;
  owner += `Code verified: ${sec.is_open_source === "1" ? "yes ✅" : "no ❌"}\n`;
  owner += `Mintable: ${sec.is_mintable === "1" ? "yes ⚠️" : "no"}\n`;
  owner += `Upgradeable proxy: ${sec.is_proxy === "1" ? "yes ⚠️" : "no"}\n`;
  owner += `Buy / sell tax: ${taxText(sec.buy_tax)} / ${taxText(sec.sell_tax)}\n`;

  const holdersList = (sec.holders || []).filter((h) => !isBurn(h));
  const top10 = holdersList.slice(0, 10).reduce((sum, h) => sum + num(h.percent), 0);
  let holders = "\n👥 HOLDERS\n";
  if (sec.holder_count) holders += `Total holders: ${Number(sec.holder_count).toLocaleString()}\n`;
  if (holdersList.length) {
    holders += `Top 10 holders own: ${pct(top10)} (may include pools and exchanges)\n`;
    if (top10 > 0.5) add(15, `Top 10 holders own ${pct(top10)} of supply`);
  }
  if (sec.creator_percent) holders += `Creator holds: ${pct(num(sec.creator_percent))}\n`;

  return { lock, owner, holders, notes };
}

// ---------- Solana scan ----------
function scanSolana(sec, add) {
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

  let lock = "\n🔒 LIQUIDITY LOCK\n";
  const dexes = Array.isArray(sec.dex) ? [...sec.dex].sort((a, b) => num(b.tvl) - num(a.tvl)) : [];
  const lp = dexes.length ? analyzeLiquidity(dexes[0].lp_holders) : null;
  if (!lp) {
    lock += LOCK_UNKNOWN;
    add(10, "Liquidity lock could not be verified");
  } else {
    lock += lockReport(lp, add);
  }

  const yes = (field) => (on(field) ? "ACTIVE ⚠️" : "revoked ✅");
  let owner = "\n👤 TOKEN CONTROLS\n";
  owner += `Mint authority: ${yes("mintable")}\n`;
  owner += `Freeze authority: ${yes("freezable")}\n`;
  owner += `Can close program: ${on("closable") ? "yes ⚠️" : "no"}\n`;
  owner += `Can change balances: ${on("balance_mutable_authority") ? "yes ⚠️" : "no"}\n`;
  owner += `Metadata can be changed: ${on("metadata_mutable") ? "yes" : "no"}\n`;

  // unlabeled wallets only (skips burn, lockers and tagged pools/entities)
  const holdersList = (sec.holders || []).filter((h) => !isBurn(h) && !h.tag && Number(h.is_locked) !== 1);
  const top10 = holdersList.slice(0, 10).reduce((sum, h) => sum + num(h.percent), 0);
  let holders = "\n👥 HOLDERS\n";
  if (sec.holder_count) holders += `Total holders: ${Number(sec.holder_count).toLocaleString()}\n`;
  if (holdersList.length) {
    holders += `Top 10 unlabeled wallets own: ${pct(top10)}\n`;
    holders += `Largest unlabeled wallet: ${pct(num(holdersList[0].percent))}\n`;
    if (top10 > 0.5) add(15, `Top 10 unlabeled wallets own ${pct(top10)} of supply`);
  }

  return { lock, owner, holders, notes };
}

// ---------- Trade and chart buttons ----------
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
  if (pair.url) rows.push([{ text: "📈 Chart on DexScreener", url: pair.url }]);
  return { rows, hasBots, hasTrade };
}

async function checkToken(address) {
  const isEvm = address.startsWith("0x");

  // 1. DexScreener: find the token's trading pairs
  const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const dex = await dexRes.json();
  let pairs = (dex.pairs || []).filter((p) => (isEvm ? EVM_CHAINS[p.chainId] : p.chainId === "solana"));

  // prefer pairs where this token is the main (base) token
  const mine = pairs.filter(
    (p) => p.baseToken && p.baseToken.address && p.baseToken.address.toLowerCase() === address.toLowerCase()
  );
  if (mine.length) pairs = mine;

  if (pairs.length === 0) {
    return {
      text: "I couldn't find this token on Ethereum, BSC, Base, Arbitrum, Polygon, Robinhood Chain or Solana. Check the address and try again.",
      buttons: [],
      address: null,
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

  if (liquidity < 10000) add(20, `Low liquidity ($${Math.round(liquidity).toLocaleString()})`);
  if (ageHours !== null && ageHours < 24) add(15, "Trading pair is less than 24 hours old");

  // 2. GoPlus: contract security scan
  const evmChainId = EVM_CHAINS[pair.chainId];
  const gpUrl = isEvm
    ? `https://api.gopluslabs.io/api/v1/token_security/${evmChainId}?contract_addresses=${address}`
    : `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`;

  let sec = null;
  try {
    const gpRes = await fetch(gpUrl);
    const gp = await gpRes.json();
    sec = (gp.result && (gp.result[address] || gp.result[address.toLowerCase()])) || null;
  } catch (e) {
    sec = null;
  }

  let sections = { lock: "", owner: "", holders: "", notes: [] };
  if (!sec) {
    add(30, "No contract security data available (common for brand-new tokens)");
    sections.lock = "\n🔒 LIQUIDITY LOCK\nUnavailable (no contract data)\n";
  } else {
    sections = isEvm ? scanEvm(sec, pair.chainId, add) : scanSolana(sec, add);
  }

  score = Math.min(score, 100);
  const honeypot = flags.some((f) => f.startsWith("HONEYPOT"));
  const level = score >= 60 ? "🔴 HIGH RISK" : score >= 30 ? "🟠 MEDIUM RISK" : "🟢 LOWER RISK";
  const trade = tradeButtons(pair, address, isEvm, score, honeypot);

  let msg = `🔎 ${symbol} on ${chainLabel}\n`;
  msg += `Price: $${pair.priceUsd || "n/a"}\n`;
  msg += `Liquidity: $${Math.round(liquidity).toLocaleString()}\n`;
  if (ageHours !== null) msg += `Pair age: ${ageHours < 48 ? ageHours.toFixed(1) + " hours" : Math.round(ageHours / 24) + " days"}\n`;
  msg += sections.lock + sections.owner + sections.holders;
  msg += `\n${level} (${score}/100)\n`;
  msg += flags.length ? "⚠️ " + flags.join("\n⚠️ ") : "No major red flags found.";
  if (sections.notes.length) msg += "\n\n" + sections.notes.join("\n");
  if (honeypot) msg += "\n\n🚫 Trade buttons hidden: this token was flagged as a honeypot.";

  msg += "\n\n🔗 VERIFY YOURSELF\n";
  if (isEvm) {
    const ex = EXPLORERS[pair.chainId];
    if (ex) {
      msg += `Contract: ${ex}/token/${address}\n`;
      msg += `Holders: ${ex}/token/${address}${pair.chainId === "robinhood" ? "?tab=holders" : "#balances"}\n`;
      if (pair.pairAddress && pair.pairAddress.length === 42) msg += `Pool: ${ex}/address/${pair.pairAddress}\n`;
    }
    msg += `Security scan: https://gopluslabs.io/token-security/${evmChainId}/${address}\n`;
  } else {
    msg += `Token: https://solscan.io/token/${address}\n`;
    msg += `Holders: https://solscan.io/token/${address}#holders\n`;
    if (pair.pairAddress) msg += `Pool: https://solscan.io/account/${pair.pairAddress}\n`;
    msg += `Second opinion: https://rugcheck.xyz/tokens/${address}\n`;
  }

  if (trade.hasBots) {
    msg += "\n💱 TRADE IN TELEGRAM\nTap a bot below, then paste this token address:\n{{ADDR}}\n";
    msg += "These are third-party bots: you create a wallet inside them, so only fund what you can afford to lose. The links may include our referral code, which supports Blockrugbot. We never handle your funds.\n";
  } else if (trade.hasTrade) {
    msg += "\nTrade buttons open the DEX's own website. Blockrugbot never handles your funds.\n";
  }
  msg += "\nAutomated check, not financial advice. A low score does not mean a token is safe.";
  return { text: msg, buttons: trade.rows, address: trade.hasBots ? address : null };
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
        await send(chatId, "How to use Blockrugbot 🛡️\n\n1. Send a token contract address, or use /scan followed by the address.\n2. I check the liquidity lock, contract controls, holders and known scam patterns.\n3. You get a risk score from 0 to 100, links to verify everything yourself, and buttons to trade in Telegram.\n\nScore guide:\n🟢 0-29 lower risk\n🟠 30-59 medium risk\n🔴 60-100 high risk\n\nA low score does not mean a token is safe. This is not financial advice. Trade buttons open third-party bots and may include our referral code.\n\nCommands:\n/scan - scan a token\n/chains - supported blockchains\n/feedback - send us a suggestion or bug report\n/help - this message");
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
        await send(chatId, result.text, result.buttons, result.address);
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
