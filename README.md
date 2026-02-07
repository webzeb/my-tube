# MyTube

A distraction-free YouTube feed. Only videos from channels you choose — no Shorts, no recommendations, no algorithm.

## How It Works

MyTube is a static single-page app that uses the YouTube Data API to fetch recent videos from channels you subscribe to. Everything runs in your browser with no backend server required. Your channel list and API key are stored in your browser's localStorage.

## Setup

### 1. Get a YouTube API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select an existing one)
3. Navigate to **APIs & Services > Library**
4. Search for and enable **YouTube Data API v3**
5. Go to **APIs & Services > Credentials**
6. Click **Create Credentials > API Key**
7. Copy the key

### 2. Deploy with GitHub Pages

1. Go to your repo's **Settings > Pages**
2. Under **Source**, select **Deploy from a branch**
3. Select the `main` branch and `/ (root)` folder
4. Click **Save**
5. Your site will be live at `https://<username>.github.io/my-tube/`

### 3. Use the App

1. Open the deployed URL on your phone
2. Paste your API key when prompted
3. Tap the **+** button to add YouTube channels
4. Your feed will populate with recent videos from those channels

**Tip:** On iOS, tap Share > "Add to Home Screen" to use MyTube like a native app.

## Features

- **Channel management** — Add channels by handle (@username), URL, or search
- **Shorts filtering** — Automatically hides videos under 60 seconds (toggle in settings)
- **Mobile-first** — Designed for phone use with touch-friendly UI
- **No backend** — Everything runs client-side via GitHub Pages
- **Offline-friendly** — 5-minute video cache so you don't burn API quota

## API Quota

The YouTube Data API has a daily quota of 10,000 units. MyTube is designed to be efficient:

| Operation | Cost | When |
|-----------|------|------|
| Channel lookup by handle/URL | 1 unit | Adding a channel |
| Channel search by name | 100 units | Adding a channel (fallback) |
| Fetch uploads playlist | 1 unit per channel | Loading feed |
| Fetch video details | 1 unit per channel | Loading feed |

With 10 channels, a feed refresh costs ~20 units. You can refresh ~500 times per day.
