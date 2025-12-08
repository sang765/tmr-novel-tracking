import requests
from bs4 import BeautifulSoup

def scrape_page(url):
    response = requests.get(url)
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
                from datetime import datetime
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

if __name__ == "__main__":
    base_url = "https://docln.sbs/nhom-dich/3474-the-mavericks"
    novels = get_all_novels(base_url)

    with open('novel_status.md', 'w', encoding='utf-8') as f:
        f.write("# Trạng thái các bộ truyện - The Mavericks\n\n")
        for novel in novels:
            f.write(format_novel_markdown(novel) + "\n")

    print("Status saved to novel_status.md")