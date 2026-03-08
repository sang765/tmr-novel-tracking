import { config } from 'dotenv';
import * as fs from 'fs';
import puppeteer, { Browser, Page } from 'puppeteer';

// Load environment variables
config();

interface Novel {
  title: string;
  link: string;
  status: string;
  last_update: string;
}

const BASE_URL = "https://ln.hako.vn/nhom-dich/3474-the-mavericks";

/**
 * Main function to scrape all novels using Puppeteer with Chrome DevTools
 * This version uses the correct selectors identified via Chrome DevTools MCP
 */
async function main() {
  const baseUrl = BASE_URL;
  let novels: Novel[] = [];
  let errorLog: string | undefined = undefined;
  
  let browser: Browser | null = null;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
      defaultViewport: { width: 1920, height: 1080 },
    });
    
    const page = await browser.newPage();
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate to first page
    const firstPageUrl = `${baseUrl}?page=1`;
    console.log(`Navigating to: ${firstPageUrl}`);
    
    await page.goto(firstPageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    
    // Get page title for debugging
    const title = await page.title();
    console.log(`Page title: ${title}`);
    
    // Extract total pages from pagination
    const totalPages = await page.evaluate(() => {
      // Try to find pagination links
      const paginationLinks = document.querySelectorAll('.pagination a, .pagination_wrap a, a.paging_item');
      let maxPage = 1;
      
      for (const link of Array.from(paginationLinks)) {
        const href = link.getAttribute('href') || '';
        const text = link.textContent?.trim() || '';
        
        // Check for page numbers in href
        const pageMatch = href.match(/page=(\d+)/);
        if (pageMatch && pageMatch[1]) {
          const pageNum = parseInt(pageMatch[1], 10);
          if (pageNum > maxPage) maxPage = pageNum;
        }
        
        // Check for page numbers in text
        const textNum = parseInt(text, 10);
        if (!isNaN(textNum) && textNum > maxPage) {
          maxPage = textNum;
        }
      }
      
      return maxPage;
    });
    
    console.log(`Found ${totalPages} pages`);
    
    // Scrape all pages
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageUrl = `${baseUrl}?page=${pageNum}`;
      console.log(`Scraping page ${pageNum}/${totalPages}: ${pageUrl}`);
      
      if (pageNum > 1) {
        await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      }
      
      // Extract novels from current page using selectors from Chrome DevTools MCP analysis
      const pageNovels = await page.evaluate(() => {
        const novels: Array<{
          title: string;
          link: string;
          status: string;
          last_update: string;
        }> = [];
        
        // Find all showcase-item elements (identified via Chrome DevTools MCP)
        const items = document.querySelectorAll('div.showcase-item');
        
        for (const item of Array.from(items)) {
          try {
            // Get title link - h5.series-name a
            const titleLink = item.querySelector('h5.series-name a');
            const title = titleLink?.textContent?.trim() || '';
            const link = titleLink?.getAttribute('href') || '';
            
            // Get status - first status-item is "Tình trạng:", second is "Lần cuối:"
            // Using selectors identified via Chrome DevTools MCP
            const statusItems = item.querySelectorAll('.status-item');
            let status = 'Unknown';
            let lastUpdate = 'Unknown';
            
            for (let i = 0; i < statusItems.length; i++) {
              const statusItem = statusItems[i];
              if (!statusItem) continue;
              const statusNameEl = statusItem.querySelector('.status-name');
              const statusValueEl = statusItem.querySelector('.status-value');
              
              const statusName = statusNameEl?.textContent?.trim() || '';
              const statusValue = statusValueEl?.textContent?.trim() || '';
              
              if (statusName.includes('Tình trạng')) {
                status = statusValue;
              } else if (statusName.includes('Lần cuối')) {
                // Check for time element with datetime attribute
                const timeEl = statusValueEl?.querySelector('time');
                if (timeEl) {
                  const datetime = timeEl.getAttribute('datetime');
                  const timeText = timeEl.textContent?.trim() || '';
                  
                  if (datetime) {
                    // Parse ISO datetime and convert to Unix timestamp for Discord
                    const dt = new Date(datetime);
                    const timestamp = Math.floor(dt.getTime() / 1000);
                    lastUpdate = `<t:${timestamp}:R>`;
                  } else {
                    lastUpdate = timeText;
                  }
                } else {
                  lastUpdate = statusValue;
                }
              }
            }
            
            if (title && link) {
              novels.push({
                title,
                link,
                status,
                last_update: lastUpdate
              });
            }
          } catch (e) {
            console.error('Error parsing item:', e);
          }
        }
        
        return novels;
      });
      
      console.log(`Found ${pageNovels.length} novels on page ${pageNum}`);
      novels.push(...pageNovels);
    }
    
    console.log(`Total novels scraped: ${novels.length}`);
    
  } catch (error) {
    console.error(`Failed to scrape website: ${error}`);
    if (error instanceof Error) {
      console.error(error.stack);
    }
    console.log("Using empty novel list");
    novels = [];
    
    // Store error for Discord message
    errorLog = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  // Write to file
  let fileContent = "# Trạng thái các bộ truyện - The Mavericks\n\n";
  if (novels.length > 0) {
    for (const novel of novels) {
      const fullLink = `https://ln.hako.vn${novel.link}`;
      fileContent += `[${novel.title}](<${fullLink}>)\n> **Trạng thái:** ${novel.status}\n> **Cập nhật:** ${novel.last_update}\n\n`;
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
      
      messageId = await sendStatusToDiscord(novels, webhookUrl, messageId, errorLog);
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

function formatNovelMarkdown(novel: Novel): string {
  const fullLink = `https://ln.hako.vn${novel.link}`;
  return `[${novel.title}](<${fullLink}>)\n> **Trạng thái:** ${novel.status}\n> **Cập nhật:** ${novel.last_update}\n`;
}

async function sendStatusToDiscord(novels: Novel[], webhookUrl: string, messageId: string | null = null, errorLog?: string): Promise<string | null> {
  // Handle empty novels array
  if (!novels || novels.length === 0) {
    let errorDescription = "Không tìm thấy truyện nào để hiển thị. Có thể trang web nguồn đang gặp sự cố hoặc thay đổi cấu trúc.";
    
    // Include failed log if provided
    if (errorLog) {
      errorDescription += "\n\n```bash\n" + errorLog + "\n```";
    }
    
    const payload = {
      "embeds": [{
        "title": "Trạng thái các bộ truyện - The Mavericks",
        "description": errorDescription,
        "color": 0xff0000
      }]
    };
    
    const method = messageId ? 'patch' : 'post';
    const url = messageId ? `${webhookUrl}/messages/${messageId}` : webhookUrl;
    
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
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
      } else if (statusLower.includes('tạm ngưng') || statusLower.includes('pause') || statusLower.includes('on hold') || statusLower.includes('hiatus')) {
        statusEmoji = '⛔';
      }
      
      // Truncate title if too long
      const displayTitle = novel.title.length > 250 ? novel.title.substring(0, 250) + '...' : novel.title;
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
      "color": 0x0099ff,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }
    
    const text = await response.text();
    console.log('Discord response:', text.substring(0, 200));
    
    if (!text || text.trim() === '') {
      console.log('Empty response from Discord, assuming success');
      return messageId || null;
    }
    
    if (!messageId) {
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

main();
