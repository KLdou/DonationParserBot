const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const XLSX = require('xlsx');

class ForumDonationScraper {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.options = {
      headless: true,
      delay: 1000, // Delay between requests in ms
      ...options,
    };
    this.donations = [];
    this._cache = {
      donations: null,
      timestamp: 0,
    };
  }

  // Parse individual donation message
  parseDonationMessage(messageText) {
    // Remove extra whitespace and normalize, but preserve the structure
    const text = messageText.trim().replace(/\s+/g, " ");

    // Pattern to match donation messages based on your exact format:
    // ЕРИП    13.01.2025 13:46:08    К.Ю. (лошади сено) 30.00    0.06    29.94    BYN
    const donationPattern =
      /(ЕРИП|WebPay)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(.*?)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+BYN/;

    const match = text.match(donationPattern);

    if (match) {
      let [
        ,
        paymentMethod,
        date,
        time,
        commentPart,
        grossAmount,
        tax,
        netAmount,
      ] = match;

      // Clean up comment part - it should be everything between datetime and the first amount
      let comment = commentPart.trim();

      // Remove any stray numbers at the end that might be amounts
      comment = comment.replace(/\s+\d+\.?\d*(\s+\d+\.?\d*)*\s*$/, "").trim();

      // If comment is empty or just whitespace, set to null
      if (!comment || comment.length === 0) {
        comment = null;
      }

      return {
        paymentMethod,
        date,
        time,
        dateTime: `${date} ${time}`,
        comment: comment,
        grossAmount: parseFloat(grossAmount),
        tax: parseFloat(tax),
        netAmount: parseFloat(netAmount),
        currency: "BYN",
      };
    }

    return null;
  }

  // Extract donations from a single page
  async extractDonationsFromPage(page) {
    try {
      // Wait for phpBB forum content to load
      await page.waitForSelector(".postbody, .post, .content", {
        timeout: 10000,
      });

      // Extract all text content that might contain donations
      const donations = await page.evaluate(() => {
        // phpBB specific selectors for post content
        const selectors = [
          ".postbody .content", // phpBB 3.x post content
          ".post .content", // Alternative phpBB structure
          ".postbody", // Broader phpBB post body
          ".content", // Direct content selector
        ];

        const results = [];

        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            // Skip if this element is nested inside another already processed element
            let isNested = false;
            for (const otherSelector of selectors) {
              if (otherSelector !== selector) {
                const parent = element.closest(otherSelector);
                if (parent && parent !== element) {
                  isNested = true;
                  break;
                }
              }
            }

            if (isNested) continue;

            // Get the inner HTML to preserve line breaks
            const html = element.innerHTML;
            // Convert <br> tags to newlines for proper parsing
            const textWithBreaks = html.replace(/<br\s*\/?>/gi, "\n");
            // Remove other HTML tags
            const text = textWithBreaks.replace(/<[^>]*>/g, "");

            if (text && (text.includes("ЕРИП") || text.includes("WebPay"))) {
              // Split by lines and check each line
              const lines = text.split("\n");
              for (const line of lines) {
                const cleanLine = line.trim();
                if (
                  cleanLine &&
                  (cleanLine.includes("ЕРИП") || cleanLine.includes("WebPay"))
                ) {
                  // Make sure the line actually looks like a donation (has BYN at the end)
                  if (cleanLine.includes("BYN")) {
                    results.push(cleanLine);
                  }
                }
              }
            }
          }
        }

        // Remove duplicates
        return [...new Set(results)];
      });

      // Parse each potential donation message
      const pageDonations = [];
      for (const text of donations) {
        const parsed = this.parseDonationMessage(text);
        if (parsed) {
          pageDonations.push(parsed);
        }
      }

      return pageDonations;
    } catch (error) {
      console.error("Error extracting donations from page:", error.message);
      return [];
    }
  }

  // Get total number of pages
  async getTotalPages(page) {
    try {
      // Look for phpBB pagination structure
      const paginationInfo = await page.evaluate(() => {
        // First, check for the total messages count
        const messageCountElement = document.querySelector(
          ".pagination .responsive-hide"
        );
        let totalMessages = 0;
        if (messageCountElement) {
          const messageText = messageCountElement.textContent;
          const messageMatch = messageText.match(/(\d+)\s+сообщение/);
          if (messageMatch) {
            totalMessages = parseInt(messageMatch[1]);
          }
        }

        // Find the highest page number in pagination links
        let maxPage = 1;
        const paginationLinks = document.querySelectorAll(
          ".pagination ul li a"
        );

        for (const link of paginationLinks) {
          const href = link.getAttribute("href");
          const text = link.textContent.trim();

          // Extract page number from text (direct page number)
          if (/^\d+$/.test(text)) {
            const pageNum = parseInt(text);
            if (pageNum > maxPage) {
              maxPage = pageNum;
            }
          }

          // Also check href for start parameter (phpBB uses start=X where X = (page-1)*20)
          if (href) {
            const startMatch = href.match(/start=(\d+)/);
            if (startMatch) {
              const startValue = parseInt(startMatch[1]);
              // Assuming 20 messages per page (phpBB default)
              const pageFromStart = Math.floor(startValue / 20) + 1;
              if (pageFromStart > maxPage) {
                maxPage = pageFromStart;
              }
            }
          }
        }

        // Calculate pages from total messages if available
        let pagesFromCount = 1;
        if (totalMessages > 0) {
          pagesFromCount = Math.ceil(totalMessages / 20); // Assuming 20 messages per page
        }

        return {
          maxPageFromLinks: maxPage,
          totalMessages: totalMessages,
          pagesFromCount: pagesFromCount,
          finalPageCount: Math.max(maxPage, pagesFromCount),
        };
      });

      return paginationInfo.finalPageCount;
    } catch (error) {
      console.error("Error getting total pages:", error.message);
      return 1;
    }
  }

  // Navigate to specific page
  async navigateToPage(page, pageNumber) {
    try {
      let url = this.baseUrl;

      // phpBB uses start parameter instead of page parameter
      if (pageNumber > 1) {
        const startValue = (pageNumber - 1) * 20;

        // Check if URL already has parameters
        if (url.includes("?")) {
          // Check if start parameter already exists
          if (url.includes("start=")) {
            url = url.replace(/start=\d+/, `start=${startValue}`);
          } else {
            url += `&start=${startValue}`;
          }
        } else {
          url += `?start=${startValue}`;
        }
      }

      await page.goto(url, { waitUntil: "networkidle2" });
      await page.waitForTimeout(this.options.delay);
    } catch (error) {
      console.error(`Error navigating to page ${pageNumber}:`, error.message);
      throw error;
    }
  }

  // Main scraping function
  async scrapeAllDonations() {
    // Check cache: valid for 10 minutes (600000 ms)
    const now = Date.now();
    if (this._cache.donations && now - this._cache.timestamp < 600000) {
      this.donations = this._cache.donations;
      console.log("Loaded donations from cache.");
      return this.donations;
    }

    const browser = await puppeteer.launch({
      headless: this.options.headless === true ? "new" : this.options.headless,
      defaultViewport: { width: 1920, height: 1080 },
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // For server environments
    });

    try {
      const page = await browser.newPage();

      // Set user agent to avoid being blocked
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      // Navigate to first page
      await this.navigateToPage(page, 1);

      // Get total number of pages
      const totalPages = await this.getTotalPages(page);
      console.log(`Total pages to scrape: ${totalPages}`);

      // Scrape all pages
      this.donations = [];
      // Prepare all page numbers
      const pageNumbers = Array.from({ length: totalPages }, (_, i) => i + 1);

      // Map to promises for parallel extraction
      const browserPages = await Promise.all(
        pageNumbers.map(() => browser.newPage())
      );

      // Set user agent for all pages
      await Promise.all(
        browserPages.map((p) =>
          p.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
          )
        )
      );

      // Navigate all pages in parallel
      await Promise.all(
        browserPages.map((p, idx) => this.navigateToPage(p, pageNumbers[idx]))
      );

      // Extract donations in parallel
      const allDonations = await Promise.all(
        browserPages.map((p) => this.extractDonationsFromPage(p))
      );

      // Flatten and collect
      this.donations = allDonations.flat();

      // Close all pages except the first one (which will be closed in finally)
      await Promise.all(browserPages.map((p) => p.close()));

      // Sort donations by date and time
      this.donations.sort((a, b) => {
        const dateA = new Date(
          a.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1")
        );
        const dateB = new Date(
          b.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1")
        );
        return dateA - dateB;
      });

      this._cache.donations = this.donations;
      this._cache.timestamp = Date.now();

      console.log(
        `Scraping completed! Found ${this.donations.length} total donations.`
      );
      return this.donations;
    } finally {
      await browser.close();
    }
  }

  // Filter donations by comment substrings
  filterDonationsByComments(searchTerms) {
    if (!searchTerms || searchTerms.length === 0) {
      return this.donations;
    }

    const filtered = this.donations.filter((donation) => {
      if (!donation.comment) return false;

      const comment = donation.comment.toLowerCase();
      return searchTerms.some((term) =>
        comment.includes(term.toLowerCase().trim())
      );
    });

    return filtered;
  }

  // Generate CSV content from donations
  generateCSV(donations) {
    const headers = [
      "Payment Method",
      "Date",
      "Time",
      "Comment",
      "Gross Amount",
      "Tax",
      "Net Amount",
      "Currency",
    ];

    const csvRows = [headers.join(",")];

    for (const donation of donations) {
      const row = [
        donation.paymentMethod,
        donation.date,
        donation.time,
        `"${donation.comment || ""}"`,
        donation.grossAmount.toFixed(2),
        donation.tax.toFixed(2),
        donation.netAmount.toFixed(2),
        donation.currency,
      ];
      csvRows.push(row.join(","));
    }

    return csvRows.join("\n");
  }

  generateXLSX(donations) {
    // Define headers
    const headers = [
      "Payment Method",
      "Date",
      "Time",
      "Comment",
      "Gross Amount",
      "Tax",
      "Net Amount",
      "Currency",
    ];

    // Prepare data array
    const data = donations.map((donation) => [
      donation.paymentMethod,
      donation.date,
      donation.time,
      donation.comment || "", // No need for extra quotes in XLSX
      donation.grossAmount,
      donation.tax,
      donation.netAmount,
      donation.currency,
    ]);

    // Create worksheet
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...data]);

    // Format columns (optional)
    worksheet["!cols"] = [
      { wch: 15 }, // Payment Method
      { wch: 12 }, // Date
      { wch: 10 }, // Time
      { wch: 30 }, // Comment
      { wch: 12 }, // Gross Amount
      { wch: 10 }, // Tax
      { wch: 12 }, // Net Amount
      { wch: 8 }, // Currency
    ];

    // Create workbook
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Donations");

    // Return the workbook (can be saved to file or used as buffer)
    return workbook;
  }

  // Calculate total amounts
  calculateTotals(donations) {
    return donations.reduce(
      (totals, donation) => {
        totals.count += 1;
        totals.grossAmount += donation.grossAmount;
        totals.tax += donation.tax;
        totals.netAmount += donation.netAmount;
        return totals;
      },
      {
        count: 0,
        grossAmount: 0,
        tax: 0,
        netAmount: 0,
      }
    );
  }
}

// Singleton instance for reusing ForumDonationScraper
let scraperInstance = null;

// Telegram Bot Integration Function
async function processTelegramRequest(
  forumUrl,
  searchTermsString,
  options = {}
) {
  try {
    console.log("Starting donation scraping for Telegram bot...");

    // Parse search terms from comma-separated string
    const searchTerms = searchTermsString
      .split(",")
      .map((term) => term.trim())
      .filter((term) => term.length > 0);

    console.log("Search terms:", searchTerms);

    // Reuse scraper instance if possible
    if (!scraperInstance || scraperInstance.baseUrl !== forumUrl) {
      scraperInstance = new ForumDonationScraper(forumUrl, {
        headless: true,
        delay: 1000,
        ...options,
      });
    }

    // Scrape all donations (uses cache if available)
    await scraperInstance.scrapeAllDonations();

    // Filter donations by search terms
    const filteredDonations =
      scraperInstance.filterDonationsByComments(searchTerms);

    console.log(
      `Found ${filteredDonations.length} donations matching search terms`
    );

    // Generate CSV content
    const csvContent = scraperInstance.generateCSV(filteredDonations);
    const xslxContent = scraperInstance.generateXLSX(filteredDonations);

    // Calculate totals
    const totals = scraperInstance.calculateTotals(filteredDonations);

    // Find the latest donation date in filteredDonations
    let latestDate = null;
    if (scraperInstance.donations.length > 0) {
      latestDate = scraperInstance.donations.reduce((max, d) => {
        const dt = new Date(
          d.dateTime.replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1")
        );
        return !max || dt > max ? dt : max;
      }, null);
    }
    let latestDateStr = latestDate
      ? latestDate.toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        })
      : "нет данных";

    // Generate summary message
    const summaryMessage = `
📊 *Отчет по пожертвованиям*

🔍 *Поиск по:* ${searchTerms.join(", ")}
📈 *Найдено:* ${totals.count} пожертвований на ${latestDateStr}

💰 *Общая сумма:* ${totals.grossAmount.toFixed(2)} BYN
🏦 *Комиссия:* ${totals.tax.toFixed(2)} BYN
💵 *К получению:* ${totals.netAmount.toFixed(2)} BYN

📁 Подробный отчет в CSV файле
        `.trim();

    return {
      success: true,
      csvContent,
      xslxContent,
      summaryMessage,
      totalDonations: totals.count,
      totals: {
        gross: totals.grossAmount,
        tax: totals.tax,
        net: totals.netAmount,
      },
      filteredDonations,
    };
  } catch (error) {
    console.error("Error processing Telegram request:", error);
    return {
      success: false,
      error: error.message,
      summaryMessage: `❌ Ошибка при обработке запроса: ${error.message}`,
    };
  }
}

// Save CSV to temporary file for Telegram bot
async function saveCSVForTelegram(csvContent, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${filename}.csv` || `donations_${timestamp}.csv`;
    const filePath = `./temp/${fileName}`;

    // Ensure temp directory exists
    await fs.mkdir("./temp", { recursive: true });

    // Add BOM for proper UTF-8 encoding in Excel
    const csvWithBOM = "\uFEFF" + csvContent;
    await fs.writeFile(filePath, csvWithBOM, "utf8");

    return {
      success: true,
      filePath,
      fileName,
    };
  } catch (error) {
    console.error("Error saving CSV file:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

async function saveXLSXForTelegram(xlsxContent, filename = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${filename}.xlsx` || `donations_${timestamp}.xlsx`;
    const filePath = `./temp/${fileName}`;

    // Ensure temp directory exists
    await fs.mkdir("./temp", { recursive: true });
    XLSX.writeFile(xlsxContent, filePath);

    return {
      success: true,
      filePath,
      fileName,
    };
  } catch (error) {
    console.error("Error saving CSV file:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Clean up temporary files
async function cleanupTempFiles(olderThanMinutes = 60) {
  try {
    const tempDir = "./temp";
    const files = await fs.readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = `${tempDir}/${file}`;
      const stats = await fs.stat(filePath);
      const ageMinutes = (now - stats.mtime.getTime()) / (1000 * 60);

      if (ageMinutes > olderThanMinutes) {
        await fs.unlink(filePath);
        console.log(`Deleted old temp file: ${file}`);
      }
    }
  } catch (error) {
    console.error("Error cleaning up temp files:", error);
  }
}

// Export functions for Telegram bot usage
module.exports = {
  ForumDonationScraper,
  processTelegramRequest,
  saveCSVForTelegram,
  saveXLSXForTelegram,
  cleanupTempFiles,
};

// Example usage for Telegram bot:
/*
const { processTelegramRequest, saveCSVForTelegram } = require('./forum_scraper');

// In your Telegram bot handler:
async function handleDonationRequest(ctx, searchTerms) {
    const forumUrl = 'https://forum.zooschans.by/viewtopic.php?f=15&t=54158';
    
    // Process the request
    const result = await processTelegramRequest(forumUrl, searchTerms);
    
    if (result.success) {
        // Save CSV file
        const fileResult = await saveCSVForTelegram(result.csvContent);
        
        if (fileResult.success) {
            // Send summary message
            await ctx.replyWithMarkdown(result.summaryMessage);
            
            // Send CSV file
            await ctx.replyWithDocument({
                source: fileResult.filePath,
                filename: fileResult.fileName
            });
        }
    } else {
        await ctx.reply(result.summaryMessage);
    }
}
*/
