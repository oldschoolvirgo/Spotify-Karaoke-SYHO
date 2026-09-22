(() => {
  const API = 'https://karaoke-search-relay.oldschoolvirgo.workers.dev';
  const $ = id => document.getElementById(id);
  let token = null, expiresAt = 0, generation = 0, party = '', timer, expiryTimer;
  let workerRuntime = null, commandRequest = null, creatingCommand = false;
  let queueEntries = [], queueAction = null, queuePending = false, queueRevision = 0, queueRead = 0;
  let queueControls = [];
  let queueDrag = null, dragFrame = null;
  let waitingNodes = new Map();
  let settingsRevision = 0, settingsPending = false, settingsDirty = false, settingsLimit = null;
  let settingsOpen = null;
  let lifecycleStatus = null, lifecyclePending = false, lifecycleRevision = 0, pollSequence = 0;
  function acceptLifecycle(data) {
    if (data.partyId !== party || !['not_started','active','ended'].includes(data.partyStatus)) return;
    if (lifecycleStatus === 'ended' && data.partyStatus !== 'ended') return;
    lifecycleStatus = data.partyStatus;
    $('party-status').textContent = { not_started: 'NOT STARTED', active: 'ACTIVE', ended: 'ENDED - This Party ID has already been used.' }[lifecycleStatus];
    $('party-times').textContent = [data.startedAt == null ? '' : `Started: ${new Date(data.startedAt).toLocaleString()}`,
      data.endedAt == null ? '' : `Ended: ${new Date(data.endedAt).toLocaleString()}`].filter(Boolean).join(' | ');
    $('party-start').hidden = lifecycleStatus !== 'not_started';
    $('party-end').hidden = lifecycleStatus !== 'active';
    $('announcement-send').disabled = lifecyclePending || lifecycleStatus !== 'active' || announcementPending;
    updateSettingsControls(); updateButtons(); updateQueueControls();
  }
  async function changeLifecycle(action) {
    if (!token || !party || lifecyclePending || lifecycleStatus !== (action === 'start' ? 'not_started' : 'active')) return;
    const revision = generation, selected = party;
    lifecyclePending = true; lifecycleRevision++;
    $('party-start').disabled = $('party-end').disabled = $('party-end-confirm').disabled = true;
    $('party-message').textContent = action === 'start' ? 'Starting...' : 'Ending...';
    try {
      const data = await request(`/admin/party/${action}`, 'POST', { partyId: selected });
      if (revision !== generation) return;
      if (data.partyId !== selected || data.partyStatus !== (action === 'start' ? 'active' : 'ended')) throw Error('Invalid lifecycle response.');
      acceptLifecycle(data); acceptSettings(data);
      $('party-message').textContent = action === 'start' ? 'Party started.' : 'Party permanently ended.';
    } catch (error) {
      if (revision !== generation) return;
      if (error.status === 401) { clearSession('Session expired.'); return; }
      $('party-message').textContent = error.message + ' Refresh the party before retrying.';
    } finally {
      if (revision === generation) {
        lifecyclePending = false; lifecycleRevision++;
        $('party-start').disabled = $('party-end').disabled = $('party-end-confirm').disabled = false;
        $('party-end-dialog').close();
        clearTimeout(timer); void poll(generation);
      }
    }
  }
  $('party-start').addEventListener('click', () => changeLifecycle('start'));
  $('party-end').addEventListener('click', () => { if (!lifecyclePending && lifecycleStatus === 'active') $('party-end-dialog').showModal(); });
  $('party-end-cancel').addEventListener('click', () => $('party-end-dialog').close());
  $('party-end-confirm').addEventListener('click', () => changeLifecycle('end'));
  let announcementPending = false;
  $('announcement-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!token || !party || lifecycleStatus !== 'active' || announcementPending) return;
    const title = $('announcement-title').value.trim(), text = $('announcement-message').value.trim();
    if (!title && !text) { $('announcement-status').textContent = 'Enter a title or message.'; return; }
    const revision = generation, selected = party;
    announcementPending = true; $('announcement-send').disabled = true;
    $('announcement-status').textContent = 'Sending...';
    try {
      const data = await request('/admin/announcement', 'POST', { partyId: selected, title, message: text });
      if (revision !== generation) return;
      if (data.partyId !== selected || !data.announcement?.id || data.announcement.title !== title ||
          data.announcement.message !== text) throw Error('Invalid announcement response.');
      $('announcement-status').textContent = 'Published for guest phones and Lyrics Display.';
    } catch (error) {
      if (revision !== generation) return;
      if (error.status === 401) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      $('announcement-status').textContent = error.status === 400 ? 'Announcement rejected. Use text within a 16 KiB request.' :
        'Send unconfirmed. Your draft is retained; sending again publishes a new announcement.';
    } finally {
      if (revision === generation) { announcementPending = false; $('announcement-send').disabled = !token || !party || lifecycleStatus !== 'active'; }
    }
  });
  function updateSettingsControls() {
    $('song-limit').disabled = lifecycleStatus !== 'active' || settingsPending || settingsLimit === null;
    $('settings-save').disabled = lifecycleStatus !== 'active' || settingsPending || settingsLimit === null;
    $('queue-state-action').disabled = lifecycleStatus !== 'active' || settingsPending || settingsOpen === null;
  }
  function acceptSettings(data) {
    if (data.partyId !== party || !Number.isInteger(data.maxSongsPerGuest) || data.maxSongsPerGuest < 1 || data.maxSongsPerGuest > 20) return;
    settingsLimit = data.maxSongsPerGuest;
    $('settings-current').textContent = `Current limit: ${settingsLimit}`;
    if (!settingsDirty) $('song-limit').value = String(settingsLimit);
    if (typeof data.queueOpen === 'boolean') {
      settingsOpen = data.queueOpen;
      $('queue-state-current').textContent = settingsOpen ? 'Queue Open' : 'Queue Closed';
      $('queue-state-action').textContent = settingsOpen ? 'Close queue' : 'Open queue';
    }
    updateSettingsControls();
  }
  const commandButtons = { 'send-ping': 'ping', 'send-normal': 'normal', 'send-loud': 'loud_this_song', 'send-restart': 'restart', 'send-play-pause': 'play_pause', 'send-next': 'next' };
  function updateButtons() {
    for (const [id, type] of Object.entries(commandButtons)) {
      $(id).disabled = lifecycleStatus !== 'active' || creatingCommand || !workerRuntime || Boolean(commandRequest?.command && !terminalCommand(commandRequest.command.status)) || Boolean(commandRequest && !commandRequest.command && commandRequest.body.type !== type);
    }
  }
  const terminalCommand = status => ['succeeded', 'failed', 'expired'].includes(status);
  function renderCommand(command) {
    $('command-status').textContent = `Status: ${command.status} - ${command.type || commandRequest?.body.type} - ${command.id}${command.reason ? ` - ${command.reason}` : ''}${command.completedAt ? ` - completed ${new Date(command.completedAt).toLocaleTimeString()}` : ''}`;
  }
  const message = text => { $('message').textContent = text; };
  function clearData() {
    lifecycleStatus = null; lifecyclePending = false; lifecycleRevision++;
    $('party-status').textContent = 'Select a party'; $('party-times').textContent = ''; $('party-message').textContent = '';
    $('party-start').hidden = $('party-end').hidden = true;
    $('party-start').disabled = $('party-end').disabled = $('party-end-confirm').disabled = false;
    $('party-end-dialog').close();
    announcementPending = false; $('announcement-send').disabled = !token || !party || lifecycleStatus !== 'active';
    $('announcement-title').value = ''; $('announcement-message').value = ''; $('announcement-status').textContent = '';
    $('estimate-count').textContent = 'Queue not loaded';
    $('estimate-duration').textContent = 'Duration unavailable';
    $('estimate-end').textContent = 'Est. end: --';
    $('estimate-unknown').textContent = '';
    settingsRevision++; settingsPending = false; settingsDirty = false; settingsLimit = null;
    settingsOpen = null; $('queue-state-current').textContent = 'Queue status: not loaded';
    $('queue-state-action').textContent = 'Close queue';
    $('song-limit').value = ''; $('settings-current').textContent = 'Current limit: not loaded';
    $('settings-message').textContent = ''; updateSettingsControls();
    endDrag(false, false);
    queueRevision++; queueEntries = []; queuePending = false;
    closeQueueAction();
    $('queue-message').textContent = '';
    for (const id of ['playing', 'up-next', 'waiting']) $(id).replaceChildren();
    for (const id of ['worker-contact', 'current-uri']) $(id).textContent = '';
    $('selected-party').textContent = 'Select a party';
    $('freshness').textContent = 'No data loaded';
    $('worker-status').textContent = 'No data loaded';
    workerRuntime = null; commandRequest = null; creatingCommand = false;
    $('send-ping').disabled = true; $('send-ping').textContent = 'Send Ping';
    updateButtons();
    $('command-status').textContent = 'No command sent.';
  }
  function clearSession(text) {
    generation++; token = null; party = ''; expiresAt = 0;
    clearTimeout(timer); clearTimeout(expiryTimer);
    $('dashboard').hidden = true; $('login-form').hidden = false;
    $('pin').value = ''; $('party').value = ''; clearData(); message(text);
  }
  async function request(path, method = 'GET', body, credential = token) {
    const response = await fetch(API + path, {
      method, cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) {
      const error = new Error(response.status === 429 ? `Too many attempts. Try again in ${response.headers.get('Retry-After') || '900'} seconds.` :
        response.status === 401 ? 'Invalid or expired credentials.' : 'Service unavailable. Try again.');
      const detail = await response.json().catch(() => ({}));
      if (detail.error && response.status === 409) error.message = detail.error;
      error.status = response.status; throw error;
    }
    return response.json();
  }
  $('song-limit').addEventListener('input', () => { settingsDirty = true; });
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!token || !party || lifecycleStatus !== 'active' || settingsPending || settingsLimit === null) return;
    const value = Number($('song-limit').value);
    if (!Number.isInteger(value) || value < 1 || value > 20) {
      $('settings-message').textContent = 'Enter a whole number from 1 to 20.'; return;
    }
    await saveSettings({ maxSongsPerGuest: value });
  });
  $('queue-state-action').addEventListener('click', async () => {
    if (!token || !party || lifecycleStatus !== 'active' || settingsPending || settingsOpen === null) return;
    await saveSettings({ queueOpen: !settingsOpen });
  });
  async function saveSettings(changes) {
    const revision = generation, selected = party;
    settingsRevision++; settingsPending = true; updateSettingsControls();
    $('settings-message').textContent = 'Saving...';
    let refresh = false;
    try {
      const data = await request('/admin/party-settings', 'PUT', { partyId: selected, ...changes });
      if (revision !== generation) return;
      if (data.partyId !== selected || !Number.isInteger(data.maxSongsPerGuest) ||
          data.maxSongsPerGuest < 1 || data.maxSongsPerGuest > 20 || typeof data.queueOpen !== 'boolean' ||
          Object.keys(changes).some(key => data[key] !== changes[key])) throw Error('Invalid settings response.');
      if (Object.hasOwn(changes, 'maxSongsPerGuest')) settingsDirty = false;
      acceptSettings(data);
      $('settings-message').textContent = 'Saved.';
    } catch (error) {
      if (revision !== generation) return;
      if (error.status === 401) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      $('settings-message').textContent = error.status === 400 ?
        (Object.hasOwn(changes, 'maxSongsPerGuest') ? 'Enter a whole number from 1 to 20.' : 'Queue setting was rejected. Refresh and try again.') :
        'Save unconfirmed. Check the current settings before trying again.';
      refresh = error.status !== 400;
    } finally {
      if (revision === generation) {
        settingsPending = false; const savedRevision = ++settingsRevision; updateSettingsControls();
        if (refresh) {
          try {
            const data = await request(`/admin/queue?partyId=${encodeURIComponent(selected)}`);
            if (revision === generation && savedRevision === settingsRevision && !settingsPending) acceptSettings(data);
          } catch (error) {
            if (revision === generation && error.status === 401) clearSession('Session expired or revoked. Enter your PIN again.');
          }
        }
      }
    }
  }
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if ($('login-button').disabled) return;
    const pin = $('pin').value; $('pin').value = '';
    if (!/^[0-9]{6}$/.test(pin)) { message('Enter exactly six digits.'); return; }
    const revision = ++generation;
    $('login-button').disabled = true; message('Signing in...');
    try {
      const data = await request('/admin/login', 'POST', { pin }, null);
      if (generation !== revision) return;
      if (!/^[0-9a-f]{64}$/.test(data.token) || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) throw Error('Invalid login response.');
      token = data.token; expiresAt = data.expiresAt;
      $('login-form').hidden = true; $('dashboard').hidden = false;
      $('party').focus();
      message('Signed in. Select your party.');
      expiryTimer = setTimeout(() => clearSession('Session expired. Enter your PIN again.'), expiresAt - Date.now());
    } catch (error) { if (generation === revision) message(error.message); }
    finally { $('login-button').disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    const previous = token;
    clearSession('Signing out...');
    const revision = generation;
    try {
      if (previous) await request('/admin/logout', 'POST', undefined, previous);
      if (generation === revision) message('Signed out.');
    } catch (error) {
      if (generation === revision) message(error.status === 401 ? 'Signed out; session is no longer valid.' : 'Signed out locally. Server revocation was not confirmed; the session will expire automatically.');
    }
  });
  function renderEstimate(entries) {
    const active = entries.filter(e => ['playing', 'up_next', 'waiting'].includes(e.status));
    const known = active.filter(e => Number.isFinite(e.durationMs) && e.durationMs > 0);
    const unknown = active.length - known.length;
    const total = known.reduce((sum, e) => sum + e.durationMs, 0);
    const now = new Date(Date.now()), end = new Date(now.getTime() + total);
    $('estimate-count').textContent = `${active.length} ${active.length === 1 ? 'song' : 'songs'} remaining`;
    $('estimate-unknown').textContent = unknown ? `${unknown} ${unknown === 1 ? 'song has' : 'songs have'} unknown duration` : '';
    $('estimate-end').textContent = 'Est. end: --';
    if (!active.length) { $('estimate-duration').textContent = '0 min of music'; return; }
    if (!known.length || !Number.isFinite(total) || !Number.isFinite(end.getTime())) {
      $('estimate-duration').textContent = 'Duration unavailable';
      $('estimate-end').textContent = 'Est. end: unavailable';
      return;
    }
    const minutes = Math.ceil(total / 60000);
    const duration = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
    $('estimate-duration').textContent = `~${duration} of ${unknown ? 'known music' : 'music'}`;
    const clock = end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const date = now.toDateString() === end.toDateString() ? '' : `${end.toLocaleDateString([], { month: 'short', day: 'numeric' })} `;
    $('estimate-end').textContent = `Est. end${unknown ? ' (known music)' : ''}: ${date}${clock}`;
  }
  function renderQueue(data, authoritative = true) {
    if (authoritative) renderEstimate(data.entries);
    queueEntries = data.entries;
    queueControls = [];
    waitingNodes = new Map();
    for (const [status, id] of [['playing', 'playing'], ['up_next', 'up-next'], ['waiting', 'waiting']]) {
      $(id).replaceChildren();
      const entries = data.entries.filter(e => e.status === status);
      for (const entry of entries) {
        const item = document.createElement('li');
        item.textContent = `${status === 'playing' ? '' : `${entry.position}. `}${entry.singerName} - ${entry.trackName} - ${entry.artistName}`;
        if (status === 'waiting') {
          const controls = document.createElement('div'); controls.className = 'queue-controls';
          for (const [action, label] of [['edit', 'Edit Singer'], ['remove', 'Remove']]) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
            button.disabled = lifecycleStatus !== 'active' || Boolean(queueAction) || queuePending;
            button.addEventListener('click', () => openQueueAction(entry.id, action));
            controls.appendChild(button); queueControls.push(button);
          }
          item.appendChild(controls);
          const handle = document.createElement('button');
          handle.type = 'button'; handle.className = 'queue-drag-handle'; handle.textContent = 'Move';
          handle.setAttribute('aria-label', `Move ${entry.trackName} for ${entry.singerName}`);
          handle.setAttribute('aria-describedby', 'reorder-help');
          handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || event.isPrimary === false) return;
            if (!startDrag(entry.id, event.pointerId)) return;
            event.preventDefault();
            $('waiting').setPointerCapture(event.pointerId);
            queueDrag.y = event.clientY;
            dragFrame = requestAnimationFrame(scrollDrag);
          });
          handle.addEventListener('keydown', event => {
            if (event.key === 'Escape' && queueDrag) { event.preventDefault(); endDrag(false); return; }
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              if (!queueDrag) startDrag(entry.id, null);
              else if (queueDrag.id === entry.id) endDrag(true);
            } else if (queueDrag?.id === entry.id && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
              event.preventDefault();
              previewMove(queueDrag.order.indexOf(entry.id) + (event.key === 'ArrowUp' ? -1 : 1));
            }
          });
          controls.appendChild(handle);
          waitingNodes.set(entry.id, { item, handle });
        }
        $(id).appendChild(item);
      }
      if (!entries.length) { const item = document.createElement('li'); item.textContent = 'None'; $(id).appendChild(item); }
    }
    updateQueueControls();
  }
  function updateQueueControls() {
    for (const button of queueControls) button.disabled = lifecycleStatus !== 'active' || Boolean(queueAction) || queuePending || Boolean(queueDrag);
    for (const [id, { handle }] of waitingNodes) handle.disabled = lifecycleStatus !== 'active' || Boolean(queueAction) || queuePending || waitingNodes.size < 2 || Boolean(queueDrag && queueDrag.id !== id);
    $('waiting').classList.toggle('queue-pending', queuePending);
    $('waiting').setAttribute('aria-busy', String(queuePending));
    for (const id of ['queue-save', 'queue-cancel', 'queue-singer']) $(id).disabled = queuePending;
  }
  function closeQueueAction() {
    queueAction = null;
    if ($('queue-dialog').open) $('queue-dialog').close();
    updateQueueControls();
  }
  function startDrag(id, pointerId) {
    if (!token || !party || queueAction || queuePending || queueDrag || waitingNodes.size < 2 || !waitingNodes.has(id)) return false;
    const order = queueEntries.filter(e => e.status === 'waiting').map(e => e.id);
    queueDrag = { id, pointerId, order: [...order], expected: order, generation, partyId: party };
    queueRevision++;
    waitingNodes.get(id).item.classList.add('queue-dragging');
    $('queue-message').textContent = 'Preview only. Release to save; Escape to cancel.';
    updateQueueControls();
    return true;
  }
  function previewMove(index) {
    const drag = queueDrag;
    if (!drag) return;
    index = Math.max(0, Math.min(drag.order.length - 1, index));
    const old = drag.order.indexOf(drag.id);
    if (old === index) return;
    drag.order.splice(old, 1); drag.order.splice(index, 0, drag.id);
    for (const id of drag.order) $('waiting').appendChild(waitingNodes.get(id).item);
    if (drag.pointerId === null) waitingNodes.get(drag.id).handle.focus();
    $('queue-message').textContent = `Preview: waiting position ${index + 1} of ${drag.order.length}. Release to save; Escape to cancel.`;
  }
  function pointerPreview() {
    const drag = queueDrag;
    if (!drag || drag.pointerId === null) return;
    const others = drag.order.filter(id => id !== drag.id);
    let index = others.findIndex(id => {
      const rect = waitingNodes.get(id).item.getBoundingClientRect();
      return drag.y < rect.top + rect.height / 2;
    });
    previewMove(index < 0 ? others.length : index);
  }
  function scrollDrag() {
    if (!queueDrag || queueDrag.pointerId === null) return;
    const y = queueDrag.y, edge = 64;
    const delta = y < edge ? -12 : y > window.innerHeight - edge ? 12 : 0;
    if (delta) { window.scrollBy(0, delta); pointerPreview(); }
    dragFrame = requestAnimationFrame(scrollDrag);
  }
  function endDrag(commit, render = true) {
    const drag = queueDrag;
    if (!drag) return;
    queueDrag = null; queueRevision++;
    cancelAnimationFrame(dragFrame); dragFrame = null;
    if (drag.pointerId !== null && $('waiting').hasPointerCapture(drag.pointerId)) $('waiting').releasePointerCapture(drag.pointerId);
    waitingNodes.get(drag.id)?.item.classList.remove('queue-dragging');
    const changed = drag.order.some((id, i) => id !== drag.expected[i]);
    if (commit && changed) { void saveOrder(drag); return; }
    if (render) {
      renderQueue({ entries: queueEntries }, false);
      waitingNodes.get(drag.id)?.handle.focus();
      $('queue-message').textContent = commit ? 'Order unchanged.' : 'Reorder canceled.';
    }
  }
  async function saveOrder(drag) {
    queuePending = true; updateQueueControls();
    $('queue-message').textContent = 'Saving order...';
    let refresh = false;
    try {
      const data = await request('/admin/queue/order', 'PUT', { partyId: drag.partyId, expectedEntryIds: drag.expected, entryIds: drag.order });
      if (generation !== drag.generation) return;
      if (data.partyId !== party || !Array.isArray(data.entries)) throw Error('Invalid queue response.');
      renderQueue(data);
      $('queue-message').textContent = 'Order saved.';
    } catch (error) {
      if (generation !== drag.generation) return;
      if (error.status === 401) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      renderQueue({ entries: queueEntries }, false); refresh = true;
      $('queue-message').textContent = error.status === 409 ? 'The waiting queue changed. Refreshing the queue.' : 'Order could not be confirmed. Check the refreshed queue before trying again.';
    } finally {
      if (generation === drag.generation) {
        queuePending = false; queueRevision++; updateQueueControls();
        if (refresh) await refreshQueueAfterAction(drag.generation);
        waitingNodes.get(drag.id)?.handle.focus();
      }
    }
  }
  $('waiting').addEventListener('pointermove', event => {
    if (!queueDrag || queueDrag.pointerId !== event.pointerId) return;
    event.preventDefault(); queueDrag.y = event.clientY; pointerPreview();
  });
  $('waiting').addEventListener('pointerup', event => {
    if (queueDrag?.pointerId === event.pointerId) endDrag(true);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) $('waiting').addEventListener(type, event => {
    if (queueDrag?.pointerId === event.pointerId) endDrag(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && queueDrag) { event.preventDefault(); endDrag(false); }
  });
  function openQueueAction(id, action) {
    if (!token || !party || queueAction || queuePending || queueDrag) return;
    const entry = queueEntries.find(e => e.id === id && e.status === 'waiting');
    if (!entry) return;
    queueAction = { id, action, partyId: party, generation };
    $('queue-message').textContent = ''; $('queue-error').textContent = '';
    $('queue-title').textContent = action === 'edit' ? 'Edit Singer' : 'Remove Song';
    $('queue-context').textContent = action === 'edit' ? `${entry.trackName} - ${entry.artistName}` : `Remove "${entry.trackName}" for ${entry.singerName}?`;
    $('queue-singer-field').hidden = action !== 'edit';
    $('queue-singer').required = action === 'edit'; $('queue-singer').value = entry.singerName;
    $('queue-save').textContent = action === 'edit' ? 'Save' : 'Remove';
    updateQueueControls(); $('queue-dialog').showModal();
    $(action === 'edit' ? 'queue-singer' : 'queue-cancel').focus();
  }
  $('queue-cancel').addEventListener('click', () => { if (!queuePending) closeQueueAction(); });
  $('queue-dialog').addEventListener('cancel', event => {
    event.preventDefault(); if (!queuePending) closeQueueAction();
  });
  async function refreshQueueAfterAction(revision) {
    const localRevision = queueRevision, read = ++queueRead;
    try {
      const data = await request(`/admin/queue?partyId=${encodeURIComponent(party)}`);
      if (revision !== generation || localRevision !== queueRevision || read !== queueRead || queuePending || queueDrag) return;
      if (data.partyId !== party || !Array.isArray(data.entries)) throw Error('Invalid queue response.');
      renderQueue(data);
    } catch (error) {
      if (revision !== generation) return;
      if (error.status === 401) clearSession('Session expired or revoked. Enter your PIN again.');
      else $('queue-message').textContent += ' Queue refresh failed; the next dashboard update will retry.';
    }
  }
  $('queue-form').addEventListener('submit', async event => {
    event.preventDefault();
    const action = queueAction;
    if (!action || queuePending || !token || action.generation !== generation || action.partyId !== party) return;
    const singerName = $('queue-singer').value;
    if (action.action === 'edit' && (!singerName.trim() || singerName.length > 40)) {
      $('queue-error').textContent = 'Enter a singer name of at most 40 characters.'; return;
    }
    queuePending = true; queueRevision++; updateQueueControls(); $('queue-error').textContent = '';
    let refresh = false;
    try {
      const data = await request(`/admin/queue/${encodeURIComponent(action.id)}`, action.action === 'edit' ? 'PUT' : 'DELETE',
        { partyId: action.partyId, ...(action.action === 'edit' ? { singerName } : {}) });
      if (action.generation !== generation || queueAction !== action) return;
      if (data.partyId !== party || !Array.isArray(data.entries)) throw Error('Invalid queue response.');
      renderQueue(data); closeQueueAction();
      $('queue-message').textContent = action.action === 'edit' ? 'Singer updated.' : 'Song removed.';
    } catch (error) {
      if (action.generation !== generation || queueAction !== action) return;
      if (error.status === 401) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      if (error.status === 400) {
        $('queue-error').textContent = 'Invalid queue request. Check the singer name and selected party.';
      } else {
        closeQueueAction(); refresh = true;
        $('queue-message').textContent = error.status === 409 ? 'This entry is no longer waiting. Refreshing the queue.' :
          error.status === 404 ? 'This entry is no longer available in this party. Refreshing the queue.' :
          'The change could not be confirmed. Check the refreshed queue before trying again.';
      }
    } finally {
      if (action.generation === generation) {
        queuePending = false; queueRevision++; updateQueueControls();
        if (refresh) await refreshQueueAfterAction(action.generation);
      }
    }
  });
  for (const [buttonId, type] of Object.entries(commandButtons)) $(buttonId).addEventListener('click', async () => {
    if (!token || !party || !workerRuntime || creatingCommand || (commandRequest?.command && !terminalCommand(commandRequest.command.status))) return;
    if (commandRequest && !commandRequest.command && commandRequest.body.type !== type) return;
    // Keep the same request ID/body after ambiguous creation failures.
    if (!commandRequest || commandRequest.command) commandRequest = { body: { partyId: party, runtimeId: workerRuntime, requestId: crypto.randomUUID(), type } };
    const attempt = commandRequest, revision = generation;
    creatingCommand = true; updateButtons();
    $('command-status').textContent = `Submitting ${type} - execution not yet confirmed.`;
    try {
      const data = await request('/admin/commands', 'POST', attempt.body);
      if (revision !== generation || commandRequest !== attempt) return;
      if (data.command?.id !== attempt.body.requestId || data.command?.partyId !== party || data.command?.runtimeId !== attempt.body.runtimeId) throw Error('Invalid command response.');
      attempt.command = data.command; renderCommand(data.command);
    } catch (error) {
      if (revision !== generation || commandRequest !== attempt) return;
      if (error.status === 401) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        commandRequest = null;
        $('command-status').textContent = 'Command rejected. A recent matching worker is required.';
      } else {
        $('command-status').textContent = 'Creation unconfirmed. Press the same button to retry with the same request ID.';
      }
    } finally {
      if (revision === generation) {
        creatingCommand = false;
        $('send-ping').textContent = commandRequest?.body.type === 'ping' && !commandRequest.command ? 'Retry Ping' : 'Send Ping';
        updateButtons();
      }
    }
  });
  async function poll(revision) {
    const polling = ++pollSequence;
    if (!token || revision !== generation || !party) return;
    if (Date.now() >= expiresAt) { clearSession('Session expired. Enter your PIN again.'); return; }
    try {
      const query = `?partyId=${encodeURIComponent(party)}`;
      const tracking = commandRequest;
      const pollCommand = tracking?.command && !terminalCommand(tracking.command.status);
      const localQueueRevision = queueRevision, read = ++queueRead;
      const localSettingsRevision = settingsRevision, localLifecycleRevision = lifecycleRevision;
      const reads = [request('/admin/queue' + query), request('/admin/state' + query)];
      if (pollCommand) reads.push(request(`/admin/commands/${encodeURIComponent(tracking.command.id)}` + query));
      const results = await Promise.allSettled(reads);
      if (revision !== generation || !token || polling !== pollSequence) return;
      const unauthorized = results.some(r => r.status === 'rejected' && r.reason.status === 401);
      if (unauthorized) { clearSession('Session expired or revoked. Enter your PIN again.'); return; }
      if (pollCommand && tracking === commandRequest && results[2].status === 'fulfilled') {
        const command = results[2].value.command;
        if (command?.id !== tracking.command.id || command?.partyId !== party || command?.runtimeId !== tracking.body.runtimeId) throw Error('Invalid command status.');
        tracking.command = command; renderCommand(command);
      }
      const failed = results.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;
      const [queue, state] = results.map(r => r.value);
      if (queue.partyId !== party || state.partyId !== party || !Array.isArray(queue.entries)) throw Error('Invalid party response.');
      if (!lifecyclePending && localLifecycleRevision === lifecycleRevision) {
        acceptLifecycle(queue);
        if (!settingsPending && localSettingsRevision === settingsRevision) acceptSettings(queue);
      }
      if (!queuePending && !queueDrag && localQueueRevision === queueRevision && read === queueRead) renderQueue(queue);
      workerRuntime = state.status === 'recent' ? state.worker?.runtimeId : null;
      updateButtons();
      $('worker-status').textContent = `Worker: ${state.status}`;
      $('worker-contact').textContent = state.worker ? `Last contact: ${new Date(state.worker.receivedAt).toLocaleTimeString()}` : 'No heartbeat received for this party.';
      $('current-uri').textContent = `Spotify current URI: ${state.worker?.currentUri || 'Unavailable'}`;
      $('freshness').textContent = `Updated ${new Date().toLocaleTimeString()}`;
      message('');
    } catch (error) {
      if (revision === generation) {
        $('freshness').textContent = 'Data stale - refresh failed.';
        $('worker-status').textContent = 'Worker: unknown - status read failed.';
        workerRuntime = null; updateButtons();
        if (commandRequest?.command && !terminalCommand(commandRequest.command.status)) $('command-status').textContent = `Command status stale - last confirmed: ${commandRequest.command.status} - ${commandRequest.command.id}`;
        message(error.message);
      }
    } finally {
      if (token && revision === generation && polling === pollSequence) timer = setTimeout(() => poll(revision), 5000);
    }
  }
  $('party-form').addEventListener('submit', event => {
    event.preventDefault();
    const selected = $('party').value.trim();
    if (!token || !/^[0-9]{1,80}$/.test(selected)) { message('Enter a valid Party ID.'); return; }
    clearTimeout(timer); generation++; party = selected; clearData();
    $('selected-party').textContent = `Party: ${party}`;
    void poll(generation);
  });
  $('pin').focus();
})();
