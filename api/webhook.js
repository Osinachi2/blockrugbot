module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("Bot is running");
  }

  const message = req.body && req.body.message;

  if (message && message.text) {
    const reply =
      message.text === "/start"
        ? "Bot is live! 🚀"
        : `You said: ${message.text}`;

    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: message.chat.id, text: reply }),
    });
  }

  res.status(200).send("ok");
};
