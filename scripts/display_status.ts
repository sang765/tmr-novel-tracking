import puppeteer, { Browser, Page } from 'puppeteer';
import { config } from 'dotenv';
import * as fs from 'fs';

// Load environment variables
config();

interface Novel {
  title: string;
  link: string;
  status: string;
  last_update: string;
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Cache-Control': 'max-age=0',
};

async function scrapePage(url: string, page: Page): Promise<Novel[]> {
  // Add delay to avoid rate limiting
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  await page.setExtraHTTPHeaders(DEFAULT_HEADERS);
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  
  const novels: Novel[] = [];
  
  // Debug: Print some info about the page
  const title = await page.title();
  console.log(`Page title: ${title}`);
  
  // Find showcase-item elements
  const items = await page.$$('div.showcase-item');
  console.log(`Found ${items.length} showcase-item elements`);
  
  for (const item of items) {
    try {
      const titleElem = await item.$('h5.series-name a');
      const title = titleElem ? (await titleElem.evaluate(el => el.textContent?.trim() || '')) : '';
      const link = titleElem ? (await titleElem.evaluate(el => el.getAttribute('href') || '')) : '';
      
      const statusElems = await item.$$('span.status-value');
      const status = statusElems.length > 0 && statusElems[0] ? (await statusElems[0].evaluate(el => el.textContent?.trim() || '')) : 'Unknown';
      
      let lastUpdate = 'Unknown';
      if (statusElems.length > 1) {
        const timeElem = statusElems[1] ? await statusElems[1].$('time') : null;
        if (timeElem) {
          const datetime = await timeElem.evaluate(el => el.getAttribute('datetime'));
          const titleAttr = await timeElem.evaluate(el => el.getAttribute('title'));
          
          if (datetime) {
            // Parse ISO datetime and convert to Unix timestamp
            const dt = new Date(datetime);
            const timestamp = Math.floor(dt.getTime() / 1000);
            lastUpdate = `<t:${timestamp}:R>`; // Discord relative timestamp
          } else if (titleAttr) {
            lastUpdate = titleAttr;
          }
        } else {
          lastUpdate = statusElems[1] ? await statusElems[1].evaluate(el => el.textContent?.trim() || '') : 'Unknown';
        }
      }
      
      novels.push({
        title,
        link,
        status,
        last_update: lastUpdate
      });
    } catch (error) {
      console.error('Error parsing item:', error);
    }
  }
  
  return novels;
}

async function getTotalPages(page: Page): Promise<number> {
  try {
    // Use evaluate with any type to avoid TypeScript DOM issues
    // This runs in browser context where document is available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const totalPages = await (page as any).evaluate(() => {
      try {
        // Look for pagination container
        const pagination = (window as any).document.querySelector('nav.pagination, ul.pagination, div.pagination');
        if (pagination) {
          const links = pagination.querySelectorAll('a');
          let maxPage = 1;
          links.forEach((link: Element) => {
            const text = link.textContent?.trim() || '';
            const pageNum = parseInt(text, 10);
            if (!isNaN(pageNum) && pageNum > maxPage) {
              maxPage = pageNum;
            }
          });
          if (maxPage > 1) return maxPage;
        }
        
        // Try to find last page link
        const lastLink = (window as any).document.querySelector('a[rel="last"], a.page-last, li.last a');
        if (lastLink) {
          const href = lastLink.getAttribute('href') || '';
          const match = href.match(/page=(\d+)/);
          if (match) return parseInt(match[1], 10);
        }
        
        // Try to find page info text like "Page X of Y"
        const pageInfo = (window as any).document.querySelector('span.page-info, div.page-info, .pagination-info');
        if (pageInfo) {
          const text = pageInfo.textContent || '';
          const match = text.match(/(\d+)\s*\/\s*(\d+)/);
          if (match) return parseInt(match[2], 10);
        }
        
        return 1;
      } catch (e) {
        return 1;
      }
    });
    
    if (totalPages > 1) {
      console.log(`Found pagination: ${totalPages} pages`);
    }
    return totalPages;
  } catch (error) {
    console.error('Error detecting total pages:', error);
    return 1;
  }
}

async function getAllNovels(baseUrl: string, maxPages: number = 10): Promise<Novel[]> {
  const allNovels: Novel[] = [];
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    // First, get the first page and detect total pages
    const firstPageUrl = `${baseUrl}?page=1`;
    console.log(`Scraping first page to detect pagination: ${firstPageUrl}`);
    await scrapePage(firstPageUrl, page);
    
    // Detect total pages
    const totalPages = await getTotalPages(page);
    const pagesToScrape = Math.min(totalPages, maxPages);
    console.log(`Will scrape ${pagesToScrape} pages total`);
    
    // Now scrape all pages
    for (let pageNum = 1; pageNum <= pagesToScrape; pageNum++) {
      const url = `${baseUrl}?page=${pageNum}`;
      console.log(`Scraping page ${pageNum}/${pagesToScrape}: ${url}`);
      const novels = await scrapePage(url, page);
      allNovels.push(...novels);
    }
    
    // If we found novels and only scraped 1 page, try page 2 to check if there are more
    if (pagesToScrape === 1 && allNovels.length > 0) {
      console.log("Only 1 page detected, checking page 2 to verify...");
      const page2Url = `${baseUrl}?page=2`;
      const page2Novels = await scrapePage(page2Url, page);
      if (page2Novels.length > 0) {
        console.log(`Found ${page2Novels.length} novels on page 2, scraping additional pages...`);
        allNovels.push(...page2Novels);
        // Continue checking for more pages
        let pageNum = 3;
        while (true) {
          const nextUrl = `${baseUrl}?page=${pageNum}`;
          const nextNovels = await scrapePage(nextUrl, page);
          if (nextNovels.length === 0) break;
          console.log(`Found ${nextNovels.length} novels on page ${pageNum}`);
          allNovels.push(...nextNovels);
          pageNum++;
        }
      } else {
        console.log("Page 2 is empty, no more novels to scrape");
      }
    }
  } finally {
    await browser.close();
  }
  
  return allNovels;
}

function formatNovelMarkdown(novel: Novel): string {
  const fullLink = `https://docln.sbs${novel.link}`;
  return `[${novel.title}](<${fullLink}>)\n> **Trạng thái:** ${novel.status}\n> **Cập nhật:** ${novel.last_update}\n`;
}

async function sendStatusToDiscord(novels: Novel[], webhookUrl: string, messageId: string | null = null): Promise<string | null> {
  // Handle empty novels array - send a message indicating no novels found
  if (!novels || novels.length === 0) {
    const payload = {
      "embeds": [{
        "title": "Trạng thái các bộ truyện - The Mavericks",
        "description": "Không tìm thấy truyện nào để hiển thị. Có thể trang web nguồn đang gặp sự cố hoặc thay đổi cấu trúc.",
        "color": 0xff0000 // Red color for error/warning
      }]
    };
    
    const method = messageId ? 'patch' : 'post';
    const url = messageId ? `${webhookUrl}/messages/${messageId}` : webhookUrl;
    
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }
    
    return messageId || null;
  }

  // Split novels into chunks of 25 (Discord embed field limit)
  const chunkSize = 25;
  const chunks: Novel[][] = [];
  for (let i = 0; i < novels.length; i += chunkSize) {
    chunks.push(novels.slice(i, i + chunkSize));
  }
  
  const embeds = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const fields = [];
    
    for (const novel of chunk) {
      // Add emoji based on status
      let statusEmoji = '✒️';
      const statusLower = novel.status.toLowerCase();
      if (statusLower.includes('hoàn thành') || statusLower.includes('complete') || statusLower.includes('done')) {
        statusEmoji = '✅';
      } else if (statusLower.includes('tạm ngưng') || statusLower.includes('pause') || statusLower.includes('on hold') || statusLower.includes(' hiatus')) {
        statusEmoji = '⛔';
      }
      
      // Truncate title if too long (Discord limit 256 chars for field name)
      const displayTitle = novel.title.length > 250 ? novel.title.substring(0, 250) + '...' : novel.title;
      // Compact field value
      let value = `${statusEmoji} ${novel.status} | ${novel.last_update}`;
      fields.push({
        "name": displayTitle,
        "value": value,
        "inline": false
      });
    }
    
    let titleText = "Trạng thái các bộ truyện - The Mavericks";
    if (chunks.length > 1) {
      titleText += ` (phần ${i + 1})`;
    }
    
    const embed = {
      "title": titleText,
      "color": 0x0099ff, // Blue color
      "fields": fields,
      "footer": {
        "text": `Tổng cộng ${novels.length} bộ truyện • Phần ${i + 1}/${chunks.length}`
      }
    };
    embeds.push(embed);
  }
  
  const payload = { "embeds": embeds };
  
  try {
    const method = messageId ? 'patch' : 'post';
    const url = messageId ? `${webhookUrl}/messages/${messageId}` : webhookUrl;
    
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }
    
    // For new messages, Discord returns the message object with id
    // For edit, it returns the updated message object
    const text = await response.text();
    console.log('Discord response:', text.substring(0, 200));
    
    if (!text || text.trim() === '') {
      // Empty response but successful - Discord sometimes returns empty body
      console.log('Empty response from Discord, assuming success');
      return messageId || null;
    }
    
    if (!messageId) {
      // Try to parse the response to get the message ID
      try {
        const data = JSON.parse(text);
        const id = data && typeof data === 'object' ? data.id : null;
        console.log('Extracted message ID:', id);
        return id;
      } catch (e) {
        console.error('Failed to parse Discord response:', e);
        return null;
      }
    }
    
    return messageId;
  } catch (error) {
    console.error('Discord API error:', error);
    throw error;
  }
}

async function main() {
  const baseUrl = "https://docln.sbs/nhom-dich/3474-the-mavericks";
  let novels: Novel[] = [];
  
  try {
    novels = await getAllNovels(baseUrl);
    console.log(`Successfully scraped ${novels.length} novels`);
  } catch (error) {
    console.error(`Failed to scrape website: ${error}`);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    console.log("Using existing novel_status.md if available, or creating empty status");
    novels = [];
    
    // Try to read existing file
    if (fs.existsSync('novel_status.md')) {
      const existingContent = fs.readFileSync('novel_status.md', 'utf-8');
      console.log("Using existing novel_status.md content");
    }
  }
  
  // Write to file
  let fileContent = "# Trạng thái các bộ truyện - The Mavericks\n\n";
  if (novels.length > 0) {
    for (const novel of novels) {
      fileContent += formatNovelMarkdown(novel) + "\n";
    }
  } else {
    fileContent += "*Unable to fetch latest data - website may be unavailable*\n";
  }
  
  fs.writeFileSync('novel_status.md', fileContent, 'utf-8');
  console.log("Status saved to novel_status.md");
  
  // Send to Discord
  const webhookUrl = process.env.STATUS_WEBHOOK_URL;
  if (webhookUrl) {
    try {
      let messageId: string | null = null;
      const messageIdFile = 'message_id.txt';
      if (fs.existsSync(messageIdFile)) {
        messageId = fs.readFileSync(messageIdFile, 'utf-8').trim() || null;
      }
      messageId = await sendStatusToDiscord(novels, webhookUrl, messageId);
      if (messageId) {
        fs.writeFileSync(messageIdFile, messageId, 'utf-8');
      }
      console.log("Status sent to Discord");
    } catch (error) {
      console.error(`Failed to send to Discord: ${error}`);
    }
  } else {
    console.log("No Discord webhook URL provided");
  }
}

main();
