// Telegram bot implementation for DonationParserBot
// Usage: node telegram_bot.js

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const {
  processTelegramRequest,
  saveCSVForTelegram,
  saveXLSXForTelegram,
  cleanupTempFiles,
} = require("./forum_donation_scraper");

// Replace with your actual Telegram bot token
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN_HERE";

if (TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  console.error("Please set your TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Command: /donations <search_terms>
bot.onText(/\/donations (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const searchTerms = match[1].trim();
  const forumUrl = "https://forum.zooshans.by/viewtopic.php?f=15&t=54158";

  bot.sendMessage(chatId, "🔄 Собираю данные, пожалуйста, подождите...");

  try {
    const result = await processTelegramRequest(forumUrl, searchTerms);
    if (!result.success) {
      await bot.sendMessage(chatId, result.summaryMessage, {
        parse_mode: "Markdown",
      });
      return;
    }

    // Save CSV file
    const saveResult = await saveXLSXForTelegram(
      result.xslxContent,
      searchTerms
    );
    if (!saveResult.success) {
      await bot.sendMessage(
        chatId,
        "❌ Ошибка при сохранении XLSX файла: " + saveResult.error
      );
      return;
    }

    // Send summary and CSV file
    await bot.sendMessage(chatId, result.summaryMessage, {
      parse_mode: "Markdown",
    });
    await bot.sendDocument(chatId, saveResult.filePath);
  } catch (error) {
    await bot.sendMessage(chatId, "❌ Произошла ошибка: " + error.message);
  }
});

// Optional: /cleanup command to clean old temp files
bot.onText(/\/cleanup/, async (msg) => {
  const chatId = msg.chat.id;
  await cleanupTempFiles();
  bot.sendMessage(chatId, "🧹 Временные файлы очищены.");
});

// Help command
bot.onText(/\/start|\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `👋 Я бот для сбора пожертвований с форума!

Использование:
/donations <поисковые_слова>

Пример:
/donations лошади,сено

Я скачаю пожертвования, отфильтрую по комментариям и пришлю отчет в XLSX.`
  );
});

console.log("Telegram bot started!");
