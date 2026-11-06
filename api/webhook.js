const CHAIN_IDS = { ethereum: "1", bsc: "56", base: "8453", arbitrum: "42161", polygon: "137" };

async function send(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

const num = (x) => parseFloat(x || "0") || 0;

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
  const liquidity = (pair.liquidity && pair.liquidity.usd) || 0;
  const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 36e5 : null;

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

  if (!sec) {
    add(30, "No contract security data available yet (common for brand-new tokens)");
  } else {
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
    if (num(sec.creator_percent) > 0.2) add(15, `Creator holds ${(num(sec.creator_percent) * 100).toFixed(0)}% of supply`);
  }

  score = Math.min(score, 100);
  const level = score >= 60 ? "🔴 HIGH RISK" : score >= 30 ? "🟠 MEDIUM RISK" : "🟢 LOWER RISK";
  const symbol = pair.baseToken ? pair.baseToken.symbol : "?";

  let msg = `🔎 ${symbol} on ${pair.chainId}\n`;
  msg += `Price: $${pair.priceUsd || "n/a"}\n`;
  msg += `Liquidity: $${Math.round(liquidity).toLocaleString()}\n`;
  if (ageHours !== null) msg += `Pair age: ${ageHours < 48 ? ageHours.toFixed(1) + " hours" : Math.round(ageHours / 24) + " days"}\n`;
  msg += `\n${level} (${score}/100)\n`;
  msg += flags.length ? "\n⚠️ " + flags.join("\n⚠️ ") : "\nNo major red flags found.";
  msg += "\n\nThis is an automated check, not financial advice. A low score does not mean a token is safe.";
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
        await send(chatId, "Welcome to Blockrugbot 🛡️\n\nSend me a token contract address (starts with 0x) and I'll scan it for rug-pull red flags.\n\nSupports Ethereum, BSC, Base, Arbitrum and Polygon.");
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
