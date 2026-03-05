import requests
from bs4 import BeautifulSoup
import os
from datetime import datetime
import time
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Create a session for better connection handling
session = requests.Session()

# Configure retry strategy
retry_strategy = Retry(
    total=3,
    backoff_factor=1,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["HEAD", "GET", "OPTIONS"]
)
adapter = HTTPAdapter(max_retries=retry_strategy)
session.mount("https://", adapter)
session.mount("http://", adapter)

# Headers to avoid being blocked by anti-scraping measures
DEFAULT_HEADERS = {
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
}

def scrape_page(url):
    # Add delay to avoid rate limiting
    time.sleep(2)
    response = session.get(url, headers=DEFAULT_HEADERS, timeout=30)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')
    novels = []

    for item in soup.find_all('div', class_='showcase-item'):
        title_elem = item.find('h5', class_='series-name').find('a')
        title = title_elem.text.strip()
        link = title_elem['href']
        status_elem = item.find_all('span', class_='status-value')
        status = status_elem[0].text.strip() if status_elem else 'Unknown'
        last_update = 'Unknown'
        if len(status_elem) > 1:
            time_elem = status_elem[1].find('time')
            if time_elem and time_elem.get('datetime'):
                # Parse ISO datetime and convert to Unix timestamp
                dt_str = time_elem['datetime']
                dt = datetime.fromisoformat(dt_str.replace('Z', '+00:00'))
                timestamp = int(dt.timestamp())
                last_update = f"<t:{timestamp}:R>"  # Discord relative timestamp
            elif time_elem and time_elem.get('title'):
                last_update = time_elem['title']
            else:
                last_update = status_elem[1].text.strip()
        novels.append({
            'title': title,
            'link': link,
            'status': status,
            'last_update': last_update
        })

    return novels

def get_all_novels(base_url, max_pages=2):
    all_novels = []
    for page in range(1, max_pages + 1):
        url = f"{base_url}?page={page}"
        print(f"Scraping {url}")
        novels = scrape_page(url)
        all_novels.extend(novels)
    return all_novels

def format_novel_markdown(novel):
    full_link = f"https://docln.sbs{novel['link']}"
    return f"[{novel['title']}](<{full_link}>)\n> **Trạng thái:** {novel['status']}\n> **Cập nhật:** {novel['last_update']}\n"

def send_status_to_discord(novels, webhook_url, message_id=None):
    # Split novels into chunks of 25 (Discord embed field limit)
    chunk_size = 25
    chunks = [novels[i:i + chunk_size] for i in range(0, len(novels), chunk_size)]

    embeds = []
    for i, chunk in enumerate(chunks):
        fields = []
        for novel in chunk:
            # Truncate title if too long (Discord limit 256 chars for field name)
            title = novel['title'][:250] + "..." if len(novel['title']) > 250 else novel['title']
            # Field value with status and update
            value = f"**Trạng thái:** {novel['status']}\n**Cập nhật:** {novel['last_update']}"
            # Ensure value is under 1024 chars
            if len(value) > 1000:
                value = value[:997] + "..."
            fields.append({
                "name": title,
                "value": value,
                "inline": False
            })

        title_text = "Trạng thái các bộ truyện - The Mavericks"
        if len(chunks) > 1:
            title_text += f" (phần {i+1})"

        embed = {
            "title": title_text,
            "color": 0x0099ff,  # Blue color
            "fields": fields,
            "footer": {
                "text": f"Tổng cộng {len(novels)} bộ truyện • Phần {i+1}/{len(chunks)}"
            }
        }
        embeds.append(embed)

    payload = {"embeds": embeds}
    if message_id:
        # Edit existing message
        url = f"{webhook_url}/messages/{message_id}"
        response = requests.patch(url, json=payload)
    else:
        # Send new message
        response = requests.post(webhook_url, json=payload)
    response.raise_for_status()
    return response.json().get('id') if not message_id else message_id

if __name__ == "__main__":
    base_url = "https://docln.sbs/nhom-dich/3474-the-mavericks"
    
    try:
        novels = get_all_novels(base_url)
    except Exception as e:
        print(f"Failed to scrape website: {e}")
        print("Using existing novel_status.md if available, or creating empty status")
        novels = []
        
        # Try to read existing file
        if os.path.exists('novel_status.md'):
            with open('novel_status.md', 'r', encoding='utf-8') as f:
                existing_content = f.read()
            print("Using existing novel_status.md content")
        else:
            existing_content = "# Trạng thái các bộ truyện - The Mavericks\n\n*Unable to fetch latest data*\n"
    
    with open('novel_status.md', 'w', encoding='utf-8') as f:
        f.write("# Trạng thái các bộ truyện - The Mavericks\n\n")
        if novels:
            for novel in novels:
                f.write(format_novel_markdown(novel) + "\n")
        else:
            f.write("*Unable to fetch latest data - website may be unavailable*\n")

    print("Status saved to novel_status.md")

    webhook_url = os.environ.get('STATUS_WEBHOOK_URL')
    if webhook_url:
        try:
            message_id = None
            message_id_file = 'message_id.txt'
            if os.path.exists(message_id_file):
                with open(message_id_file, 'r') as f:
                    message_id = f.read().strip()
            message_id = send_status_to_discord(novels, webhook_url, message_id)
            with open(message_id_file, 'w') as f:
                f.write(message_id)
            print("Status sent to Discord")
        except Exception as e:
            print(f"Failed to send to Discord: {e}")
    else:
        print("No Discord webhook URL provided")