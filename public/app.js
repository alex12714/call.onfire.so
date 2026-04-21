/* ============================================
   OnFire Call - Application Logic
   ============================================ */

(function () {
  'use strict';

  // ------------------------------------
  // Configuration
  // ------------------------------------
  const API_BASE = 'https://api2.onfire.so';
  const DEEP_LINK_BASE = 'https://call.onfire.so';
  const POLL_INTERVAL = 3000; // 3 seconds

  // ------------------------------------
  // State
  // ------------------------------------
  let state = {
    token: null,           // URL path token
    callLink: null,        // Data from get_call_link
    joinData: null,        // Data from join_call_as_guest
    room: null,            // LiveKit Room instance
    localVideoTrack: null,
    localAudioTrack: null,
    isMicMuted: false,
    isVideoOff: false,
    callStartTime: null,
    timerInterval: null,
    previewStream: null,
    isPreviewCameraOff: false,
    isPreviewMicOff: false,
    isScreenSharing: false,
    remoteScreenShareTrack: null,
    remoteScreenShareParticipant: null,
    pollTimer: null,       // Polling timer for start-meeting flow
    hasSeenInitialRoster: false, // true ~2s after Connected; suppresses join chime for pre-existing participants
    isHandRaised: false,   // Local raise-hand UI state; mirrors localParticipant.attributes.handRaised
  };

  // Toast queue for "X raised their hand" notifications.
  const _raiseHandToastQueue = [];
  let _raiseHandToastActive = false;

  // ------------------------------------
  // DOM References
  // ------------------------------------
  const $ = (id) => document.getElementById(id);

  const screens = {
    landing: $('screen-landing'),
    loading: $('screen-loading'),
    error: $('screen-error'),
    startMeeting: $('screen-start-meeting'),
    meetingReady: $('screen-meeting-ready'),
    join: $('screen-join'),
    call: $('screen-call'),
    ended: $('screen-ended'),
  };

  // ------------------------------------
  // Screen Management
  // ------------------------------------
  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[name].classList.add('active');

    // Landing page needs scrollable body
    if (name === 'landing') {
      document.body.classList.add('landing-active');
      document.documentElement.style.overflow = 'auto';
      document.body.style.overflow = 'auto';
    } else {
      document.body.classList.remove('landing-active');
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    }
  }

  function showError(title, message) {
    $('error-title').textContent = title;
    $('error-message').textContent = message;
    showScreen('error');
  }

  // ------------------------------------
  // Utility
  // ------------------------------------
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ------------------------------------
  // API Layer
  // ------------------------------------
  async function apiCall(endpoint, body) {
    const resp = await fetch(`${API_BASE}/rpc/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  async function getCallLink(linkToken) {
    return apiCall('get_call_link', { p_link_token: linkToken });
  }

  async function joinCallAsGuest(linkToken, guestName) {
    return apiCall('join_call_as_guest', {
      p_link_token: linkToken,
      p_guest_name: guestName || 'Guest',
    });
  }

  // ------------------------------------
  // Start Meeting Screen (link doesn't exist)
  // ------------------------------------
  function showStartMeetingScreen(slug) {
    // Display the slug
    $('display-slug').textContent = slug;

    // Generate QR code pointing to the deep link with action=create
    const qrUrl = DEEP_LINK_BASE + '/' + slug + '?action=create';

    try {
      new QRious({
        element: $('qr-code-canvas'),
        value: qrUrl,
        size: 290,
        level: 'M',
        background: '#ffffff',
        foreground: '#1a1f26',
        padding: 0,
      });
    } catch (e) {
      console.error('QR code generation failed:', e);
    }

    showScreen('startMeeting');

    // Start polling for the link to be created
    startPolling(slug);
  }

  // ------------------------------------
  // Polling Logic
  // ------------------------------------
  function startPolling(slug) {
    stopPolling();

    state.pollTimer = setInterval(async () => {
      try {
        const data = await getCallLink(slug);

        if (!data.error) {
          // Link was created — stop polling and show meeting ready screen
          stopPolling();
          state.callLink = data;
          showMeetingReadyScreen(slug, data);
        }
      } catch (err) {
        // Ignore poll errors — just keep trying
        console.debug('Poll check:', err.message);
      }
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ------------------------------------
  // Meeting Ready Screen
  // ------------------------------------
  function showMeetingReadyScreen(slug, data) {
    const meetingUrl = DEEP_LINK_BASE + '/' + slug;

    // Set the link input
    $('ready-meeting-link').value = meetingUrl;

    // Creator info
    const name = (data.creator_name || '').trim();
    if (name) {
      $('ready-creator-initials').textContent = getInitials(name);
      $('ready-creator-text').textContent = 'Created by ' + name;
      $('creator-ready-info').style.display = '';
    } else {
      $('creator-ready-info').style.display = 'none';
    }

    // Copy button
    $('btn-copy-link').addEventListener('click', function () {
      navigator.clipboard.writeText(meetingUrl).then(function () {
        $('copy-label').textContent = 'Copied!';
        setTimeout(function () { $('copy-label').textContent = 'Copy'; }, 2000);
      }).catch(function () {
        // Fallback: select the input
        $('ready-meeting-link').select();
        document.execCommand('copy');
        $('copy-label').textContent = 'Copied!';
        setTimeout(function () { $('copy-label').textContent = 'Copy'; }, 2000);
      });
    });

    // Share button (Web Share API)
    $('btn-share-link').addEventListener('click', function () {
      if (navigator.share) {
        navigator.share({
          title: 'Join my OnFire meeting',
          text: 'Join my meeting on OnFire',
          url: meetingUrl,
        }).catch(function () { /* user cancelled */ });
      } else {
        // Fallback: copy to clipboard
        navigator.clipboard.writeText(meetingUrl);
        $('copy-label').textContent = 'Copied!';
        setTimeout(function () { $('copy-label').textContent = 'Copy'; }, 2000);
      }
    });

    // Join button → go to normal join flow
    $('btn-join-ready').addEventListener('click', function () {
      renderJoinScreen(data);
    });

    showScreen('meetingReady');
  }

  // ------------------------------------
  // Join Screen Logic
  // ------------------------------------
  function renderJoinScreen(data) {
    // Creator name
    const name = (data.creator_name || '').trim();
    $('creator-name').textContent = name || 'Someone';
    $('creator-initials').textContent = getInitials(name);

    // Creator avatar
    if (data.creator_avatar) {
      const img = document.createElement('img');
      img.src = data.creator_avatar;
      img.alt = name;
      img.onerror = () => {
        img.remove();
        $('creator-initials').style.display = '';
      };
      $('creator-initials').style.display = 'none';
      $('creator-avatar').appendChild(img);
    }

    // Call type
    const isVideo = data.call_type === 'video';
    $('call-type-text').textContent = isVideo ? 'Video Call' : 'Audio Call';
    $('call-type-icon').innerHTML = isVideo
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.11 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

    // Video preview for video calls
    if (isVideo) {
      $('video-preview-container').classList.remove('hidden');
      startVideoPreview();
    }

    // Mobile app prompt
    if (isMobile()) {
      $('mobile-app-prompt').classList.remove('hidden');
      $('btn-open-app').href = DEEP_LINK_BASE + '/' + state.token;
    }

    // Input & button logic
    const nameInput = $('guest-name');
    const joinBtn = $('btn-join');

    function updateJoinButton() {
      joinBtn.disabled = !nameInput.value.trim();
    }

    nameInput.addEventListener('input', updateJoinButton);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && nameInput.value.trim()) {
        handleJoin();
      }
    });

    joinBtn.addEventListener('click', handleJoin);

    // Focus name input on desktop
    if (!isMobile()) {
      setTimeout(() => nameInput.focus(), 300);
    }

    showScreen('join');
  }

  // ------------------------------------
  // Video Preview
  // ------------------------------------
  function _onToggleCameraPreview() {
    state.isPreviewCameraOff = !state.isPreviewCameraOff;
    if (state.previewStream) {
      state.previewStream.getVideoTracks().forEach(t => t.enabled = !state.isPreviewCameraOff);
    }
    $('btn-toggle-camera-preview').classList.toggle('muted', state.isPreviewCameraOff);
  }

  function _onToggleMicPreview() {
    state.isPreviewMicOff = !state.isPreviewMicOff;
    $('btn-toggle-mic-preview').classList.toggle('muted', state.isPreviewMicOff);
  }

  async function startVideoPreview() {
    try {
      state.previewStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const videoEl = $('video-preview');
      videoEl.srcObject = state.previewStream;
    } catch (err) {
      console.warn('Could not start video preview:', err);
      $('video-preview-container').classList.add('hidden');
    }

    $('btn-toggle-camera-preview').removeEventListener('click', _onToggleCameraPreview);
    $('btn-toggle-mic-preview').removeEventListener('click', _onToggleMicPreview);
    $('btn-toggle-camera-preview').addEventListener('click', _onToggleCameraPreview);
    $('btn-toggle-mic-preview').addEventListener('click', _onToggleMicPreview);
  }

  function stopVideoPreview() {
    if (state.previewStream) {
      state.previewStream.getTracks().forEach(t => t.stop());
      state.previewStream = null;
    }
  }

  // ------------------------------------
  // Join Flow
  // ------------------------------------
  async function handleJoin() {
    const guestName = $('guest-name').value.trim();
    if (!guestName) return;

    const joinBtn = $('btn-join');
    const btnText = joinBtn.querySelector('.btn-text');
    const btnSpinner = joinBtn.querySelector('.btn-spinner');

    joinBtn.disabled = true;
    btnText.textContent = 'Joining...';
    btnSpinner.classList.remove('hidden');

    try {
      const data = await joinCallAsGuest(state.token, guestName);

      if (data.error) {
        showError('Cannot Join', data.error);
        return;
      }

      state.joinData = data;

      stopVideoPreview();
      await startCall(data);
    } catch (err) {
      console.error('Join error:', err);
      btnText.textContent = 'Join Call';
      btnSpinner.classList.add('hidden');
      joinBtn.disabled = false;
      showError('Connection Error', 'Failed to join the call. Please check your internet connection and try again.');
    }
  }

  // ------------------------------------
  // LiveKit Call
  // ------------------------------------
  async function startCall(joinData) {
    showScreen('call');

    const callContainer = document.querySelector('.call-container');
    const overlay = document.createElement('div');
    overlay.className = 'connecting-overlay';
    overlay.innerHTML = '<div class="spinner"></div><p>Connecting to call...</p>';
    callContainer.appendChild(overlay);

    try {
      const LivekitClient = window.LivekitClient;
      if (!LivekitClient) {
        throw new Error('LiveKit SDK not loaded');
      }

      const room = new LivekitClient.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: LivekitClient.VideoPresets.h720.resolution,
        },
      });

      state.room = room;
      state.hasSeenInitialRoster = false;
      setupRoomEvents(room);

      await room.connect(joinData.server_url, joinData.token);

      // Unblock remote audio playback while the join-click user-gesture chain is
      // still fresh. Browsers otherwise suppress the hidden <audio> elements the
      // LiveKit SDK auto-attaches — the AudioPlaybackStatusChanged handler below
      // surfaces a tap-to-enable overlay if the browser still blocks it.
      try { await room.startAudio(); } catch (_) { /* handled below */ }
      if (!room.canPlaybackAudio) showEnableAudioPrompt(room);

      const isVideo = joinData.call_type === 'video';

      await room.localParticipant.setMicrophoneEnabled(!state.isPreviewMicOff);
      if (isVideo) {
        await room.localParticipant.setCameraEnabled(!state.isPreviewCameraOff);
      }

      state.isMicMuted = state.isPreviewMicOff;
      state.isVideoOff = isVideo ? state.isPreviewCameraOff : true;

      updateControlButtons();

      if (!isVideo) {
        $('btn-video').style.display = 'none';
      }

      if (isMobile()) {
        $('btn-screen-share').style.display = 'none';
      }

      overlay.remove();

      $('call-status').textContent = 'Connected';
      $('call-status').classList.add('connected');

      state.callStartTime = Date.now();
      state.timerInterval = setInterval(updateCallTimer, 1000);

      renderParticipants();

    } catch (err) {
      console.error('Call start error:', err);
      overlay.remove();
      showError('Connection Failed', 'Could not connect to the call. Please try again.');
    }
  }

  function setupRoomEvents(room) {
    const LivekitClient = window.LivekitClient;

    room.on(LivekitClient.RoomEvent.Connected, () => {
      // Participants already in the room at connect time fire ParticipantConnected
      // during the initial roster. Suppress chimes for those and only start playing
      // them ~2s after Connected.
      setTimeout(() => { state.hasSeenInitialRoster = true; }, 2000);
    });

    room.on(LivekitClient.RoomEvent.ParticipantConnected, (participant) => {
      if (
        state.hasSeenInitialRoster &&
        room.localParticipant &&
        participant.identity !== room.localParticipant.identity
      ) {
        playChime('/sounds/join.ogg');
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
      if (
        state.hasSeenInitialRoster &&
        room.localParticipant &&
        participant.identity !== room.localParticipant.identity
      ) {
        playChime('/sounds/leave.ogg');
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.source === LivekitClient.Track.Source.ScreenShare) {
        showScreenShareView(track, participant);
      }
      // Explicitly attach remote audio tracks to a hidden <audio> element in the DOM.
      // LiveKit auto-attaches by default, but keeping an explicit reference guarantees
      // playback survives DOM re-renders from renderParticipants().
      if (track.kind === LivekitClient.Track.Kind.Audio) {
        const el = track.attach();
        el.setAttribute('data-onfire-remote-audio', participant.identity || '');
        el.style.display = 'none';
        document.body.appendChild(el);
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.source === LivekitClient.Track.Source.ScreenShare) {
        hideScreenShareView();
      }
      if (track && track.kind === LivekitClient.Track.Kind.Audio) {
        track.detach().forEach((el) => el.remove());
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room.canPlaybackAudio) {
        hideEnableAudioPrompt();
      } else {
        showEnableAudioPrompt(room);
      }
    });

    room.on(LivekitClient.RoomEvent.TrackMuted, () => renderParticipants());
    room.on(LivekitClient.RoomEvent.TrackUnmuted, () => renderParticipants());

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source === LivekitClient.Track.Source.ScreenShare && publication.track) {
        showScreenShareView(publication.track, room.localParticipant);
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === LivekitClient.Track.Source.ScreenShare) {
        hideScreenShareView();
        state.isScreenSharing = false;
        updateScreenShareButton();
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.Disconnected, (reason) => {
      console.log('Disconnected from room:', reason);
      endCall();
    });

    room.on(LivekitClient.RoomEvent.Reconnecting, () => {
      $('call-status').textContent = 'Reconnecting...';
      $('call-status').classList.remove('connected');
    });

    room.on(LivekitClient.RoomEvent.Reconnected, () => {
      $('call-status').textContent = 'Connected';
      $('call-status').classList.add('connected');
    });

    // Data channel messages for chat + raise-hand signalling
    room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (msg.type === 'chat_message' || msg.type === 'chat_file') {
          chatAddIncoming(msg, participant);
        } else if (msg.type === 'lower_all_hands') {
          // A host asked everyone to lower their hand. Best-effort: clear our own
          // attribute if we have it raised. Other clients enforce the same.
          if (state.isHandRaised) {
            lowerLocalHand().catch((e) => console.warn('lowerLocalHand failed:', e));
          }
        }
      } catch (e) {
        // Ignore non-chat data
      }
    });

    // Raise-hand attribute changes from any participant (remote or local).
    // `changed` is a Record<string,string> delta of only the keys that changed.
    room.on(LivekitClient.RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (!changed || typeof changed !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(changed, 'handRaised')) {
        const newVal = changed.handRaised;
        const isRemote = participant && participant !== room.localParticipant;
        // Transition from falsy → timestamp triggers a toast (remote only).
        if (isRemote && newVal && String(newVal).length > 0) {
          enqueueRaiseHandToast(participant.name || participant.identity || 'Someone');
        }
      }
      // Re-render so the badge on the tile updates immediately.
      renderParticipants();
    });
  }

  // ------------------------------------
  // Participant Rendering
  // ------------------------------------
  function renderParticipants() {
    const room = state.room;
    if (!room) return;

    const grid = $('participants-grid');
    const participants = [room.localParticipant, ...room.remoteParticipants.values()];
    const count = Math.min(participants.length, 6);

    grid.setAttribute('data-count', String(count));
    grid.innerHTML = '';

    participants.slice(0, 6).forEach((participant) => {
      const tile = createParticipantTile(participant);
      grid.appendChild(tile);
    });

    // Host-only "lower all hands" button visibility depends on whether any hand is up.
    updateLowerAllHandsButton();
  }

  function createParticipantTile(participant) {
    const isLocal = participant === state.room.localParticipant;
    const tile = document.createElement('div');
    tile.className = 'participant-tile' + (isLocal ? ' local' : '');

    let videoTrack = null;
    participant.videoTrackPublications.forEach((pub) => {
      if (pub.track && pub.source === 'camera' && !pub.isMuted) {
        videoTrack = pub.track;
      }
    });

    if (videoTrack) {
      const videoEl = videoTrack.attach();
      videoEl.style.width = '100%';
      videoEl.style.height = '100%';
      videoEl.style.objectFit = 'cover';
      tile.appendChild(videoEl);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'avatar-placeholder';
      avatar.textContent = getInitials(participant.name || participant.identity);
      tile.appendChild(avatar);
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'participant-name';

    let isMicMuted = true;
    participant.audioTrackPublications.forEach((pub) => {
      if (pub.source === 'microphone' && pub.track && !pub.isMuted) {
        isMicMuted = false;
      }
    });

    const micIndicator = document.createElement('span');
    micIndicator.className = 'mic-indicator' + (isMicMuted ? ' muted' : '');
    micIndicator.innerHTML = isMicMuted
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/></svg>';

    const nameText = document.createElement('span');
    nameText.textContent = (participant.name || participant.identity || 'Unknown') + (isLocal ? ' (You)' : '');

    nameEl.appendChild(micIndicator);
    nameEl.appendChild(nameText);
    tile.appendChild(nameEl);

    // Raised-hand badge — read from LiveKit attributes. Timestamp string (non-empty) = raised.
    const attrs = (participant && participant.attributes) || {};
    const handVal = attrs.handRaised;
    if (handVal && String(handVal).length > 0) {
      const badge = document.createElement('div');
      badge.className = 'raised-hand-badge';
      badge.title = 'Hand raised';
      badge.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>';
      tile.appendChild(badge);
    }

    return tile;
  }

  // ------------------------------------
  // Call Controls
  // ------------------------------------
  function updateControlButtons() {
    const micBtn = $('btn-mic');
    const videoBtn = $('btn-video');

    micBtn.classList.toggle('muted', state.isMicMuted);
    micBtn.querySelector('.icon-mic-on').classList.toggle('hidden', state.isMicMuted);
    micBtn.querySelector('.icon-mic-off').classList.toggle('hidden', !state.isMicMuted);

    videoBtn.classList.toggle('muted', state.isVideoOff);
    videoBtn.querySelector('.icon-video-on').classList.toggle('hidden', state.isVideoOff);
    videoBtn.querySelector('.icon-video-off').classList.toggle('hidden', !state.isVideoOff);
  }

  function updateScreenShareButton() {
    const btn = $('btn-screen-share');
    if (!btn) return;
    btn.classList.toggle('active', state.isScreenSharing);
    btn.querySelector('.icon-screen-share-off').classList.toggle('hidden', state.isScreenSharing);
    btn.querySelector('.icon-screen-share-on').classList.toggle('hidden', !state.isScreenSharing);
  }

  async function toggleScreenShare() {
    if (!state.room) return;
    try {
      state.isScreenSharing = !state.isScreenSharing;
      await state.room.localParticipant.setScreenShareEnabled(state.isScreenSharing);
      updateScreenShareButton();
    } catch (e) {
      console.error('Screen share failed:', e);
      state.isScreenSharing = false;
      updateScreenShareButton();
    }
  }

  function showScreenShareView(track, participant) {
    state.remoteScreenShareTrack = track;
    state.remoteScreenShareParticipant = participant;

    let container = $('screen-share-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'screen-share-container';
      container.className = 'screen-share-container';
      const grid = $('participants-grid');
      grid.parentNode.insertBefore(container, grid);
    }

    container.innerHTML = '';
    const videoEl = track.attach();
    videoEl.style.width = '100%';
    videoEl.style.height = '100%';
    videoEl.style.objectFit = 'contain';
    container.appendChild(videoEl);

    const label = document.createElement('div');
    label.className = 'screen-share-label';
    label.textContent = (participant.name || participant.identity || 'Someone') + "'s screen";
    container.appendChild(label);

    container.classList.add('active');
    $('participants-grid').classList.add('strip-mode');
  }

  function hideScreenShareView() {
    state.remoteScreenShareTrack = null;
    state.remoteScreenShareParticipant = null;

    const container = $('screen-share-container');
    if (container) {
      container.classList.remove('active');
      container.innerHTML = '';
    }

    $('participants-grid').classList.remove('strip-mode');
  }

  // ------------------------------------
  // Audio Playback Unblock Prompt
  // ------------------------------------
  // Browsers block remote audio autoplay unless a user gesture is close in time.
  // The gesture from the "Join Call" click is often lost across the async
  // connect/token chain. Surface a tappable overlay that calls room.startAudio()
  // on click to unblock.
  function showEnableAudioPrompt(room) {
    if (document.getElementById('enable-audio-prompt')) return;
    const prompt = document.createElement('button');
    prompt.id = 'enable-audio-prompt';
    prompt.className = 'enable-audio-prompt';
    prompt.type = 'button';
    prompt.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><span>Tap to enable audio</span>';
    prompt.addEventListener('click', async () => {
      try { await room.startAudio(); } catch (e) { console.warn('startAudio failed:', e); }
      if (room.canPlaybackAudio) hideEnableAudioPrompt();
    });
    document.body.appendChild(prompt);
  }

  function hideEnableAudioPrompt() {
    const prompt = document.getElementById('enable-audio-prompt');
    if (prompt) prompt.remove();
  }

  // ------------------------------------
  // Join / Leave Chimes
  // ------------------------------------
  function playChime(src) {
    try {
      const a = new Audio(src);
      a.volume = 0.4;
      // autoplay may be blocked; swallow the rejection silently — chimes are non-critical
      a.play().catch(() => {});
    } catch (_) {
      // Ignore Audio constructor failures on exotic browsers
    }
  }

  // ------------------------------------
  // Raise Hand
  // ------------------------------------
  async function raiseLocalHand() {
    if (!state.room || !state.room.localParticipant) return;
    await state.room.localParticipant.setAttributes({ handRaised: String(Date.now()) });
    state.isHandRaised = true;
    updateRaiseHandButton();
    renderParticipants();
  }

  async function lowerLocalHand() {
    if (!state.room || !state.room.localParticipant) return;
    // Empty string clears the key without colliding with other attributes.
    await state.room.localParticipant.setAttributes({ handRaised: '' });
    state.isHandRaised = false;
    updateRaiseHandButton();
    renderParticipants();
  }

  async function toggleRaiseHand() {
    try {
      if (state.isHandRaised) await lowerLocalHand();
      else await raiseLocalHand();
    } catch (e) {
      console.error('toggleRaiseHand failed:', e);
    }
  }

  function updateRaiseHandButton() {
    const btn = $('btn-raise-hand');
    if (btn) btn.classList.toggle('active', state.isHandRaised);
    updateLowerAllHandsButton();
  }

  // The web client is currently guest-only, so joinData.is_host is always false.
  // Kept here so the UI lights up automatically the day hosts can join via web.
  function updateLowerAllHandsButton() {
    const btn = $('btn-lower-all-hands');
    if (!btn) return;
    const isHost = !!(state.joinData && state.joinData.is_host);
    const anyHandRaised = hasAnyRaisedHand();
    const visible = isHost && anyHandRaised;
    btn.classList.toggle('hidden', !visible);
  }

  function hasAnyRaisedHand() {
    if (!state.room) return false;
    const all = [state.room.localParticipant, ...state.room.remoteParticipants.values()];
    return all.some((p) => {
      const v = p && p.attributes && p.attributes.handRaised;
      return v && String(v).length > 0;
    });
  }

  async function lowerAllHands() {
    if (!state.room) return;
    // Client-only best-effort: broadcast a DataPacket; every client clears its own
    // hand when it receives lower_all_hands. There is no server-side API to clear
    // another participant's attributes on the web SDK, so this is advisory only.
    try {
      const data = new TextEncoder().encode(JSON.stringify({ type: 'lower_all_hands' }));
      await state.room.localParticipant.publishData(data, { reliable: true });
      // Clear our own hand if raised.
      if (state.isHandRaised) await lowerLocalHand();
      showSimpleToast('Asked everyone to lower their hand');
    } catch (e) {
      console.error('lowerAllHands failed:', e);
    }
  }

  // ------------------------------------
  // Raise-hand Toast Queue
  // ------------------------------------
  function enqueueRaiseHandToast(name) {
    _raiseHandToastQueue.push(name);
    _drainRaiseHandToasts();
  }

  function _drainRaiseHandToasts() {
    if (_raiseHandToastActive) return;
    const next = _raiseHandToastQueue.shift();
    if (!next) return;
    _raiseHandToastActive = true;
    _showRaiseHandToast(`${next} raised their hand`, () => {
      _raiseHandToastActive = false;
      _drainRaiseHandToasts();
    });
  }

  function _showRaiseHandToast(text, onDone) {
    const toast = document.createElement('div');
    toast.className = 'raise-hand-toast';
    toast.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg><span></span>';
    toast.querySelector('span').textContent = text;
    document.body.appendChild(toast);
    // Auto-dismiss after 3s, then trigger callback so the next queued toast can show.
    setTimeout(() => {
      toast.classList.add('dismissing');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (onDone) onDone();
      }, 200);
    }, 3000);
  }

  // Generic transient confirmation toast (used for "asked everyone to lower their hand").
  function showSimpleToast(text) {
    const toast = document.createElement('div');
    toast.className = 'raise-hand-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('dismissing');
      setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
    }, 2500);
  }

  function setupCallControls() {
    $('btn-mic').addEventListener('click', async () => {
      if (!state.room) return;
      state.isMicMuted = !state.isMicMuted;
      await state.room.localParticipant.setMicrophoneEnabled(!state.isMicMuted);
      updateControlButtons();
      renderParticipants();
    });

    $('btn-video').addEventListener('click', async () => {
      if (!state.room) return;
      state.isVideoOff = !state.isVideoOff;
      await state.room.localParticipant.setCameraEnabled(!state.isVideoOff);
      updateControlButtons();
      renderParticipants();
    });

    $('btn-screen-share').addEventListener('click', () => toggleScreenShare());

    $('btn-raise-hand').addEventListener('click', () => toggleRaiseHand());
    $('btn-lower-all-hands').addEventListener('click', () => lowerAllHands());

    $('btn-chat').addEventListener('click', () => chatTogglePanel());

    $('btn-hangup').addEventListener('click', () => {
      if (state.room) state.room.disconnect();
      endCall();
    });

    // Chat controls
    $('btn-close-chat').addEventListener('click', () => chatTogglePanel());
    $('btn-send-chat').addEventListener('click', () => chatSendMessage());
    $('chat-input').addEventListener('input', () => {
      $('btn-send-chat').disabled = !$('chat-input').value.trim();
    });
    $('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && $('chat-input').value.trim()) chatSendMessage();
    });
    $('chat-file-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) chatSendFile(file);
      e.target.value = '';
    });
  }

  // ------------------------------------
  // Call Timer
  // ------------------------------------
  function updateCallTimer() {
    if (!state.callStartTime) return;
    const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
    $('call-timer').textContent = formatDuration(elapsed);
  }

  // ------------------------------------
  // End Call
  // ------------------------------------
  let _endingCall = false;
  function endCall() {
    if (_endingCall) return;
    _endingCall = true;

    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }

    let durationText = '';
    if (state.callStartTime) {
      const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
      durationText = 'Duration: ' + formatDuration(elapsed);
    }

    state.isScreenSharing = false;
    state.remoteScreenShareTrack = null;
    state.remoteScreenShareParticipant = null;
    state.hasSeenInitialRoster = false;
    state.isHandRaised = false;
    updateScreenShareButton();
    updateRaiseHandButton();
    hideScreenShareView();

    // Clean up audio playback UI and attached remote audio elements
    hideEnableAudioPrompt();
    document.querySelectorAll('audio[data-onfire-remote-audio]').forEach((el) => el.remove());

    if (state.room) {
      try { state.room.disconnect(); } catch (e) {}
      state.room = null;
    }

    $('ended-duration').textContent = durationText;
    showScreen('ended');

    $('btn-rejoin').onclick = () => {
      _endingCall = false;
      state.callStartTime = null;
      state.isMicMuted = false;
      state.isVideoOff = false;
      showScreen('join');
      const joinBtn = $('btn-join');
      joinBtn.disabled = !$('guest-name').value.trim();
      joinBtn.querySelector('.btn-text').textContent = 'Join Call';
      joinBtn.querySelector('.btn-spinner').classList.add('hidden');
      if (state.callLink && state.callLink.call_type === 'video') {
        startVideoPreview();
      }
    };
  }

  // ------------------------------------
  // Join by Code (Landing Page)
  // ------------------------------------
  function setupJoinCodeForm() {
    const input = $('join-code-input');
    const btn = $('btn-join-code');
    const errorEl = $('join-code-error');

    function extractCode(value) {
      let code = value.trim();
      code = code.replace(/^https?:\/\/call\.onfire\.so\/?/i, '');
      code = code.replace(/^\/+|\/+$/g, '');
      code = code.toLowerCase();
      return code;
    }

    function updateButton() {
      const code = extractCode(input.value);
      btn.disabled = code.length < 3;
      errorEl.classList.add('hidden');
    }

    function navigateToCode() {
      const code = extractCode(input.value);
      if (code.length < 3) return;

      if (!/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(code) && !/^[a-z0-9]{1,2}$/.test(code)) {
        errorEl.textContent = 'Enter a valid meeting code (letters, numbers, hyphens)';
        errorEl.classList.remove('hidden');
        return;
      }

      window.location.href = '/' + code;
    }

    input.addEventListener('input', updateButton);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') navigateToCode();
    });
    btn.addEventListener('click', navigateToCode);
  }

  // ------------------------------------
  // Slug Validation
  // ------------------------------------
  function isValidSlug(slug) {
    // Must be 3-30 chars, lowercase letters, numbers, hyphens
    return /^[a-z0-9][a-z0-9\-]{1,28}[a-z0-9]$/.test(slug) || /^[a-z0-9]{1,2}$/.test(slug);
  }

  // ------------------------------------
  // Chat Module (via LiveKit Data Channels)
  // ------------------------------------
  const chatMessages = [];
  let chatUnreadCount = 0;
  let chatPanelOpen = false;

  function chatTogglePanel() {
    chatPanelOpen = !chatPanelOpen;
    const panel = $('chat-panel');
    panel.classList.toggle('hidden', !chatPanelOpen);
    $('btn-chat').classList.toggle('active', chatPanelOpen);

    if (chatPanelOpen) {
      chatUnreadCount = 0;
      $('chat-badge').classList.add('hidden');
      chatScrollToBottom();
      $('chat-input').focus();
    }
  }

  function chatSendMessage() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text || !state.room) return;

    const msg = {
      type: 'chat_message',
      id: crypto.randomUUID(),
      sender: state.room.localParticipant.identity,
      senderName: state.room.localParticipant.name || 'You',
      text: text,
      timestamp: Date.now(),
    };

    // Send via LiveKit data channel
    const data = new TextEncoder().encode(JSON.stringify(msg));
    state.room.localParticipant.publishData(data, { reliable: true });

    // Add to local messages
    chatMessages.push({ ...msg, isSelf: true });
    chatRenderMessages();
    chatScrollToBottom();

    input.value = '';
    $('btn-send-chat').disabled = true;
  }

  function chatSendFile(file) {
    if (!state.room || !file) return;

    // Limit file size to 2MB for data channel
    if (file.size > 2 * 1024 * 1024) {
      alert('File must be under 2MB');
      return;
    }

    const reader = new FileReader();
    reader.onload = function () {
      const base64 = reader.result.split(',')[1];
      const msg = {
        type: 'chat_file',
        id: crypto.randomUUID(),
        sender: state.room.localParticipant.identity,
        senderName: state.room.localParticipant.name || 'You',
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        fileData: base64,
        timestamp: Date.now(),
      };

      const data = new TextEncoder().encode(JSON.stringify(msg));
      state.room.localParticipant.publishData(data, { reliable: true });

      chatMessages.push({ ...msg, isSelf: true });
      chatRenderMessages();
      chatScrollToBottom();
    };
    reader.readAsDataURL(file);
  }

  function chatAddIncoming(msg, participant) {
    // Ignore own messages (echoed back)
    if (state.room && msg.sender === state.room.localParticipant.identity) return;

    chatMessages.push({ ...msg, isSelf: false });
    chatRenderMessages();

    if (chatPanelOpen) {
      chatScrollToBottom();
    } else {
      chatUnreadCount++;
      const badge = $('chat-badge');
      badge.textContent = String(chatUnreadCount);
      badge.classList.remove('hidden');
    }
  }

  function chatRenderMessages() {
    const container = $('chat-messages');
    container.innerHTML = '';

    for (const msg of chatMessages) {
      const wrapper = document.createElement('div');
      wrapper.className = 'chat-msg' + (msg.isSelf ? ' self' : '');

      if (!msg.isSelf) {
        const sender = document.createElement('div');
        sender.className = 'chat-msg-sender';
        sender.textContent = msg.senderName || msg.sender;
        wrapper.appendChild(sender);
      }

      if (msg.type === 'chat_file') {
        const fileEl = document.createElement('a');
        fileEl.className = 'chat-msg-file';

        // Create download blob from base64
        if (msg.fileData) {
          try {
            const byteChars = atob(msg.fileData);
            const byteNums = new Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
            const blob = new Blob([new Uint8Array(byteNums)], { type: msg.mimeType || 'application/octet-stream' });
            fileEl.href = URL.createObjectURL(blob);
            fileEl.download = msg.fileName;
          } catch (e) {
            fileEl.href = '#';
          }
        }

        fileEl.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>'
          + '<div class="chat-msg-file-info">'
          + '<div class="chat-msg-file-name">' + escapeHtml(msg.fileName) + '</div>'
          + '<div class="chat-msg-file-size">' + formatFileSize(msg.fileSize) + '</div>'
          + '</div>';

        wrapper.appendChild(fileEl);
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'chat-msg-bubble';
        bubble.textContent = msg.text;
        wrapper.appendChild(bubble);
      }

      const time = document.createElement('div');
      time.className = 'chat-msg-time';
      time.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      wrapper.appendChild(time);

      container.appendChild(wrapper);
    }
  }

  function chatScrollToBottom() {
    const container = $('chat-messages');
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ------------------------------------
  // Initialization
  // ------------------------------------
  async function init() {
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');

    if (!path) {
      showScreen('landing');
      setupJoinCodeForm();
      return;
    }

    state.token = path;
    setupCallControls();

    // Show loading while we check if the link exists
    showScreen('loading');

    try {
      const data = await getCallLink(state.token);

      if (data.error) {
        // Link doesn't exist — check if the slug looks valid for creating a new meeting
        if (isValidSlug(state.token)) {
          showStartMeetingScreen(state.token);
        } else {
          showError('Link Not Found', data.error);
        }
        return;
      }

      state.callLink = data;
      renderJoinScreen(data);
    } catch (err) {
      console.error('Init error:', err);
      showError('Connection Error', 'Could not reach the server. Please check your internet connection and try again.');
    }
  }

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
