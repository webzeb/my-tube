// MyTube - Distraction-free YouTube subscription feed

(function () {
  'use strict';

  // --- Storage helpers ---
  const STORAGE_KEYS = {
    API_KEY: 'mytube_api_key',
    CHANNELS: 'mytube_channels',
    FILTER_SHORTS: 'mytube_filter_shorts',
    VIDEO_CACHE: 'mytube_video_cache',
    CACHE_TIME: 'mytube_cache_time',
  };

  function store(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  // --- State ---
  let apiKey = load(STORAGE_KEYS.API_KEY, '');
  let channels = load(STORAGE_KEYS.CHANNELS, []);
  // channels: [{ id, title, thumbnail, uploadsPlaylistId }]
  let filterShorts = load(STORAGE_KEYS.FILTER_SHORTS, true);

  // --- DOM refs ---
  const $ = (sel) => document.querySelector(sel);
  const setupScreen = $('#setup-screen');
  const feedScreen = $('#feed-screen');
  const emptyState = $('#empty-state');
  const loadingState = $('#loading-state');
  const videoGrid = $('#video-grid');
  const addChannelModal = $('#add-channel-modal');
  const settingsModal = $('#settings-modal');
  const channelInput = $('#channel-input');
  const channelResults = $('#channel-results');
  const channelList = $('#channel-list');
  const filterShortsToggle = $('#filter-shorts');
  const settingsApiKeyInput = $('#settings-api-key');
  const refreshBtn = $('#refresh-btn');

  // --- YouTube API ---
  const API_BASE = 'https://www.googleapis.com/youtube/v3';

  async function ytFetch(endpoint, params) {
    const url = new URL(`${API_BASE}/${endpoint}`);
    params.key = apiKey;
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const resp = await fetch(url.toString());
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err?.error?.message || `API error ${resp.status}`;
      throw new Error(msg);
    }
    return resp.json();
  }

  async function searchChannels(query) {
    // Try handle-based lookup first (cheaper: 1 unit vs 100)
    if (query.startsWith('@')) {
      try {
        const data = await ytFetch('channels', {
          part: 'snippet,contentDetails,statistics',
          forHandle: query,
        });
        if (data.items?.length) return data.items;
      } catch {
        // Fall through to search
      }
    }

    // Try as channel ID
    if (/^UC[\w-]{22}$/.test(query)) {
      try {
        const data = await ytFetch('channels', {
          part: 'snippet,contentDetails,statistics',
          id: query,
        });
        if (data.items?.length) return data.items;
      } catch {
        // Fall through
      }
    }

    // Extract channel ID or handle from URL
    const urlMatch = query.match(
      /youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.-]+)|c\/([\w.-]+))/
    );
    if (urlMatch) {
      const [, channelId, handle, customName] = urlMatch;
      if (channelId) {
        const data = await ytFetch('channels', {
          part: 'snippet,contentDetails,statistics',
          id: channelId,
        });
        if (data.items?.length) return data.items;
      }
      if (handle) {
        const data = await ytFetch('channels', {
          part: 'snippet,contentDetails,statistics',
          forHandle: handle,
        });
        if (data.items?.length) return data.items;
      }
      if (customName) {
        // Fall through to search with custom name
        query = customName;
      }
    }

    // General search (costs 100 quota units)
    const data = await ytFetch('search', {
      part: 'snippet',
      q: query,
      type: 'channel',
      maxResults: 5,
    });

    if (!data.items?.length) return [];

    // Enrich with full channel details
    const ids = data.items.map((i) => i.snippet.channelId).join(',');
    const details = await ytFetch('channels', {
      part: 'snippet,contentDetails,statistics',
      id: ids,
    });
    return details.items || [];
  }

  async function fetchChannelVideos(channel, maxResults = 10) {
    const playlistId = channel.uploadsPlaylistId;
    const data = await ytFetch('playlistItems', {
      part: 'snippet',
      playlistId: playlistId,
      maxResults: maxResults,
    });

    if (!data.items?.length) return [];

    const videoIds = data.items
      .map((i) => i.snippet.resourceId.videoId)
      .join(',');

    const details = await ytFetch('videos', {
      part: 'contentDetails,statistics,snippet',
      id: videoIds,
    });

    return (details.items || []).map((v) => ({
      id: v.id,
      title: v.snippet.title,
      thumbnail:
        v.snippet.thumbnails.high?.url ||
        v.snippet.thumbnails.medium?.url ||
        v.snippet.thumbnails.default?.url,
      channelTitle: v.snippet.channelTitle,
      channelId: v.snippet.channelId,
      channelAvatar: channel.thumbnail,
      publishedAt: v.snippet.publishedAt,
      duration: v.contentDetails.duration,
      durationSeconds: parseDuration(v.contentDetails.duration),
      viewCount: parseInt(v.statistics.viewCount || '0', 10),
    }));
  }

  function parseDuration(iso) {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const h = parseInt(match[1] || 0);
    const m = parseInt(match[2] || 0);
    const s = parseInt(match[3] || 0);
    return h * 3600 + m * 60 + s;
  }

  function formatDuration(seconds) {
    if (seconds <= 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function formatViewCount(count) {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
    return `${count} views`;
  }

  function formatTimeAgo(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}d ago`;
    if (diffSec < 31536000) return `${Math.floor(diffSec / 2592000)}mo ago`;
    return `${Math.floor(diffSec / 31536000)}y ago`;
  }

  function formatSubCount(count) {
    const n = parseInt(count, 10);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M subscribers`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K subscribers`;
    return `${n} subscribers`;
  }

  // --- UI Rendering ---
  function showScreen() {
    if (!apiKey) {
      setupScreen.classList.remove('hidden');
      feedScreen.classList.add('hidden');
    } else {
      setupScreen.classList.add('hidden');
      feedScreen.classList.remove('hidden');
      if (channels.length === 0) {
        emptyState.classList.remove('hidden');
        videoGrid.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        videoGrid.classList.remove('hidden');
      }
    }
  }

  function renderVideoCard(video) {
    const card = document.createElement('article');
    card.className = 'video-card';
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.innerHTML = `
      <div class="video-thumb-container">
        <img src="${video.thumbnail}" alt="" loading="lazy">
        <span class="video-duration">${formatDuration(video.durationSeconds)}</span>
      </div>
      <div class="video-info">
        <img class="channel-avatar" src="${video.channelAvatar}" alt="" loading="lazy">
        <div class="video-meta">
          <div class="video-title">${escapeHtml(video.title)}</div>
          <div class="video-channel">${escapeHtml(video.channelTitle)}</div>
          <div class="video-stats">${formatViewCount(video.viewCount)} · ${formatTimeAgo(video.publishedAt)}</div>
        </div>
      </div>
    `;
    card.addEventListener('click', () => {
      window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
      }
    });
    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderFeed(videos) {
    videoGrid.innerHTML = '';
    if (videos.length === 0) {
      emptyState.classList.remove('hidden');
      videoGrid.classList.add('hidden');
      return;
    }
    emptyState.classList.add('hidden');
    videoGrid.classList.remove('hidden');
    videos.forEach((v) => videoGrid.appendChild(renderVideoCard(v)));
  }

  async function loadFeed(useCache = true) {
    if (channels.length === 0) {
      showScreen();
      return;
    }

    // Check cache (5 minutes)
    if (useCache) {
      const cacheTime = load(STORAGE_KEYS.CACHE_TIME, 0);
      const cachedVideos = load(STORAGE_KEYS.VIDEO_CACHE, null);
      if (cachedVideos && Date.now() - cacheTime < 5 * 60 * 1000) {
        let videos = cachedVideos;
        if (filterShorts) {
          videos = videos.filter((v) => v.durationSeconds >= 60);
        }
        renderFeed(videos);
        return;
      }
    }

    loadingState.classList.remove('hidden');
    videoGrid.classList.add('hidden');
    emptyState.classList.add('hidden');

    try {
      const results = await Promise.all(
        channels.map((ch) => fetchChannelVideos(ch).catch(() => []))
      );
      let allVideos = results.flat();

      // Sort by publish date (newest first)
      allVideos.sort(
        (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
      );

      // Cache the unfiltered results
      store(STORAGE_KEYS.VIDEO_CACHE, allVideos);
      store(STORAGE_KEYS.CACHE_TIME, Date.now());

      // Apply shorts filter
      if (filterShorts) {
        allVideos = allVideos.filter((v) => v.durationSeconds >= 60);
      }

      renderFeed(allVideos);
    } catch (err) {
      showToast(`Failed to load feed: ${err.message}`);
    } finally {
      loadingState.classList.add('hidden');
    }
  }

  function renderChannelList() {
    channelList.innerHTML = '';
    if (channels.length === 0) {
      channelList.innerHTML =
        '<p class="channel-list-empty">No channels added yet.</p>';
      return;
    }
    channels.forEach((ch) => {
      const item = document.createElement('div');
      item.className = 'channel-item';
      item.innerHTML = `
        <img src="${ch.thumbnail}" alt="">
        <span class="channel-item-name">${escapeHtml(ch.title)}</span>
        <button class="channel-remove-btn" title="Remove channel">&times;</button>
      `;
      item.querySelector('.channel-remove-btn').addEventListener('click', () => {
        removeChannel(ch.id);
      });
      channelList.appendChild(item);
    });
  }

  function addChannel(channelData) {
    if (channels.some((c) => c.id === channelData.id)) {
      showToast('Channel already added');
      return false;
    }
    const ch = {
      id: channelData.id,
      title: channelData.snippet.title,
      thumbnail: channelData.snippet.thumbnails.default?.url || '',
      uploadsPlaylistId:
        channelData.contentDetails.relatedPlaylists.uploads,
    };
    channels.push(ch);
    store(STORAGE_KEYS.CHANNELS, channels);
    showToast(`Added ${ch.title}`);
    return true;
  }

  function removeChannel(id) {
    const ch = channels.find((c) => c.id === id);
    channels = channels.filter((c) => c.id !== id);
    store(STORAGE_KEYS.CHANNELS, channels);
    store(STORAGE_KEYS.VIDEO_CACHE, null);
    store(STORAGE_KEYS.CACHE_TIME, 0);
    renderChannelList();
    if (ch) showToast(`Removed ${ch.title}`);
    if (channels.length === 0) {
      showScreen();
    }
  }

  // --- Toast notifications ---
  function showToast(message, duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
  }

  // --- Modal helpers ---
  function openModal(modal) {
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modal) {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function setupModalClose(modal) {
    modal.querySelector('.modal-backdrop').addEventListener('click', () => {
      closeModal(modal);
    });
    modal.querySelector('.modal-close').addEventListener('click', () => {
      closeModal(modal);
    });
  }

  // --- Event handlers ---
  function init() {
    // Setup screen
    $('#setup-save-btn').addEventListener('click', () => {
      const key = $('#setup-api-key').value.trim();
      if (!key) {
        showToast('Please enter an API key');
        return;
      }
      apiKey = key;
      store(STORAGE_KEYS.API_KEY, apiKey);
      showScreen();
      showToast('API key saved!');
    });

    $('#setup-api-key').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#setup-save-btn').click();
    });

    // Settings
    $('#settings-btn').addEventListener('click', () => {
      settingsApiKeyInput.value = apiKey;
      filterShortsToggle.checked = filterShorts;
      renderChannelList();
      openModal(settingsModal);
    });

    $('#settings-save-key').addEventListener('click', () => {
      const key = settingsApiKeyInput.value.trim();
      if (!key) {
        showToast('Please enter an API key');
        return;
      }
      apiKey = key;
      store(STORAGE_KEYS.API_KEY, apiKey);
      showToast('API key updated');
    });

    settingsApiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#settings-save-key').click();
    });

    filterShortsToggle.addEventListener('change', () => {
      filterShorts = filterShortsToggle.checked;
      store(STORAGE_KEYS.FILTER_SHORTS, filterShorts);
      loadFeed(true); // Reload from cache with new filter
    });

    // Refresh
    refreshBtn.addEventListener('click', () => {
      refreshBtn.classList.add('spinning');
      loadFeed(false).finally(() => {
        refreshBtn.classList.remove('spinning');
      });
    });

    // Add channel modal
    const openAddChannel = () => {
      channelInput.value = '';
      channelResults.innerHTML = '';
      openModal(addChannelModal);
      setTimeout(() => channelInput.focus(), 100);
    };

    $('#fab-add').addEventListener('click', openAddChannel);
    $('#empty-add-btn').addEventListener('click', openAddChannel);

    $('#channel-search-btn').addEventListener('click', doChannelSearch);
    channelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doChannelSearch();
    });

    async function doChannelSearch() {
      const query = channelInput.value.trim();
      if (!query) return;

      channelResults.innerHTML =
        '<p class="search-status">Searching...</p>';

      try {
        const results = await searchChannels(query);
        if (results.length === 0) {
          channelResults.innerHTML =
            '<p class="search-status">No channels found. Try a different search.</p>';
          return;
        }
        channelResults.innerHTML = '';
        results.forEach((ch) => {
          const isAdded = channels.some((c) => c.id === ch.id);
          const div = document.createElement('div');
          div.className = 'channel-result';
          div.innerHTML = `
            <img src="${ch.snippet.thumbnails.default?.url || ''}" alt="">
            <div class="channel-result-info">
              <div class="channel-result-name">${escapeHtml(ch.snippet.title)}</div>
              <div class="channel-result-subs">${ch.statistics ? formatSubCount(ch.statistics.subscriberCount) : ''}</div>
            </div>
            <button class="add-btn ${isAdded ? 'added' : ''}">${isAdded ? 'Added' : 'Add'}</button>
          `;
          const btn = div.querySelector('.add-btn');
          if (!isAdded) {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const added = addChannel(ch);
              if (added) {
                btn.textContent = 'Added';
                btn.classList.add('added');
                // Reload feed in background
                loadFeed(false);
              }
            });
          }
          channelResults.appendChild(div);
        });
      } catch (err) {
        channelResults.innerHTML = `<p class="search-status">Error: ${escapeHtml(err.message)}</p>`;
      }
    }

    // Modal close handlers
    setupModalClose(addChannelModal);
    setupModalClose(settingsModal);

    // Keyboard escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!addChannelModal.classList.contains('hidden'))
          closeModal(addChannelModal);
        if (!settingsModal.classList.contains('hidden'))
          closeModal(settingsModal);
      }
    });

    // Initial render
    showScreen();
    if (apiKey && channels.length > 0) {
      loadFeed(true);
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
