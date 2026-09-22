const SEARCH_API_BASE_URL = "https://karaoke-search-relay.oldschoolvirgo.workers.dev";
const SEARCH_TIMEOUT_MS = 30000;
const SEARCH_POLL_INTERVAL_MS = 1000;
const POPULAR_CACHE_KEY = "karaokePopularSongs";
const POPULAR_INITIAL_LIMIT = 5;

let songs = [];
let popularSongs = [];
let popularSongsExpanded = false;
let activeSongView = "queue";
let popularLoadPromise = null;

const GUEST_ID_STORAGE_KEY = "karaokeGuestId";
const partyId = new URLSearchParams(window.location.search).get("partyId") || "";
function isValidPartyId(value) {
  return /^[0-9]{1,80}$/.test(value);
}
const validPartyId = isValidPartyId(partyId);
const QUEUE_POLL_INTERVAL_MS = 5000;
const SELECTION_QUEUE_POLL_INTERVAL_MS = 15000;

function getGuestId() {
  try {
    const storedGuestId = localStorage.getItem(GUEST_ID_STORAGE_KEY);
    if (storedGuestId) return storedGuestId;

    const newGuestId = crypto.randomUUID();
    localStorage.setItem(GUEST_ID_STORAGE_KEY, newGuestId);
    return newGuestId;
  } catch (error) {
    console.warn("Guest identity could not be persisted for this browser session:", error);
    return crypto.randomUUID();
  }
}

// This is only a rendering snapshot. D1 owns the persistent queue.
let partyStatus = null, queuePollTimer = null, searchAbort = null;
function inactiveParty(status = 'not_started') {
  partyStatus = status;
  clearInterval(queuePollTimer); queuePollTimer = null;
  clearTimeout(selectionQueueTimer); selectionQueueTimer = null;
  clearTimeout(announcementTimer); announcementTimer = null; announcement = null; announcementRevision++;
  searchAbort?.abort();
  queue = []; queueOpen = false; queueLoaded = false;
  showScreen(joinScreen);
  partyCodeInput.value = partyId;
  updateSubmissionState();
  partyCodeError.textContent = status === 'ended' ? 'This karaoke party has ended. Enter another Party ID.' : 'No active karaoke party was found for this Party ID. Retry or enter another ID.';
}
let queue = [];
let queueLoaded = false;
let queueError = "";
let queueRevision = 0;
let queueRefreshPromise = null;
let queueMutationPending = false;
let queueOpen = null;
let maxSongsPerGuest = null;
let announcement = null, announcementTimer = null, announcementRevision = 0;
let lastAnnouncementId = null, lastAnnouncementPublishedAt = -1;
function acceptAnnouncement(snapshot) {
  const next = snapshot.announcement;
  if (!queuePageActive || snapshot.partyId !== partyId || !next || typeof next.id !== 'string' || !next.id ||
      typeof next.title !== 'string' || typeof next.message !== 'string' || !(next.title.trim() || next.message.trim()) ||
      !Number.isFinite(next.publishedAt) || !Number.isFinite(next.expiresAt) || next.expiresAt <= Date.now() ||
      next.id === lastAnnouncementId || next.publishedAt < lastAnnouncementPublishedAt) return;
  lastAnnouncementId = next.id; lastAnnouncementPublishedAt = next.publishedAt;
  announcement = next;
  clearTimeout(announcementTimer);
  const revision = ++announcementRevision;
  announcementTimer = setTimeout(() => {
    if (revision !== announcementRevision) return;
    announcement = null; announcementTimer = null; updateSubmissionState();
  }, 10000);
}
let selectionQueueTimer = null;
let selectionQueueCheckPending = false;
let queuePageActive = true;
let queueRefreshSilent = false;
const guestId = getGuestId();

const joinScreen = document.querySelector("#join-screen");
const joinForm = document.querySelector("#join-form");
const partyCodeInput = document.querySelector("#party-code");
const partyCodeError = document.querySelector("#party-code-error");
const searchScreen = document.querySelector("#search-screen");
const selectionScreen = document.querySelector("#selection-screen");
const editScreen = document.querySelector("#edit-screen");
const successScreen = document.querySelector("#success-screen");
const searchInput = document.querySelector("#search-input");
const searchForm = document.querySelector("#search-form");
const searchButton = document.querySelector("#search-button");
const songResults = document.querySelector("#song-results");
const resultsHeading = document.querySelector(".results-heading");
const resultsTitle = document.querySelector("#results-title");
const resultCount = document.querySelector("#result-count");
const singerForm = document.querySelector("#singer-form");
const singerNameInput = document.querySelector("#singer-name");
const nameError = document.querySelector("#name-error");
const queueNotice = document.querySelector("#queue-notice");
const editForm = document.querySelector("#edit-form");
const editSingerNameInput = document.querySelector("#edit-singer-name");
const editNameError = document.querySelector("#edit-name-error");
const removeDialog = document.querySelector("#remove-dialog");
const removeDialogMessage = document.querySelector("#remove-dialog-message");
const queueTab = document.querySelector("#queue-tab");
const popularTab = document.querySelector("#popular-tab");
const popularToggle = document.querySelector("#popular-toggle");

let selectedSong = null;
let editingEntryId = null;

function showScreen(screenToShow) {
  if (partyStatus !== 'active') screenToShow = joinScreen;
  [joinScreen, searchScreen, selectionScreen, editScreen, successScreen].forEach((screen) => {
    screen.hidden = screen !== screenToShow;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
  updateQueueStatusCheck();
  syncSelectionQueuePolling();
}

function hideQueueNotice() {
  queueNotice.hidden = true;
  queueNotice.textContent = "";
}

function showQueueNotice(message) {
  queueNotice.textContent = message;
  queueNotice.hidden = false;
  queueNotice.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function queueIsVisible() {
  return activeSongView === "queue" && !searchScreen.hidden &&
    resultsHeading.classList.contains("is-tab-summary");
}

async function queueRequest(path = "/queue", method = "GET", data = {}) {
  if (!validPartyId) throw new Error("Open the party link supplied by your host to use the shared queue.");
  const url = new URL(`${SEARCH_API_BASE_URL}${path}`);
  const options = { method, cache: "no-store", signal: AbortSignal.timeout(15000) };
  if (method === "GET") {
    url.searchParams.set("partyId", partyId);
    url.searchParams.set("guestId", guestId);
  } else {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify({ ...data, partyId, guestId });
  }
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Could not reach the shared queue. Check your connection and return to Tonight's Queue before retrying.");
  }
  const snapshot = await response.json();
  if (snapshot.code === 'party_inactive') inactiveParty(snapshot.partyStatus);
  if (!response.ok) {
    const error = new Error(snapshot.error || "The shared queue is temporarily unavailable.");
    error.code = snapshot.code;
    error.maxSongsPerGuest = snapshot.maxSongsPerGuest;
    throw error;
  }
  return snapshot;
}

function showSongLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 20) return;
  maxSongsPerGuest = value;
  renderQueueStatus();
  const hint = document.querySelector('#song-limit-hint');
  hint.textContent = `You can have up to ${value} active ${value === 1 ? 'song' : 'songs'}.`;
  hint.hidden = false;
}

function shouldPollSelectionQueue() {
  return partyStatus === 'active' && validPartyId && queuePageActive && !document.hidden && !selectionScreen.hidden;
}

function syncSelectionQueuePolling() {
  if (!shouldPollSelectionQueue()) {
    clearTimeout(selectionQueueTimer);
    selectionQueueTimer = null;
    return;
  }
  if (selectionQueueTimer !== null || selectionQueueCheckPending) return;
  // Selection needs both Open -> Closed and Closed -> Open checks; other views do not use this timer.
  selectionQueueTimer = setTimeout(async () => {
    selectionQueueTimer = null;
    if (!shouldPollSelectionQueue()) return;
    selectionQueueCheckPending = true;
    try {
      await refreshQueue({ background: true });
    } finally {
      selectionQueueCheckPending = false;
      syncSelectionQueuePolling();
    }
  }, SELECTION_QUEUE_POLL_INTERVAL_MS);
}

function renderQueueStatus() {
  document.querySelector('#queue-state').hidden = !validPartyId || ['not_started','ended'].includes(partyStatus);
  document.querySelector('#queue-state').setAttribute('data-state', announcement ? 'announcement' : queueOpen === true ? 'open' : queueOpen === false ? 'closed' : 'unknown');
  const title = announcement ? announcement.title : queueOpen === true ? 'Queue Open' : queueOpen === false ? 'Queue Closed' : 'Checking queue status\u2026';
  const message = announcement ? announcement.message : queueOpen === false ? 'Existing songs will still play' : queueOpen === true && maxSongsPerGuest !== null ?
    `Up to ${maxSongsPerGuest} ${maxSongsPerGuest === 1 ? 'song' : 'songs'} per guest` : '';
  // Avoid repeating live-region updates on every poll when the status has not changed.
  const titleElement = document.querySelector('#queue-state-text');
  const messageElement = document.querySelector('#queue-state-message');
  if (titleElement.textContent !== title) titleElement.textContent = title;
  if (messageElement.textContent !== message) messageElement.textContent = message;
}

function updateQueueStatusCheck() {
  // Polling views discover reopening automatically, including between scheduled checks.
  document.querySelector('#queue-status-check').hidden = partyStatus !== 'active' ||
    !joinScreen.hidden || Boolean(announcement) || queueOpen !== false ||
    queueIsVisible() || !selectionScreen.hidden;
}

function updateSubmissionState() {
  singerForm.querySelector('button[type="submit"]').disabled = queueMutationPending || partyStatus !== 'active' || queueOpen === false;
  renderQueueStatus();
  updateQueueStatusCheck();
  document.querySelector('#queue-status-check').disabled = queueMutationPending || Boolean(queueRefreshPromise);
  syncSelectionQueuePolling();
}

document.querySelector('#queue-status-check').addEventListener('click', async () => {
  if (queueMutationPending) return;
  await refreshQueue();
});

function acceptQueue(snapshot) {
  if (snapshot.partyId !== partyId || !['active','ended','not_started'].includes(snapshot.partyStatus)) throw Error('Invalid party response.');
  if (partyStatus === 'ended') return;
  if (snapshot.partyStatus !== 'active') { inactiveParty(snapshot.partyStatus); return; }
  const firstActive = partyStatus !== 'active';
  partyStatus = 'active';
  if (firstActive) {
    partyCodeError.textContent = '';
    showScreen(searchScreen);
    activeSongView = 'queue'; updateSongViewTabs();
    resultsHeading.classList.add('is-tab-summary');
    queuePollTimer = setInterval(() => {
      if (partyStatus === 'active' && queuePageActive && !document.hidden && queueIsVisible()) void refreshQueue();
    }, QUEUE_POLL_INTERVAL_MS);
  }
  acceptAnnouncement(snapshot);
  if (typeof snapshot.queueOpen === 'boolean') queueOpen = snapshot.queueOpen;
  if (queueOpen === true && nameError.textContent === 'The karaoke queue is currently closed.') nameError.textContent = '';
  updateSubmissionState();
  showSongLimit(snapshot.maxSongsPerGuest);
  const staleNotice = queueError && `${queueError} Showing the last retrieved queue.`;
  queue = snapshot.entries.map((entry) => ({ ...entry, song: mapSearchResults([entry])[0] }));
  queueLoaded = true;
  queueError = "";
  if (staleNotice && queueNotice.textContent === staleNotice) hideQueueNotice();
}

function refreshQueue({ background = false } = {}) {
  if (queueRefreshPromise) {
    if (!background) queueRefreshSilent = false; // A manual check can join a quiet automatic read.
    return queueRefreshPromise;
  }
  if (queueMutationPending) return queueRefreshPromise;
  queueRefreshSilent = background;
  const revision = queueRevision;
  queueRefreshPromise = (async () => {
    try {
      const snapshot = await queueRequest();
      if (revision === queueRevision) acceptQueue(snapshot);
    } catch (error) {
      if (revision === queueRevision && !queueRefreshSilent) queueError = error.message;
      if (partyStatus === null) partyCodeError.textContent = 'Could not check this party. Retry or change Party ID.';
    } finally {
      queueRefreshPromise = null;
      if (!queueRefreshSilent || !queueError) document.querySelector('#queue-status-error').textContent = queueError ? 'Status refresh failed. Showing the last known queue status.' : '';
      updateSubmissionState();
      if (queueIsVisible()) renderQueue();
    }
  })();
  updateSubmissionState();
  return queueRefreshPromise;
}

async function mutateQueue(path, method, data) {
  queueRevision += 1;
  const snapshot = await queueRequest(path, method, data);
  acceptQueue(snapshot);
  return snapshot;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function mapSearchResults(results) {
  return results.map((track) => ({
    id: track.spotifyUri,
    trackName: track.trackName,
    artist: track.artistName,
    album: track.albumName,
    artworkUrl: track.albumImageUrl || "https://placehold.co/300x300/251b38/ffffff?text=No+Artwork",
    spotifyUri: track.spotifyUri,
    durationMs: track.durationMs,
    duration: formatDuration(track.durationMs),
    explicit: track.explicit === true
  }));
}

function shuffledCopy(songs) {
  const shuffled = [...songs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function initializePopularSongs(tracks) {
  // Keep the first non-empty list in its shuffled order for this page session.
  if (popularSongs.length || !tracks.length) return;
  popularSongs = shuffledCopy(mapSearchResults(tracks));
}

function readPopularCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(POPULAR_CACHE_KEY));
    return cached && Array.isArray(cached.tracks) ? cached : null;
  } catch (error) {
    console.warn("Popular songs cache could not be read:", error);
    return null;
  }
}

function writePopularCache(snapshot, etag) {
  try {
    localStorage.setItem(POPULAR_CACHE_KEY, JSON.stringify({ ...snapshot, etag }));
  } catch (error) {
    console.warn("Popular songs cache could not be saved:", error);
  }
}

function renderPopularSongs() {
  resultsTitle.textContent = "Popular songs";
  resultCount.textContent = popularSongs.length ? `${popularSongs.length} songs` : "";

  if (!popularSongs.length) {
    songResults.innerHTML = '<div class="empty-state">Popular songs are temporarily unavailable.</div>';
    popularToggle.hidden = true;
    return;
  }

  const visibleSongs = popularSongsExpanded ? popularSongs : popularSongs.slice(0, POPULAR_INITIAL_LIMIT);
  songResults.innerHTML = visibleSongs.map((song, index) => `
    <article class="song-card">
      <img class="album-art" src="${escapeHtml(song.artworkUrl)}" alt="${escapeHtml(song.album)} album artwork" loading="lazy" />
      <div class="song-info">
        <h3 class="song-title song-title-with-badge">${songTitleMarkup(song, `${index + 1}. `)}</h3>
        <p class="song-meta">${escapeHtml(song.artist)} \u00B7 ${escapeHtml(song.album)}</p>
        <p class="song-meta">${escapeHtml(song.duration)}</p>
      </div>
      <div class="song-actions">
        <button class="add-button" type="button" data-popular-song-id="${escapeHtml(song.id)}">Add Song</button>
      </div>
    </article>
  `).join("");

  popularToggle.hidden = popularSongs.length <= POPULAR_INITIAL_LIMIT;
  popularToggle.textContent = popularSongsExpanded ? "Show fewer" : `Show all ${popularSongs.length}`;
}

async function loadPopularSongs() {
  const cached = readPopularCache();
  if (cached) {
    initializePopularSongs(cached.tracks);
    if (activeSongView === "popular") renderPopularSongs();
  }

  try {
    const headers = cached?.etag ? { "If-None-Match": cached.etag } : {};
    const response = await fetch(`${SEARCH_API_BASE_URL}/popular?partyId=${encodeURIComponent(partyId)}`, { headers });
    if (response.status === 304) return;
    if (!response.ok) {
      const failure = await response.json();
      if (failure.code === 'party_inactive') inactiveParty(failure.partyStatus);
      throw new Error(`Popular songs request returned ${response.status}`);
    }

    const snapshot = await response.json();
    if (!Array.isArray(snapshot.tracks)) throw new Error("Popular songs response was invalid");

    initializePopularSongs(snapshot.tracks);
    writePopularCache(snapshot, response.headers.get("ETag") || snapshot.sessionId || "");
    if (activeSongView === "popular") renderPopularSongs();
  } catch (error) {
    console.error("Popular songs failed to load:", error);
    if (!cached && activeSongView === "popular") renderPopularSongs();
  }
}

function updateSongViewTabs() {
  const queueIsActive = activeSongView === "queue";
  queueTab.setAttribute("aria-selected", String(queueIsActive));
  popularTab.setAttribute("aria-selected", String(!queueIsActive));
  queueTab.tabIndex = queueIsActive ? 0 : -1;
  popularTab.tabIndex = queueIsActive ? -1 : 0;
  songResults.setAttribute("aria-labelledby", queueIsActive ? "queue-tab" : "popular-tab");
}

function showSongView(view) {
  activeSongView = view;
  searchInput.value = "";
  hideQueueNotice();
  resultsHeading.classList.add("is-tab-summary");
  updateSongViewTabs();
  updateQueueStatusCheck();

  if (view === "queue") {
    popularToggle.hidden = true;
    renderQueue();
    void refreshQueue();
    return;
  }

  if (popularSongs.length) {
    renderPopularSongs();
  } else {
    resultsTitle.textContent = "Popular songs";
    resultCount.textContent = "";
    songResults.innerHTML = '<div class="empty-state">Loading popular songs...</div>';
    popularToggle.hidden = true;
  }

  if (!popularLoadPromise) {
    popularLoadPromise = loadPopularSongs().finally(() => {
      if (!popularSongs.length) popularLoadPromise = null;
    });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestSpotifySearch(query) {
  if (partyStatus !== 'active') throw Error('No active party.');
  const controller = new AbortController();
  searchAbort = controller;
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const createResponse = await fetch(`${SEARCH_API_BASE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, partyId }),
      signal: controller.signal
    });

    if (!createResponse.ok) {
      const failure = await createResponse.json();
      if (failure.code === 'party_inactive') inactiveParty(failure.partyStatus);
      throw new Error(failure.error || 'Could not create search job');
    }
    const { jobId } = await createResponse.json();
    if (!jobId) throw new Error("Search job response did not include an ID");

    while (!controller.signal.aborted) {
      await delay(SEARCH_POLL_INTERVAL_MS);
      const statusResponse = await fetch(`${SEARCH_API_BASE_URL}/search/${encodeURIComponent(jobId)}?partyId=${encodeURIComponent(partyId)}`, {
        signal: controller.signal
      });
      if (!statusResponse.ok) {
        const failure = await statusResponse.json();
        if (failure.code === 'party_inactive') inactiveParty(failure.partyStatus);
        throw new Error(failure.error || 'Could not read search job');
      }

      const job = await statusResponse.json();
      if (job.status === "complete") return job.results;
      if (job.status === "failed") throw new Error("Spicetify search failed");
    }

    throw new Error("Search job timed out");
  } finally {
    clearTimeout(timeout);
    if (searchAbort === controller) searchAbort = null;
  }
}

async function searchSongs(query) {
  const results = await requestSpotifySearch(query);
  return mapSearchResults(results);
}

function explicitBadge(song) {
  if (!song.explicit) return "";

  return `
    <svg class="explicit-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16" role="img" aria-label="Explicit content">
      <path d="M2.5 0A2.5 2.5 0 0 0 0 2.5v11A2.5 2.5 0 0 0 2.5 16h11a2.5 2.5 0 0 0 2.5-2.5v-11A2.5 2.5 0 0 0 13.5 0zm4.326 10.88H10.5V12h-5V4.002h5v1.12H6.826V7.4h3.457v1.073H6.826z"/>
    </svg>
  `;
}

function songTitleMarkup(song, prefix = "") {
  return `<span>${escapeHtml(prefix)}${escapeHtml(song.trackName)}</span>${explicitBadge(song)}`;
}

function capitalizeSingerName(input) {
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  input.value = input.value.replace(/(^|\s)(\p{L})/gu, (match, spacing, letter) => `${spacing}${letter.toUpperCase()}`);
  input.setSelectionRange(selectionStart, selectionEnd);
}

function renderSongs(songList) {
  if (songList.length === 0) {
    songResults.innerHTML = '<div class="empty-state">No songs found. Try another title or artist.</div>';
    resultCount.textContent = "0 songs";
    return;
  }

  resultCount.textContent = `${songList.length} ${songList.length === 1 ? "song" : "songs"}`;
  songResults.innerHTML = songList.map((song) => `
    <article class="song-card">
      <img class="album-art" src="${escapeHtml(song.artworkUrl)}" alt="${escapeHtml(song.album)} album artwork" />
      <div class="song-info">
        <h3 class="song-title song-title-with-badge">
          ${songTitleMarkup(song)}
        </h3>
        <p class="song-meta">${escapeHtml(song.artist)} · ${escapeHtml(song.album)}</p>
        <p class="song-meta">${escapeHtml(song.duration)}</p>
      </div>
      <div class="song-actions">
        <button class="add-button" type="button" data-song-id="${escapeHtml(song.id)}">Add Song</button>
      </div>
    </article>
  `).join("");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#039;",
    '"': "&quot;"
  })[character]);
}

function renderQueue() {
  resultsTitle.textContent = "Tonight's queue";

  if (!validPartyId || !queueLoaded) {
    resultCount.textContent = "";
    const message = !validPartyId
      ? "Open the party link supplied by your host to use the shared queue."
      : queueError || "Loading tonight's queue...";
    songResults.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    return;
  }

  if (queueError) showQueueNotice(`${queueError} Showing the last retrieved queue.`);

  if (queue.length === 0) {
    resultCount.textContent = "0 songs";
    songResults.innerHTML = '<div class="empty-state">The queue is empty. Search for a song to be the first singer.</div>';
    return;
  }

  resultCount.textContent = `${queue.length} ${queue.length === 1 ? "song" : "songs"}`;
  songResults.innerHTML = queue.map(({ id, song, singerName, isOwner, status }, index) => `
    <article class="song-card">
      <img class="album-art" src="${escapeHtml(song.artworkUrl)}" alt="${escapeHtml(song.album)} album artwork" />
      <div class="song-info">
        <h3 class="song-title song-title-with-badge">${songTitleMarkup(song, `${index + 1}. `)}</h3>
        <p class="song-meta">${escapeHtml(song.artist)} · ${escapeHtml(song.album)}</p>
        <p class="song-meta">Singer: ${escapeHtml(singerName)}</p>
        ${index === 0 ? '<p class="song-meta" style="white-space: normal; color: #ffd54f"><strong>Up Next</strong> - Cannot be edited or removed.</p>' : ""}
      </div>
      ${isOwner && status === "waiting" && index > 0 ? `
        <div class="song-actions">
          <button class="manage-button" type="button" data-manage-entry-id="${id}">Manage</button>
        </div>
      ` : ""}
    </article>
  `).join("");
}

function openEditScreen(entryId) {
  const entry = queue.find((item, index) => item.id === entryId && item.isOwner && item.status === "waiting" && index > 0);
  if (!entry) return;

  hideQueueNotice();
  editingEntryId = entry.id;
  document.querySelector("#edit-artwork").src = entry.song.artworkUrl;
  document.querySelector("#edit-artwork").alt = `${entry.song.album} album artwork`;
  document.querySelector("#edit-title").innerHTML = songTitleMarkup(entry.song);
  document.querySelector("#edit-artist").textContent = `${entry.song.artist} · ${entry.song.album}`;
  editSingerNameInput.value = entry.singerName;
  editNameError.textContent = "";
  showScreen(editScreen);
  editSingerNameInput.focus();
  editSingerNameInput.select();
}

function returnToQueue(message = "") {
  editingEntryId = null;
  showSongView("queue");
  showScreen(searchScreen);
  if (message) showQueueNotice(message);
}

function selectSong(song) {
  if (!song) return;
  if (!validPartyId) {
    showQueueNotice("Open the party link supplied by your host to use the shared queue.");
    return;
  }

  hideQueueNotice();
  selectedSong = song;
  document.querySelector("#selected-artwork").src = song.artworkUrl;
  document.querySelector("#selected-artwork").alt = `${song.album} album artwork`;
  document.querySelector("#selected-title").innerHTML = songTitleMarkup(song);
  document.querySelector("#selected-artist").textContent = `${song.artist} · ${song.album}`;
  singerNameInput.value = "";
  nameError.textContent = "";
  showScreen(selectionScreen);
  updateSubmissionState();
  void refreshQueue(); // Refresh on entry in addition to the 15-second selection checks.
  singerNameInput.focus();
}

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const searchTerm = searchInput.value.trim();
  hideQueueNotice();

  if (!searchTerm) {
    showQueueNotice("Enter a song or artist to search Spotify.");
    searchInput.focus();
    return;
  }

  resultsTitle.textContent = "Search results";
  resultsHeading.classList.remove("is-tab-summary");
  updateQueueStatusCheck();
  resultCount.textContent = "";
  songResults.innerHTML = '<div class="empty-state">Searching Spotify...</div>';
  popularToggle.hidden = true;
  searchButton.disabled = true;
  searchButton.textContent = "Searching...";

  try {
    songs = await searchSongs(searchTerm);
    renderSongs(songs);
  } catch (error) {
    console.error("Song search failed:", error);
    songs = [];
    resultCount.textContent = "0 songs";
    songResults.innerHTML = '<div class="empty-state">Song search is temporarily unavailable. Please try again.</div>';
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = "Search";
  }
});

songResults.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-song-id]");
  const manageButton = event.target.closest("[data-manage-entry-id]");

  if (addButton) {
    const song = songs.find((item) => String(item.id) === addButton.dataset.songId);
    selectSong(song);
  }

  if (manageButton) {
    openEditScreen(manageButton.dataset.manageEntryId);
  }
});

songResults.addEventListener("click", (event) => {
  const addButton = event.target.closest("[data-popular-song-id]");
  if (!addButton) return;

  const song = popularSongs.find((item) => String(item.id) === addButton.dataset.popularSongId);
  if (song) selectSong(song);
});

queueTab.addEventListener("click", () => showSongView("queue"));
popularTab.addEventListener("click", () => showSongView("popular"));

[queueTab, popularTab].forEach((tab) => {
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();

    const showQueue = event.key === "ArrowLeft" || event.key === "Home";
    const nextTab = showQueue ? queueTab : popularTab;
    showSongView(showQueue ? "queue" : "popular");
    nextTab.focus();
  });
});

popularToggle.addEventListener("click", () => {
  popularSongsExpanded = !popularSongsExpanded;
  renderPopularSongs();
});

singerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (queueMutationPending || !selectedSong) return;
  if (queueOpen === false) {
    nameError.textContent = 'The karaoke queue is currently closed.';
    updateSubmissionState(); return;
  }
  const singerName = singerNameInput.value.trim();

  if (!singerName) {
    nameError.textContent = "Please enter a singer name before joining the queue.";
    singerNameInput.focus();
    return;
  }

  const song = selectedSong;
  queueMutationPending = true;
  updateSubmissionState();
  document.querySelector("#back-button").disabled = true;
  nameError.textContent = "";
  try {
    const snapshot = await mutateQueue("/queue", "POST", {
      singerName, spotifyUri: song.spotifyUri, trackName: song.trackName,
      artistName: song.artist, albumName: song.album, albumImageUrl: song.artworkUrl,
      durationMs: song.durationMs, explicit: song.explicit
    });
    document.querySelector("#confirmation-singer").textContent = snapshot.entry.singerName;
    document.querySelector("#confirmation-song").innerHTML = songTitleMarkup(song);
    document.querySelector("#confirmation-position").textContent = `#${snapshot.entry.position}`;
    activeSongView = "queue";
    updateSongViewTabs();
    showScreen(successScreen);
  } catch (error) {
    if (error.code === 'queue_closed') queueOpen = false;
    if (error.code === 'queue_guest_limit') showSongLimit(error.maxSongsPerGuest);
    nameError.textContent = error.message;
  } finally {
    queueMutationPending = false;
    updateSubmissionState();
    document.querySelector("#back-button").disabled = false;
  }
});

singerNameInput.addEventListener("input", () => {
  capitalizeSingerName(singerNameInput);
  if (singerNameInput.value.trim()) nameError.textContent = "";
});

editSingerNameInput.addEventListener("input", () => {
  capitalizeSingerName(editSingerNameInput);
  if (editSingerNameInput.value.trim()) editNameError.textContent = "";
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (queueMutationPending) return;
  const entry = queue.find((item, index) => item.id === editingEntryId && item.isOwner && item.status === "waiting" && index > 0);
  if (!entry) {
    returnToQueue("That queue entry is no longer available.");
    return;
  }

  const singerName = editSingerNameInput.value.trim();
  if (!singerName) {
    editNameError.textContent = "Please enter a singer name.";
    editSingerNameInput.focus();
    return;
  }

  setQueueEditPending(true);
  editNameError.textContent = "";
  try {
    await mutateQueue(`/queue/${encodeURIComponent(entry.id)}`, "PUT", { singerName });
    returnToQueue(`${entry.song.trackName} was updated.`);
  } catch (error) {
    editNameError.textContent = error.message;
  } finally {
    setQueueEditPending(false);
  }
});

function setQueueEditPending(pending) {
  queueMutationPending = pending;
  editForm.querySelectorAll("button").forEach((button) => { button.disabled = pending; });
  document.querySelector("#edit-back-button").disabled = pending;
  document.querySelector("#confirm-remove-button").disabled = pending;
}

document.querySelector("#remove-song-button").addEventListener("click", () => {
  const entry = queue.find((item, index) => item.id === editingEntryId && item.isOwner && item.status === "waiting" && index > 0);
  if (!entry) {
    returnToQueue("That queue entry is no longer available.");
    return;
  }

  removeDialogMessage.textContent = `${entry.song.trackName} will be removed from your queue selections.`;
  removeDialog.showModal();
});

document.querySelector("#confirm-remove-button").addEventListener("click", async (event) => {
  event.preventDefault();
  if (queueMutationPending) return;
  removeDialog.close();
  const entry = queue.find((item, index) => item.id === editingEntryId && item.isOwner && item.status === "waiting" && index > 0);
  if (!entry) {
    returnToQueue("That queue entry is no longer available.");
    return;
  }

  setQueueEditPending(true);
  editNameError.textContent = "";
  try {
    await mutateQueue(`/queue/${encodeURIComponent(entry.id)}`, "DELETE", {});
    returnToQueue(`${entry.song.trackName} was removed from the queue.`);
  } catch (error) {
    editNameError.textContent = error.message;
  } finally {
    setQueueEditPending(false);
  }
});

document.querySelector("#back-button").addEventListener("click", () => showScreen(searchScreen));
document.querySelector("#edit-back-button").addEventListener("click", () => returnToQueue());
document.querySelector("#search-again-button").addEventListener("click", () => {
  selectedSong = null;
  showSongView("queue");
  showScreen(searchScreen);
  searchInput.focus();
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = partyCodeInput.value.trim();
  if (!isValidPartyId(code)) {
    partyCodeError.textContent = code
      ? "Use 1 to 80 digits for your party code."
      : "Please enter tonight's party code.";
    partyCodeInput.setAttribute("aria-invalid", "true");
    partyCodeInput.focus();
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("partyId", code);
  window.location.assign(url.href);
});

partyCodeInput.addEventListener("input", () => {
  partyCodeError.textContent = "";
  partyCodeInput.removeAttribute("aria-invalid");
});

if (validPartyId) {
  showScreen(joinScreen);
  partyCodeInput.value = partyId;
  partyCodeError.textContent = 'Checking party...';
  void refreshQueue();
  document.addEventListener("visibilitychange", () => {
    syncSelectionQueuePolling();
    if (!document.hidden && queuePageActive) {
      if (queueIsVisible()) void refreshQueue();
      else if (shouldPollSelectionQueue()) void refreshQueue({ background: true });
    }
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(announcementTimer); announcementTimer = null; announcementRevision++; announcement = null;
    updateSubmissionState();
    queuePageActive = false;
    syncSelectionQueuePolling();
  });
  window.addEventListener('pageshow', () => {
    queuePageActive = true;
    syncSelectionQueuePolling();
    if (shouldPollSelectionQueue()) void refreshQueue({ background: true });
  });
} else {
  showScreen(joinScreen);
}
