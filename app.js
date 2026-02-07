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
    WATCHED_IDS: 'mytube_watched_ids',
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
  // channels: [{ id, title, thumbnail, uploadsPlaylistId, tags: string[] }]
  let filterShorts = load(STORAGE_KEYS.FILTER_SHORTS, true);
  let watchedIds = new Set(load(STORAGE_KEYS.WATCHED_IDS, []));
  let activeTab = 'new'; // 'new' or 'watched'
  let activeTag = 'all'; // 'all' or a specific tag string
  let cachedVideos = []; // in-memory copy for re-filtering without API calls

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
  const tagFilterBar = $('#tag-filter-bar');

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

  async function fetchChannelVideos(channel, maxResults = 50) {
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

  // --- Tags ---
  function getAllTags() {
    const tagSet = new Set();
    channels.forEach((ch) => {
      (ch.tags || []).forEach((t) => tagSet.add(t));
    });
    return Array.from(tagSet).sort();
  }

  function getChannelIdsByTag(tag) {
    if (tag === 'all') return null; // no filter
    return new Set(
      channels.filter((ch) => (ch.tags || []).includes(tag)).map((ch) => ch.id)
    );
  }

  function renderTagFilterBar() {
    const allTags = getAllTags();
    if (allTags.length === 0) {
      tagFilterBar.classList.add('hidden');
      activeTag = 'all';
      return;
    }
    tagFilterBar.classList.remove('hidden');
    tagFilterBar.innerHTML = '';

    const makeTagPill = (label, value) => {
      const btn = document.createElement('button');
      btn.className = `tag-pill${activeTag === value ? ' active' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        activeTag = value;
        renderTagFilterBar();
        applyFiltersAndRender();
      });
      return btn;
    };

    tagFilterBar.appendChild(makeTagPill('All', 'all'));
    allTags.forEach((tag) => tagFilterBar.appendChild(makeTagPill(tag, tag)));
  }

  // --- Watched ---
  function markWatched(videoId) {
    watchedIds.add(videoId);
    store(STORAGE_KEYS.WATCHED_IDS, Array.from(watchedIds));
  }

  function markUnwatched(videoId) {
    watchedIds.delete(videoId);
    store(STORAGE_KEYS.WATCHED_IDS, Array.from(watchedIds));
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
        tagFilterBar.classList.add('hidden');
      } else {
        emptyState.classList.add('hidden');
        videoGrid.classList.remove('hidden');
      }
    }
  }

  function renderVideoCard(video) {
    const isWatched = watchedIds.has(video.id);
    const card = document.createElement('article');
    card.className = 'video-card';
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');

    // Checkmark SVG for watched button
    const checkSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
    // Undo SVG for unwatched button
    const undoSvg = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>`;

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
        <div class="video-actions">
          <button class="watched-btn ${isWatched ? 'is-watched' : ''}" title="${isWatched ? 'Mark as unwatched' : 'Mark as watched'}">
            ${isWatched ? undoSvg : checkSvg}
          </button>
        </div>
      </div>
    `;

    // Open video on click (but not on the watched button)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.watched-btn')) return;
      window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.target.closest('.watched-btn')) {
        window.open(`https://www.youtube.com/watch?v=${video.id}`, '_blank');
      }
    });

    // Watched toggle
    card.querySelector('.watched-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (isWatched) {
        markUnwatched(video.id);
      } else {
        markWatched(video.id);
      }
      applyFiltersAndRender();
    });

    return card;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function applyFiltersAndRender() {
    let videos = [...cachedVideos];

    // Shorts filter (under 5 minutes)
    if (filterShorts) {
      videos = videos.filter((v) => v.durationSeconds >= 300);
    }

    // Tag filter
    const allowedChannelIds = getChannelIdsByTag(activeTag);
    if (allowedChannelIds) {
      videos = videos.filter((v) => allowedChannelIds.has(v.channelId));
    }

    // Tab filter (new vs watched)
    if (activeTab === 'new') {
      videos = videos.filter((v) => !watchedIds.has(v.id));
    } else {
      videos = videos.filter((v) => watchedIds.has(v.id));
    }

    renderFeed(videos);
  }

  function renderFeed(videos) {
    videoGrid.innerHTML = '';
    if (videos.length === 0 && channels.length === 0) {
      emptyState.classList.remove('hidden');
      videoGrid.classList.add('hidden');
      return;
    }
    emptyState.classList.add('hidden');
    videoGrid.classList.remove('hidden');

    if (videos.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'no-results';
      msg.textContent =
        activeTab === 'watched'
          ? 'No watched videos yet. Tap the checkmark on a video to mark it as watched.'
          : 'No new videos to show.';
      videoGrid.appendChild(msg);
      return;
    }

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
      const cached = load(STORAGE_KEYS.VIDEO_CACHE, null);
      if (cached && Date.now() - cacheTime < 5 * 60 * 1000) {
        cachedVideos = cached;
        renderTagFilterBar();
        applyFiltersAndRender();
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
      cachedVideos = allVideos;
      store(STORAGE_KEYS.VIDEO_CACHE, allVideos);
      store(STORAGE_KEYS.CACHE_TIME, Date.now());

      renderTagFilterBar();
      applyFiltersAndRender();
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

      // Main row: avatar + name + remove
      const mainRow = `
        <img src="${ch.thumbnail}" alt="">
        <span class="channel-item-name">${escapeHtml(ch.title)}</span>
        <button class="channel-remove-btn" title="Remove channel">&times;</button>
      `;

      // Tags row
      const tags = ch.tags || [];
      let tagsHtml = '<div class="channel-tags-row">';
      tags.forEach((tag) => {
        tagsHtml += `<span class="channel-tag">${escapeHtml(tag)}<button class="tag-remove" data-tag="${escapeHtml(tag)}">&times;</button></span>`;
      });
      tagsHtml += `<button class="channel-tag-add-btn">+ tag</button>`;
      tagsHtml += '</div>';

      item.innerHTML = mainRow + tagsHtml;

      // Remove channel
      item.querySelector('.channel-remove-btn').addEventListener('click', () => {
        removeChannel(ch.id);
      });

      // Remove individual tag
      item.querySelectorAll('.tag-remove').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tag = btn.dataset.tag;
          ch.tags = (ch.tags || []).filter((t) => t !== tag);
          store(STORAGE_KEYS.CHANNELS, channels);
          renderChannelList();
          renderTagFilterBar();
          applyFiltersAndRender();
        });
      });

      // Add tag button
      item.querySelector('.channel-tag-add-btn').addEventListener('click', (e) => {
        const addBtn = e.target;
        const row = addBtn.closest('.channel-tags-row');
        addBtn.classList.add('hidden');

        const input = document.createElement('input');
        input.className = 'channel-tag-inline-input';
        input.placeholder = 'tag name';
        row.appendChild(input);
        input.focus();

        const commitTag = () => {
          const tag = input.value.trim().toLowerCase();
          if (tag && !(ch.tags || []).includes(tag)) {
            ch.tags = [...(ch.tags || []), tag];
            store(STORAGE_KEYS.CHANNELS, channels);
            renderTagFilterBar();
            applyFiltersAndRender();
          }
          renderChannelList();
        };

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') commitTag();
          if (ev.key === 'Escape') renderChannelList();
        });
        input.addEventListener('blur', commitTag);
      });

      channelList.appendChild(item);
    });
  }

  function addChannel(channelData, tags) {
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
      tags: tags || [],
    };
    channels.push(ch);
    store(STORAGE_KEYS.CHANNELS, channels);
    renderTagFilterBar();
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
    renderTagFilterBar();
    if (ch) showToast(`Removed ${ch.title}`);
    if (channels.length === 0) {
      cachedVideos = [];
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

  // --- Sync / Export / Import ---
  function getSettingsPayload() {
    return {
      apiKey,
      channels,
      filterShorts,
      watchedIds: Array.from(watchedIds),
    };
  }

  function applySettingsPayload(data) {
    if (data.apiKey) {
      apiKey = data.apiKey;
      store(STORAGE_KEYS.API_KEY, apiKey);
    }
    if (data.channels) {
      channels = data.channels;
      store(STORAGE_KEYS.CHANNELS, channels);
    }
    if (typeof data.filterShorts === 'boolean') {
      filterShorts = data.filterShorts;
      store(STORAGE_KEYS.FILTER_SHORTS, filterShorts);
    }
    if (data.watchedIds) {
      watchedIds = new Set(data.watchedIds);
      store(STORAGE_KEYS.WATCHED_IDS, data.watchedIds);
    }
    // Clear video cache so we re-fetch
    store(STORAGE_KEYS.VIDEO_CACHE, null);
    store(STORAGE_KEYS.CACHE_TIME, 0);
    cachedVideos = [];
  }

  function generateSyncLink() {
    const payload = getSettingsPayload();
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = '';
    url.hash = 'sync=' + encoded;
    return url.toString();
  }

  function checkSyncFromUrl() {
    const hash = window.location.hash;
    if (!hash.startsWith('#sync=')) return false;
    try {
      const encoded = hash.slice(6);
      const json = decodeURIComponent(escape(atob(encoded)));
      const data = JSON.parse(json);
      applySettingsPayload(data);
      // Clean up URL
      history.replaceState(null, '', window.location.pathname);
      showToast('Settings synced from link!');
      return true;
    } catch {
      showToast('Invalid sync link');
      return false;
    }
  }

  function exportSettings() {
    const payload = getSettingsPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mytube-settings.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Settings exported');
  }

  function importSettings(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        applySettingsPayload(data);
        showScreen();
        renderTagFilterBar();
        if (apiKey && channels.length > 0) {
          loadFeed(false);
        }
        showToast('Settings imported!');
      } catch {
        showToast('Invalid settings file');
      }
    };
    reader.readAsText(file);
  }

  // --- Event handlers ---
  function init() {
    // Check for sync data in URL
    const synced = checkSyncFromUrl();
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
      applyFiltersAndRender();
    });

    // Sync / Export / Import
    $('#copy-sync-link').addEventListener('click', () => {
      const link = generateSyncLink();
      navigator.clipboard.writeText(link).then(
        () => showToast('Sync link copied! Open it on your other device.'),
        () => {
          // Fallback for older browsers
          prompt('Copy this link:', link);
        }
      );
    });

    $('#export-settings').addEventListener('click', exportSettings);

    const importFileInput = $('#import-file-input');
    $('#import-settings').addEventListener('click', () => {
      importFileInput.click();
    });
    importFileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) {
        importSettings(e.target.files[0]);
        e.target.value = '';
      }
    });

    // Tab switching
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeTab = tab.dataset.tab;
        applyFiltersAndRender();
      });
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
          const wrapper = document.createElement('div');

          // Channel result row
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
          wrapper.appendChild(div);

          // Tag input row (shown after clicking Add)
          const tagRow = document.createElement('div');
          tagRow.className = 'channel-tag-input hidden';
          tagRow.innerHTML = `
            <input type="text" placeholder="Tags (comma-separated, optional)">
            <button>Save</button>
          `;
          wrapper.appendChild(tagRow);

          const btn = div.querySelector('.add-btn');
          if (!isAdded) {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              // Show tag input
              tagRow.classList.remove('hidden');
              btn.textContent = 'Adding...';
              btn.classList.add('added');
              const tagInput = tagRow.querySelector('input');
              tagInput.focus();

              const doAdd = () => {
                const rawTags = tagInput.value
                  .split(',')
                  .map((t) => t.trim().toLowerCase())
                  .filter(Boolean);
                const added = addChannel(ch, rawTags);
                if (added) {
                  btn.textContent = 'Added';
                  tagRow.classList.add('hidden');
                  loadFeed(false);
                }
              };

              tagRow.querySelector('button').addEventListener('click', doAdd);
              tagInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') doAdd();
              });
            });
          }

          channelResults.appendChild(wrapper);
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
      renderTagFilterBar();
      loadFeed(synced ? false : true);
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
