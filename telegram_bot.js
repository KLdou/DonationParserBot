// Telegram bot implementation for DonationParserBot
// Usage: node telegram_bot.js

require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");
const {
  processTelegramRequest,
  saveXLSXForTelegram,
  cleanupTempFiles,
} = require("./forum_donation_scraper_cheerio");

// Replace with your actual Telegram bot token
const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || "YOUR_TELEGRAM_BOT_TOKEN_HERE";

if (TELEGRAM_BOT_TOKEN === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  console.error("Please set your TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

// Оптимизация polling для слабого VPS
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { 
  polling: {
    interval: 2000,        // Проверка каждые 2 секунды (вместо 300ms по умолчанию)
    autoStart: true,
    params: {
      timeout: 10          // Long polling timeout (секунды)
    }
  }
});

// Forum URLs by year
const FORUM_URLS = {
  2025: "https://forum.zooshans.by/viewtopic.php?f=15&t=54158",
  2026: "https://forum.zooshans.by/viewtopic.php?f=15&t=56081",
};
const DEFAULT_YEAR = 2026;

// Command: /donations [year] <search_terms>
bot.onText(/\/donations (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();
  
  // Check if first word is a year (2025 or 2026)
  const parts = input.split(/\s+/);
  let year = DEFAULT_YEAR;
  let searchTerms = input;
  
  if (parts[0] === "2025" || parts[0] === "2026") {
    year = parseInt(parts[0]);
    searchTerms = parts.slice(1).join(" ");
  }
  
  if (!searchTerms) {
    bot.sendMessage(chatId, "❌ Пожалуйста, укажите поисковые слова после года.");
    return;
  }
  
  const forumUrl = FORUM_URLS[year];

  bot.sendMessage(chatId, `🔄 Собираю данные за ${year} год, пожалуйста, подождите...`);

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
/donations [год] <поисковые_слова>

Примеры:
/donations лошади,сено
/donations 2025 лошади,сено
/donations 2026 кошки

Поддерживаемые года: 2025, 2026
По умолчанию используется 2026 год.

Я скачаю пожертвования, отфильтрую по комментариям и пришлю отчет в XLSX.`
  );
});

console.log("Telegram bot started!");

// Graceful shutdown для освобождения ресурсов на слабом VPS
process.on('SIGINT', async () => {
  console.log('\n🛑 Получен сигнал остановки (SIGINT), завершаю работу...');
  try {
    await bot.stopPolling();
    await cleanupTempFiles();
    console.log('✅ Бот корректно остановлен');
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка при остановке:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Получен сигнал остановки (SIGTERM), завершаю работу...');
  try {
    await bot.stopPolling();
    await cleanupTempFiles();
    console.log('✅ Бот корректно остановлен');
    process.exit(0);
  } catch (error) {
    console.error('❌ Ошибка при остановке:', error);
    process.exit(1);
  }
});

// Обработка необработанных ошибок
process.on('uncaughtException', (error) => {
  console.error('❌ Необработанное исключение:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Необработанный reject промиса:', reason);
});

