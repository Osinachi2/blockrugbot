const CHAIN_IDS = { ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137" };

const EXPLORERS = {
  ethereum: "https://etherscan.io",
  bsc: "https://bscscan.com",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
  polygon: "https://polygonscan.com",
};

const BURN = [
  "0x000000000000000000000000000000000000dead",
  "0x0000000000000000000000000000000000000000",
];

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

const num = (x) => parseFloat(x || "0") || 0;
const pct = (x) => (x * 100).toFixed(1) + "%";
const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

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
    const addr = (h.address || "").toLowerCase();
    if (BURN.includes(addr)) {
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

async function checkToken(address) {
  // 1. DexScreener: find the token's trading pairs
  const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const dex = await dexRes.json();
  const pairs = (dex.pairs || []).filter((p) => CHAIN_IDS[p.chainId]);

  if (pairs.length === 0) {
    return "I couldn't find this token on Ethereum, BSC, Base, Arbitrum or Polygon. Check the address and try again.";
  }

  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const pair = pairs[0];
  const chainId = CHAIN_IDS[pair.chainId];
  const explorer = EXPLORERS[pair.chainId];
  const liquidity = (pair.liquidity && pair.liquidity.usd) || 0;
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 36e5 : null;
  const symbol = pair.baseToken ? pair.baseToken.symbol : "?";

  let score = 0;
  const flags = [];
  const add = (points, text) => { score += points; flags.push(text); };

  if (liquidity < 10000) add(20, `Low liquidity ($${Math.round(liquidity).toLocaleString()})`);
  if (ageHours !== null && ageHours < 24) add(15, "Trading pair is less than 24 hours old");

  // 2. GoPlus: contract security scan
  const gpRes = await fetch(
    `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${address}`
  );
  const gp = await gpRes.json();
  const sec = gp.result && gp.result[address.toLowerCase()];

  let lockText = "\n🔒 LIQUIDITY LOCK\n";
  let ownerText = "";
  let holderText = "";

  if (!sec) {
    add(30, "No contract security data available yet (common for brand-new tokens)");
    lockText += "Unavailable (no contract data yet)\n";
  } else {
    // Contract risk flags
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

    // Liquidity lock details
    const lp = analyzeLiquidity(sec.lp_holders);
    if (!lp) {
      lockText += "Could not read LP lock data. This is common with V3-style (concentrated liquidity) pools. Verify the lock manually using the links below.\n";
      add(10, "Liquidity lock could not be verified");
    } else {
      const total = lp.locked + lp.burned;
      lockText += `Locked or burned: ${pct(total)} of LP (top LP holders)\n`;
      lockText += `  Burned: ${pct(lp.burned)}\n  Locked: ${pct(lp.locked)}\n`;
      if (lp.soonest) {
        const days = Math.round((lp.soonest - Date.now()) / 864e5);
        lockText += days < 0
          ? `Soonest unlock: ${fmtDate(lp.soonest)} (already passed)\n`
          : `Soonest unlock: ${fmtDate(lp.soonest)} (in ${days} days)\n`;
        if (lp.latest && lp.latest !== lp.soonest) {
          lockText += `Latest unlock: ${fmtDate(lp.latest)} (in ${Math.round((lp.latest - Date.now()) / 864e5)} days)\n`;
        }
        if (days <= 30) add(20, "Part of the liquidity unlocks within 30 days (or already has)");
      } else if (lp.locked > 0) {
        lockText += "Unlock date not available\n";
      }
      if (total < 0.5) add(25, `Only ${pct(total)} of liquidity is locked or burned`);
    }

    // Ownership
    const owner = (sec.owner_address || "").toLowerCase();
    const renounced = !owner || BURN.includes(owner);
    ownerText = "\n👤 CONTRACT\n";
    ownerText += renounced ? "Ownership: renounced / no owner ✅\n" : `Ownership: NOT renounced (owner ${short(owner)})\n`;
    ownerText += `Code verified: ${sec.is_open_source === "1" ? "yes ✅" : "no ❌"}\n`;
    ownerText += `Mintable: ${sec.is_mintable === "1" ? "yes ⚠️" : "no"}\n`;
    ownerText += `Upgradeable proxy: ${sec.is_proxy === "1" ? "yes ⚠️" : "no"}\n`;
    ownerText += `Buy / sell tax: ${(num(sec.buy_tax) * 100).toFixed(1)}% / ${(num(sec.sell_tax) * 100).toFixed(1)}%\n`;

    // Holders
    const holders = (sec.holders || []).filter((h) => !BURN.includes((h.address || "").toLowerCase()));
    const top10 = holders.slice(0, 10).reduce((sum, h) => sum + num(h.percent), 0);
    holderText = "\n👥 HOLDERS\n";
    if (sec.holder_count) holderText += `Total holders: ${Number(sec.holder_count).toLocaleString()}\n`;
    if (holders.length) {
      holderText += `Top 10 holders own: ${pct(top10)} (may include pools and exchanges)\n`;
      if (top10 > 0.5) add(15, `Top 10 holders own ${pct(top10)} of supply`);
    }
    if (sec.creator_percent) holderText += `Creator holds: ${pct(num(sec.creator_percent))}\n`;
  }

  score = Math.min(score, 100);
  const level = score >= 60 ? "🔴 HIGH RISK" : score >= 30 ? "🟠 MEDIUM RISK" : "🟢 LOWER RISK";

  let msg = `🔎 ${symbol} on ${pair.chainId}\n`;
  msg += `Price: $${pair.priceUsd || "n/a"}\n`;
  msg += `Liquidity: $${Math.round(liquidity).toLocaleString()}\n`;
  if (ageHours !== null) msg += `Pair age: ${ageHours < 48 ? ageHours.toFixed(1) + " hours" : Math.round(ageHours / 24) + " days"}\n`;
  msg += lockText + ownerText + holderText;
  msg += `\n${level} (${score}/100)\n`;
  msg += flags.length ? "⚠️ " + flags.join("\n⚠️ ") : "No major red flags found.";

  msg += "\n\n🔗 VERIFY YOURSELF\n";
  if (explorer) {
    msg += `Contract: ${explorer}/token/${address}\n`;
    msg += `Holders: ${explorer}/token/${address}#balances\n`;
    if (pair.pairAddress) msg += `Pool contract: ${explorer}/address/${pair.pairAddress}\n`;
  }
  if (pair.url) msg += `Chart and liquidity: ${pair.url}\n`;
  msg += `Security scan: https://gopluslabs.io/token-security/${chainId}/${address}\n`;

  msg += "\nAutomated check, not financial advice. A low score does not mean a token is safe.";
  return msg;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("Bot is running");

  const message = req.body && req.body.message;
  if (message && message.text) {
    const chatId = message.chat.id;
    const text = message.text;
    const match = text.match(/0x[a-fA-F0-9]{40}/);

    try {
      if (text.startsWith("/start")) {
        await send(chatId, "Welcome to Blockrugbot 🛡️\n\nSend me a token contract address (starts with 0x) and I'll scan it for rug-pull red flags: liquidity lock, ownership, holders and contract risks.\n\nSupports Ethereum, BSC, Base, Arbitrum and Polygon.");
      } else if (match) {
        await send(chatId, await checkToken(match[0]));
      } else {
        await send(chatId, "Send me a token contract address (0x...) to check it.");
      }
    } catch (err) {
      await send(chatId, "Something went wrong while checking that token. Please try again in a moment.");
    }
  }
  res.status(200).send("ok");
};
