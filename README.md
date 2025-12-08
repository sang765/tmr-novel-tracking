# tmr-novel-tracking
Tracking Light/Web Novel translations by The Mavericks team from https://docln.sbs/nhom-dich/3474-the-mavericks

## Setup

1. Clone this repository
2. Install dependencies: `pip install -r requirements.txt`
3. Set up Discord webhook:
   - Create a webhook in your Discord server
   - Add the webhook URL as a secret in your GitHub repository: `DISCORD_WEBHOOK_URL`
4. The GitHub Actions workflow will run every 6 hours to check for updates and post to Discord

## Manual Run

To run manually:
```bash
python scraper.py
```

Set the `DISCORD_WEBHOOK_URL` environment variable if you want to send updates to Discord.

To generate a status report of all novels:
```bash
python display_status.py
```
This creates `novel_status.md` with the current status of all novels.

## How it works

- Scrapes the team's page for novel statuses
- Compares with previous data to detect new novels, status changes, or updates
- Sends formatted messages to Discord via webhook
- Saves current state for next comparison
