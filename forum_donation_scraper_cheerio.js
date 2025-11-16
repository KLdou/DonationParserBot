const fs = require("fs").promises;
const http = require("http");
const https = require("https");
const XLSX = require("xlsx");
const axios = require("axios");
const cheerio = require("cheerio");

class ForumDonationScraper {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.options = {
      delay: options.delay || 500,
      maxPages: options.maxPages || null,
      cacheTtl: options.cacheTtl || 1800000,
      userAgent: options.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      timeout: options.timeout || 30000,
      maxRetries: options.maxRetries || 3,
      ...options,
    };
    this.donations = [];
    this._cache = { donations: null, timestamp: 0, xlsx: null };
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
  }

  parseDonationMessage(messageText) {
    const text = messageText.trim().replace(/\s+/g, " ");
    const donationPattern = /(ЕРИП|WebPay)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(.*?)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+BYN/;
    const match = text.match(donationPattern);
    if (!match) return null;
    let [,
      paymentMethod,
      date,
      time,
      commentPart,
      grossAmount,
      tax,
      netAmount,
    ] = match;
    let comment = commentPart.trim();
    comment = comment.replace(/\s+\d+\.?\d*(\s+\d+\.?\d*)*\s*$/, "").trim();
    if (!comment) comment = null;
    return {
      paymentMethod,
      date,
      time,
      dateTime: `${date} ${time}`,
      comment,
      grossAmount: parseFloat(grossAmount),
      tax: parseFloat(tax),
      netAmount: parseFloat(netAmount),
      currency: "BYN",
    };
  }

  buildPageUrl(pageNumber) {
    let url = this.baseUrl;
    if (pageNumber > 1) {
      const startValue = (pageNumber - 1) * 20;
      if (url.includes("?")) {
        if (url.includes("start=")) url = url.replace(/start=\d+/, `start=${startValue}`);
        else url += `&start=${startValue}`;
      } else url += `?start=${startValue}`;
    }
    return url;
  }

  async fetchPageHtml(pageNumber) {
    const url = this.buildPageUrl(pageNumber);
    const retriableCodes = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);
    let attemptError = null;
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        const res = await axios.get(url, {
          timeout: this.options.timeout,
          headers: {
            "User-Agent": this.options.userAgent,
            Accept: "text/html",
            Connection: "keep-alive",
          },
          httpAgent: this.httpAgent,
          httpsAgent: this.httpsAgent,
          responseType: "text",
        });
        if (this.options.delay) await new Promise((r) => setTimeout(r, this.options.delay));
        return res.data;
      } catch (error) {
        attemptError = error;
        const code = error.code || (error.cause && error.cause.code);
        const message = error.message || "";
        const retriable = retriableCodes.has(code) || message.includes("socket hang up");
        if (attempt === this.options.maxRetries || !retriable) {
          const friendlyMessage = `Не удалось загрузить страницу форума (страница ${pageNumber}). ${message || code || "Неизвестная ошибка"}`;
          const finalError = new Error(friendlyMessage);
          finalError.code = code;
          throw finalError;
        }
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
    throw attemptError || new Error("Неизвестная ошибка загрузки страницы");
  }

  determineTotalPages(html) {
    const $ = cheerio.load(html);
    let maxPage = 1;
    $(".pagination ul li a").each((_, el) => {
      const text = $(el).text().trim();
      if (/^\d+$/.test(text)) {
        const num = parseInt(text, 10);
        if (num > maxPage) maxPage = num;
      }
      const href = $(el).attr("href");
      if (href) {
        const m = href.match(/start=(\d+)/);
        if (m) {
          const startValue = parseInt(m[1], 10);
          const p = Math.floor(startValue / 20) + 1;
          if (p > maxPage) maxPage = p;
        }
      }
    });
    const msg = $(".pagination .responsive-hide").text();
    const countMatch = msg.match(/(\d+)\s+сообщение/);
    if (countMatch) {
      const totalMessages = parseInt(countMatch[1], 10);
      const pagesFromCount = Math.ceil(totalMessages / 20);
      if (pagesFromCount > maxPage) maxPage = pagesFromCount;
    }
    return maxPage;
  }

  extractDonationsFromHtml(html) {
    const $ = cheerio.load(html);
    const results = [];
    $(".postbody .content, .post .content").each((_, el) => {
      const text = $(el).text();
      if (!text || (!text.includes("ЕРИП") && !text.includes("WebPay"))) return;
      text.split("\n").forEach((line) => {
        const cleanLine = line.trim();
        if (cleanLine && cleanLine.includes("BYN") && (cleanLine.includes("ЕРИП") || cleanLine.includes("WebPay"))) {
          const parsed = this.parseDonationMessage(cleanLine);
          if (parsed) results.push(parsed);
        }
      });
    });
    return results;
  }

  async scrapeAllDonations() {
    const now = Date.now();
    if (this._cache.donations && now - this._cache.timestamp < this.options.cacheTtl) {
      this.donations = this._cache.donations;
      return this.donations;
    }
    const firstHtml = await this.fetchPageHtml(1);
    const totalPages = this.determineTotalPages(firstHtml);
    const effectivePages = this.options.maxPages ? Math.min(totalPages, this.options.maxPages) : totalPages;
    this.donations = this.extractDonationsFromHtml(firstHtml);
    for (let pageNum = 2; pageNum <= effectivePages; pageNum++) {
      const html = await this.fetchPageHtml(pageNum);
      this.donations.push(...this.extractDonationsFromHtml(html));
    }
    this.donations.sort((a, b) => {
      const dateA = new Date(a.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1"));
      const dateB = new Date(b.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1"));
      return dateA - dateB;
    });
    this._cache.donations = this.donations;
    this._cache.timestamp = Date.now();
    this._cache.xlsx = this.generateXLSX(this.donations);
    return this.donations;
  }

  filterDonationsByComments(searchTerms) {
    if (!searchTerms || searchTerms.length === 0) return this.donations;
    return this.donations.filter((d) => d.comment && searchTerms.some((t) => d.comment.toLowerCase().includes(t.toLowerCase().trim())));
  }

  generateXLSX(donations) {
    const headers = ["Payment Method", "Date", "Time", "Comment", "Gross Amount", "Tax", "Net Amount", "Currency"];
    const data = donations.map((d) => [d.paymentMethod, d.date, d.time, d.comment || "", d.grossAmount, d.tax, d.netAmount, d.currency]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws["!cols"] = [{ wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Donations");
    return wb;
  }

  calculateTotals(donations) {
    return donations.reduce((tot, d) => {
      tot.count += 1;
      tot.grossAmount += d.grossAmount;
      tot.tax += d.tax;
      tot.netAmount += d.netAmount;
      return tot;
    }, { count: 0, grossAmount: 0, tax: 0, netAmount: 0 });
  }
}

let scraperInstance = null;
const requestQueue = [];
let isProcessingQueue = false;
async function processQueue() {
  if (isProcessingQueue || requestQueue.length === 0) return;
  isProcessingQueue = true;
  while (requestQueue.length) {
    const { task, resolve, reject } = requestQueue.shift();
    try { resolve(await task()); } catch (e) { reject(e); }
  }
  isProcessingQueue = false;
}

async function processTelegramRequest(forumUrl, searchTermsString, options = {}) {
  return new Promise((resolve, reject) => {
    const task = async () => {
      try {
        const searchTerms = searchTermsString.split(",").map((t) => t.trim()).filter(Boolean);
        if (!scraperInstance || scraperInstance.baseUrl !== forumUrl) {
          scraperInstance = new ForumDonationScraper(forumUrl, options);
        }
        await scraperInstance.scrapeAllDonations();
        const filtered = scraperInstance.filterDonationsByComments(searchTerms);
        const xslxContent = scraperInstance.generateXLSX(filtered);
        const totals = scraperInstance.calculateTotals(filtered);
        let latestDate = null;
        if (scraperInstance.donations.length) {
          latestDate = scraperInstance.donations.reduce((m, d) => {
            const dt = new Date(d.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1"));
            return !m || dt > m ? dt : m;
          }, null);
        }
        const latestDateStr = latestDate ? latestDate.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "нет данных";
        const summaryMessage = `📊 *Отчет по пожертвованиям*\n\n🔍 *Поиск по:* ${searchTerms.join(", ")}\n📈 *Найдено:* ${totals.count} пожертвований на ${latestDateStr}\n\n💰 *Общая сумма:* ${totals.grossAmount.toFixed(2)} BYN\n🏦 *Комиссия:* ${totals.tax.toFixed(2)} BYN\n💵 *К получению:* ${totals.netAmount.toFixed(2)} BYN\n\n📁 Подробный отчет в XLSX файле`;
        return { success: true, xslxContent, summaryMessage, totalDonations: totals.count, totals: { gross: totals.grossAmount, tax: totals.tax, net: totals.netAmount }, filteredDonations: filtered };
      } catch (e) {
        return { success: false, error: e.message, summaryMessage: `❌ Ошибка: ${e.message}` };
      }
    };
    requestQueue.push({ task, resolve, reject });
    processQueue();
  });
}


async function saveXLSXForTelegram(xlsxContent, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeBaseName = filename
      ? filename
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .join("_")
          .replace(/[<>:"/\\|?*]+/g, "_")
          .replace(/\s+/g, " ")
          .trim()
      : null;
    const fileName = safeBaseName && safeBaseName.length
      ? `${safeBaseName}.xlsx`
      : `donations_${timestamp}.xlsx`;
    const filePath = `./temp/${fileName}`;
    await fs.mkdir("./temp", { recursive: true });
    XLSX.writeFile(xlsxContent, filePath);
    return { success: true, filePath, fileName };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function cleanupTempFiles(olderThanMinutes = 60) {
  try {
    const tempDir = "./temp";
    const files = await fs.readdir(tempDir);
    const now = Date.now();
    for (const file of files) {
      const filePath = `${tempDir}/${file}`;
      const stats = await fs.stat(filePath);
      const ageMinutes = (now - stats.mtime.getTime()) / 60000;
      if (ageMinutes > olderThanMinutes) await fs.unlink(filePath);
    }
  } catch (_) {}
}

async function shutdownBrowser() { /* no-op */ }

module.exports = {
  ForumDonationScraper,
  processTelegramRequest,
  saveXLSXForTelegram,
  cleanupTempFiles,
  shutdownBrowser,
};
