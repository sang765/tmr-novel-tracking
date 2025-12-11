#!/usr/bin/env python3
"""
Script to check for new chapters from The Mavericks on ln.hako.vn
and send Discord notifications when new chapters are found.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup

# Constants
CACHE_FILE = "cache.json"
GROUP_URL = "https://ln.hako.vn/nhom-dich/3474-the-mavericks"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
}
MAX_RETRIES = 3
RETRY_DELAY = 5

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class ChapterChecker:
    def __init__(self, webhook_url: Optional[str]):
        self.webhook_url = webhook_url
        self.cache_file = CACHE_FILE
        self.group_url = GROUP_URL
        self.session = requests.Session()
        self.session.headers.update(HEADERS)

    def load_cache(self) -> Dict:
        """Load cached chapter data from file."""
        if os.path.exists(self.cache_file):
            try:
                with open(self.cache_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except (json.JSONDecodeError, IOError) as e:
                logger.warning(f"Failed to load cache: {e}")
        return {"novels": {}, "last_check": None}

    def save_cache(self, data: Dict):
        """Save chapter data to cache file."""
        try:
            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            logger.info("Cache saved successfully")
        except IOError as e:
            logger.error(f"Failed to save cache: {e}")

    def fetch_page(self, url: str) -> Optional[str]:
        """Fetch the HTML content from the target URL with retry logic."""
        for attempt in range(MAX_RETRIES):
            try:
                logger.info(f"Fetching page (attempt {attempt + 1}/{MAX_RETRIES})")
                response = self.session.get(url, timeout=30)
                response.raise_for_status()
                return response.text
            except requests.RequestException as e:
                logger.warning(f"Request failed (attempt {attempt + 1}): {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY * (2 ** attempt))  # Exponential backoff
                else:
                    logger.error("All retry attempts failed")
                    return None
        return None

    def get_novels(self) -> List[Dict]:
        """Fetch and parse novels from the group page."""
        html = self.fetch_page(self.group_url)
        if not html:
            logger.error("Failed to fetch group page")
            return []
        return self.parse_novels(html)

    def parse_chapters(self, html: str) -> List[Dict]:
        """Parse chapter information from HTML."""
        soup = BeautifulSoup(html, 'html.parser')
        chapters = []

        # Find chapter list container
        chapter_list = soup.find('div', class_='list-chapter')
        if not chapter_list:
            logger.warning("Chapter list container not found")
            return chapters

        # Find all chapter links
        chapter_links = chapter_list.find_all('a', href=True)
        for link in chapter_links:
            try:
                href = link.get('href', '')
                title = link.get_text(strip=True)

                # Extract chapter number from title or href
                chapter_num = self.extract_chapter_number(title, href)
                if chapter_num:
                    chapters.append({
                        "number": chapter_num,
                        "title": title,
                        "url": f"https://ln.hako.vn{href}" if href.startswith('/') else href,
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    })
            except Exception as e:
                logger.warning(f"Failed to parse chapter link: {e}")
                continue

        # Sort chapters by number (newest first)
        chapters.sort(key=lambda x: x['number'], reverse=True)
        logger.info(f"Parsed {len(chapters)} chapters")
        return chapters

    def parse_novels(self, html: str) -> List[Dict]:
        """Parse novel information from group page HTML."""
        soup = BeautifulSoup(html, 'html.parser')
        novels = []

        # Find novel list container - based on actual HTML structure
        novel_list = soup.find('section', class_='showcase-list')
        if not novel_list:
            logger.warning("Novel list container not found")
            return novels

        # Find all novel title links
        novel_titles = novel_list.find_all('h5', class_='series-name')
        for title_elem in novel_titles:
            try:
                link = title_elem.find('a', href=True)
                if not link:
                    continue
                href = link.get('href', '')
                title = link.get_text(strip=True)

                # Extract novel ID from URL
                import re
                match = re.search(r'/truyen/(\d+)', href)
                if match:
                    novel_id = match.group(1)
                    novels.append({
                        "id": novel_id,
                        "title": title,
                        "url": f"https://ln.hako.vn{href}" if href.startswith('/') else href
                    })
            except Exception as e:
                logger.warning(f"Failed to parse novel link: {e}")
                continue

        logger.info(f"Parsed {len(novels)} novels")
        return novels

    def extract_chapter_number(self, title: str, href: str) -> Optional[float]:
        """Extract chapter number from title or URL."""
        import re

        # Try to find chapter number in title
        patterns = [
            r'Chương\s+(\d+(?:\.\d+)?)',
            r'Chapter\s+(\d+(?:\.\d+)?)',
            r'Chap\s+(\d+(?:\.\d+)?)',
            r'#(\d+(?:\.\d+)?)',
        ]

        for pattern in patterns:
            match = re.search(pattern, title, re.IGNORECASE)
            if match:
                try:
                    return float(match.group(1))
                except ValueError:
                    continue

        # Try to extract from URL
        url_match = re.search(r'/c(\d+(?:\.\d+)?)', href)
        if url_match:
            try:
                return float(url_match.group(1))
            except ValueError:
                pass

        logger.warning(f"Could not extract chapter number from: {title}")
        return None

    def get_new_chapters(self, current_chapters: List[Dict], cached_chapters: List[Dict]) -> List[Dict]:
        """Find chapters that are new compared to cache."""
        if not cached_chapters:
            # First run, consider all chapters as new but limit to avoid spam
            return current_chapters[:5]  # Only notify about latest 5 chapters

        cached_nums = {chap['number'] for chap in cached_chapters}
        new_chapters = [chap for chap in current_chapters if chap['number'] not in cached_nums]

        logger.info(f"Found {len(new_chapters)} new chapters")
        return new_chapters

    def send_discord_notification(self, chapter: Dict):
        """Send Discord notification for a new chapter."""
        try:
            # Load the template
            with open('discohook_message_2025-12-10.json', 'r', encoding='utf-8') as f:
                template = json.load(f)

            # Update template with chapter data
            embed = template['embeds'][0]

            # Extract chapter and novel info
            chapter_num = chapter['number']
            chapter_title = chapter['title']
            chapter_url = chapter['url']
            novel_title = chapter.get('novel_title', 'Unknown Novel')
            novel_url = chapter.get('novel_url', '')

            # Update embed fields
            embed['description'] = embed['description'].replace('**Tên Truyện**', novel_title)
            embed['description'] = embed['description'].replace('**Tên Chương**', f'Chương {chapter_num}: {chapter_title}')
            embed['description'] = embed['description'].replace('**Tên Danh Mục**', 'The Mavericks')
            embed['description'] = embed['description'].replace('timestamp', str(int(datetime.fromisoformat(chapter['timestamp'].replace('Z', '+00:00')).timestamp())))
            embed['description'] = embed['description'].replace('- Link chap tên miền docln.net', f'- Link chap tên miền docln.net: {chapter_url.replace("ln.hako.vn", "docln.net")}')
            embed['description'] = embed['description'].replace('- Link chap tên miền docln.sbs', f'- Link chap tên miền docln.sbs: {chapter_url.replace("ln.hako.vn", "docln.sbs")}')
            embed['description'] = embed['description'].replace('- Link chap tên miền ln.hako.vn', f'- Link chap tên miền ln.hako.vn: {chapter_url}')

            # Update timestamp
            embed['timestamp'] = chapter['timestamp']

            # Update image and thumbnail URLs - for now, keep placeholder or try to extract from novel_url
            # You might need to parse the novel page to get the cover image
            embed['image']['url'] = 'https://i.hako.vn/ln/series/covers/s22527-2e663ae3-a81e-4a43-9be2-a9f090d6b3ec.jpg'  # Placeholder
            embed['thumbnail']['url'] = 'https://i.hako.vn/ln/series/covers/s22527-2e663ae3-a81e-4a43-9be2-a9f090d6b3ec.jpg'  # Placeholder

            # Send webhook
            response = requests.post(
                self.webhook_url,
                json=template,
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
            response.raise_for_status()
            logger.info(f"Discord notification sent for {novel_title} - Chapter {chapter_num}")

        except Exception as e:
            logger.error(f"Failed to send Discord notification: {e}")

    def run(self):
        """Main execution method."""
        logger.info("Starting chapter check")

        # Load cache
        cache = self.load_cache()

        # Get all novels from group
        novels = self.get_novels()
        if not novels:
            logger.error("No novels found, exiting")
            return

        all_new_chapters = []

        for novel in novels:
            novel_id = novel['id']
            novel_url = novel['url']
            novel_title = novel['title']

            logger.info(f"Checking novel: {novel_title}")

            # Fetch novel page
            html = self.fetch_page(novel_url)
            if not html:
                logger.warning(f"Failed to fetch page for {novel_title}")
                continue

            current_chapters = self.parse_chapters(html)
            if not current_chapters:
                logger.warning(f"No chapters found for {novel_title}")
                continue

            # Get cached chapters for this novel
            novel_cache = cache['novels'].get(novel_id, {})
            cached_chapters = novel_cache.get('chapters', [])

            # Find new chapters
            new_chapters = self.get_new_chapters(current_chapters, cached_chapters)

            # Add novel info to chapters
            for chapter in new_chapters:
                chapter['novel_title'] = novel_title
                chapter['novel_url'] = novel_url

            all_new_chapters.extend(new_chapters)

            # Update cache for this novel
            if novel_id not in cache['novels']:
                cache['novels'][novel_id] = {}
            cache['novels'][novel_id]['chapters'] = current_chapters
            cache['novels'][novel_id]['last_check'] = datetime.now(timezone.utc).isoformat()

        # Send notifications for all new chapters (if webhook is configured)
        if self.webhook_url:
            for chapter in all_new_chapters:
                self.send_discord_notification(chapter)
                time.sleep(1)  # Rate limiting
        else:
            logger.info(f"Skipping Discord notifications ({len(all_new_chapters)} new chapters found)")

        # Update global last_check
        cache['last_check'] = datetime.now(timezone.utc).isoformat()
        self.save_cache(cache)

        logger.info("Chapter check completed")

def main():
    webhook_url = os.getenv('CFU_NOVEL_WEBHOOKS')
    if not webhook_url:
        logger.warning("CFU_NOVEL_WEBHOOKS environment variable not set - notifications will be skipped")

    checker = ChapterChecker(webhook_url)
    checker.run()

if __name__ == "__main__":
    main()