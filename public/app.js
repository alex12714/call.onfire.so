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
    hostToken: null,       // ?host=<token> query param — host credentials
    isHost: false,         // True iff host-token join succeeded
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
    waitingPollTimer: null,

    // -- Breakouts -----------------------------------------------------------
    // Identity used when calling breakout RPCs. For guests, populated from
    // room.localParticipant.identity after connect (`guest-<hex>`). For hosts
    // on the web client, populated from joinData.creator_identity (UUID).
    myIdentity: null,
    creatorIdentity: null,       // joinData.creator_identity (used for host RPC calls)
    parentRoomName: null,        // joinData.room_name — needed for return-to-main

    // Current state
    currentBreakout: null,       // { sessionId, roomId, roomName, roomLabel, closesAt }
    isSwitchingRoom: false,      // re-entrancy guard
    kickedToMainReason: null,    // 'timer_expired' | 'host_ended' (for toast)

    // Session poll (participant polls while in breakout; host polls while panel is open or session active)
    breakoutSession: null,       // full state from get_breakout_session
    breakoutPollTimer: null,
    breakoutCountdownTimer: null,
    lastBroadcastAt: null,       // dedupe broadcast toasts
    helpRequestPendingUntil: 0,  // timestamp: participant help button cooldown
    hostPanelOpen: false,

    // Guest-only: remember the name used so we can re-mint a main-room token
    // after a breakout ends (new identity, same name).
    lastGuestName: null,
  };

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
    waiting: $('screen-waiting'),
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

  async function joinCallAsHost(linkToken, hostToken) {
    return apiCall('join_call_as_host', {
      p_link_token: linkToken,
      p_host_token: hostToken,
    });
  }

  async function endCallLinkAsHost(linkToken, hostToken) {
    return apiCall('end_call_link_as_host', {
      p_link_token: linkToken,
      p_host_token: hostToken,
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

      // Check if placed in waiting room
      if (data.admission_status === 'waiting') {
        stopVideoPreview();
        showWaitingScreen($('guest-name').value.trim());
        return;
      }

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
      setupRoomEvents(room);

      await room.connect(joinData.server_url, joinData.token);

      const isVideo = joinData.call_type === 'video';

      await room.localParticipant.setMicrophoneEnabled(!state.isPreviewMicOff);
      if (isVideo) {
        await room.localParticipant.setCameraEnabled(!state.isPreviewCameraOff);
      }

      state.isMicMuted = state.isPreviewMicOff;
      state.isVideoOff = isVideo ? state.isPreviewCameraOff : true;

      // Cache identity + parent room for breakouts (identity is stable for
      // the whole meeting — tokens may change but the LiveKit participant
      // identity is baked into them by generate_livekit_token).
      state.myIdentity = room.localParticipant.identity || null;
      state.creatorIdentity = joinData.creator_identity || null;
      // room_name may be absent on legacy call-links; fall back to the slug.
      if (!state.parentRoomName) {
        state.parentRoomName = joinData.room_name || state.token;
      }

      updateControlButtons();
      updateBreakoutButtonVisibility();

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

      // Rehydrate: if this user refreshed the page while in an active
      // breakout, the backend still has their assignment. Skip for guests
      // (identity changes on every join) but reconnect hosts into their
      // assigned breakout room if one exists.
      maybeRehydrateBreakoutAssignment().catch((e) =>
        console.debug('rehydrate:', e && e.message));

    } catch (err) {
      console.error('Call start error:', err);
      overlay.remove();
      showError('Connection Failed', 'Could not connect to the call. Please try again.');
    }
  }

  function setupRoomEvents(room) {
    const LivekitClient = window.LivekitClient;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, () => renderParticipants());
    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => renderParticipants());

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.source === LivekitClient.Track.Source.ScreenShare) {
        showScreenShareView(track, participant);
      }
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.source === LivekitClient.Track.Source.ScreenShare) {
        hideScreenShareView();
      }
      renderParticipants();
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

    // Data channel messages for chat
    room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
      try {
        const text = new TextDecoder().decode(payload);
        const msg = JSON.parse(text);
        if (msg.type === 'chat_message' || msg.type === 'chat_file') {
          chatAddIncoming(msg, participant);
        } else if (msg.type === 'room_ended') {
          // Host told everyone to disconnect. Show the end screen with the
          // host's reason (if provided) and bail.
          state.kickedByHost = true;
          if (state.room) {
            try { state.room.disconnect(); } catch (e) {}
          }
          // endCall() will fire via RoomEvent.Disconnected below; we also
          // call it here in case disconnect() was a no-op.
          endCall({ endedByHost: true });
        } else if (msg.type === 'breakout_assign') {
          // Host pushed us into a breakout. Packet carries the token so no
          // extra round-trip before reconnect.
          handleBreakoutAssignPacket(msg);
        } else if (msg.type === 'breakout_ended') {
          // Worker or host ended the session. Return to main room.
          handleBreakoutEndedPacket(msg);
        }
      } catch (e) {
        // Ignore non-chat data
      }
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

    $('btn-chat').addEventListener('click', () => chatTogglePanel());

    $('btn-hangup').addEventListener('click', () => {
      if (state.isHost) {
        showHangupChoiceDialog();
      } else {
        if (state.room) state.room.disconnect();
        endCall();
      }
    });

    // Host dialog buttons
    const dlg = $('hangup-dialog');
    if (dlg) {
      $('btn-hangup-cancel').addEventListener('click', () => hideHangupChoiceDialog());
      $('hangup-backdrop').addEventListener('click', () => hideHangupChoiceDialog());
      $('btn-hangup-leave').addEventListener('click', () => {
        hideHangupChoiceDialog();
        if (state.room) state.room.disconnect();
        endCall();
      });
      $('btn-hangup-end-all').addEventListener('click', async () => {
        hideHangupChoiceDialog();
        await endMeetingForAll();
      });
    }

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

    // Breakouts
    const breakoutsBtn = $('btn-breakouts');
    if (breakoutsBtn) {
      breakoutsBtn.addEventListener('click', toggleBreakoutHostPanel);
    }
    const closeBreakoutPanelBtn = $('btn-close-breakout-panel');
    if (closeBreakoutPanelBtn) {
      closeBreakoutPanelBtn.addEventListener('click', () => hideBreakoutHostPanel());
    }
    const createBtn = $('btn-breakout-create');
    if (createBtn) createBtn.addEventListener('click', hostCreateBreakouts);
    // When the host flips between auto/manual or changes room count, re-render
    // the per-participant picker list (only visible in manual mode).
    const assignModeSel = $('breakout-assign-mode');
    if (assignModeSel) {
      assignModeSel.addEventListener('change', renderManualAssignPickers);
    }
    const roomCountInput = $('breakout-room-count');
    if (roomCountInput) {
      roomCountInput.addEventListener('input', renderManualAssignPickers);
    }
    const endBtn = $('btn-breakout-end');
    if (endBtn) endBtn.addEventListener('click', hostEndBreakouts);
    const broadcastBtn = $('btn-breakout-broadcast');
    if (broadcastBtn) broadcastBtn.addEventListener('click', hostBroadcast);
    const helpBtn = $('btn-breakout-help');
    if (helpBtn) helpBtn.addEventListener('click', participantRequestHelp);

    // Waiting room cancel
    if ($('btn-cancel-wait')) {
      $('btn-cancel-wait').addEventListener('click', () => {
        stopWaitingPoll();
        // Go back to join screen
        showScreen('join');
        const joinBtn = $('btn-join');
        joinBtn.disabled = !$('guest-name').value.trim();
        joinBtn.querySelector('.btn-text').textContent = 'Join Call';
        joinBtn.querySelector('.btn-spinner').classList.add('hidden');
      });
    }
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
  // Host-only hangup choice dialog
  // ------------------------------------
  function showHangupChoiceDialog() {
    const dlg = $('hangup-dialog');
    if (!dlg) return;
    dlg.classList.remove('hidden');
  }

  function hideHangupChoiceDialog() {
    const dlg = $('hangup-dialog');
    if (!dlg) return;
    dlg.classList.add('hidden');
  }

  async function endMeetingForAll() {
    // Broadcast room_ended to every participant so they disconnect instantly,
    // then flip is_active=false server-side so new joiners are rejected.
    try {
      if (state.room) {
        const msg = { type: 'room_ended', at: Date.now() };
        const data = new TextEncoder().encode(JSON.stringify(msg));
        try {
          await state.room.localParticipant.publishData(data, { reliable: true });
        } catch (e) {
          console.warn('publishData(room_ended) failed:', e);
        }
      }
    } finally {
      // Server-side close is the durable guard — run it even if the broadcast
      // fails, so late joiners hit "Meeting ended".
      try {
        await endCallLinkAsHost(state.token, state.hostToken);
      } catch (e) {
        console.warn('end_call_link_as_host failed:', e);
      }
      if (state.room) {
        try { state.room.disconnect(); } catch (e) {}
      }
      endCall({ endedByHost: true, asHost: true });
    }
  }

  // ------------------------------------
  // End Call
  // ------------------------------------
  let _endingCall = false;
  function endCall(opts) {
    if (_endingCall) return;
    _endingCall = true;
    opts = opts || {};

    stopWaitingPoll();

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
    updateScreenShareButton();
    hideScreenShareView();

    if (state.room) {
      try { state.room.disconnect(); } catch (e) {}
      state.room = null;
    }

    $('ended-duration').textContent = durationText;

    // Messaging & rejoin visibility depend on why the call ended.
    const endedTitle = document.querySelector('#screen-ended h2');
    const rejoinBtn = $('btn-rejoin');
    if (opts.endedByHost) {
      if (endedTitle) endedTitle.textContent = opts.asHost ? 'Meeting Ended' : 'Meeting Ended by Host';
      if (rejoinBtn) rejoinBtn.style.display = 'none';
    } else {
      if (endedTitle) endedTitle.textContent = 'Call Ended';
      if (rejoinBtn) rejoinBtn.style.display = '';
    }

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
  // Waiting Room
  // ------------------------------------
  function showWaitingScreen(guestName) {
    $('waiting-guest-name').textContent = guestName ? 'Joining as ' + guestName : '';
    showScreen('waiting');

    // Poll for admission every 3 seconds
    stopWaitingPoll();
    state.waitingPollTimer = setInterval(async () => {
      try {
        // Re-attempt join — if admitted, server returns token
        const data = await joinCallAsGuest(state.token, guestName);
        if (data.error) return; // still waiting or rejected

        if (data.admission_status === 'rejected') {
          stopWaitingPoll();
          showError('Not Admitted', data.rejection_reason || 'The host did not admit you to this meeting.');
          return;
        }

        if (data.token && data.admission_status !== 'waiting') {
          // Admitted! Stop polling and join
          stopWaitingPoll();
          state.joinData = data;
          await startCall(data);
        }
      } catch (err) {
        console.debug('Waiting poll:', err.message);
      }
    }, 3000);
  }

  function stopWaitingPoll() {
    if (state.waitingPollTimer) {
      clearInterval(state.waitingPollTimer);
      state.waitingPollTimer = null;
    }
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

    // Host-scoped URL: ?host=<host_token> grants host privileges without auth.
    // Only the creator should have this URL; anyone holding it can end the call.
    const params = new URLSearchParams(window.location.search);
    state.hostToken = params.get('host') || null;

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

      if (data.is_ended) {
        showError('Meeting Ended', 'The host has ended this meeting.');
        return;
      }

      state.callLink = data;

      // Host path: auto-identify, skip name prompt, join straight through.
      if (state.hostToken) {
        await handleHostJoin();
        return;
      }

      renderJoinScreen(data);
    } catch (err) {
      console.error('Init error:', err);
      showError('Connection Error', 'Could not reach the server. Please check your internet connection and try again.');
    }
  }

  async function handleHostJoin() {
    try {
      showScreen('loading');
      const data = await joinCallAsHost(state.token, state.hostToken);
      if (data.error) {
        showError('Host Link Invalid', data.error);
        return;
      }
      state.joinData = data;
      state.isHost = !!data.is_host;
      await startCall(data);
    } catch (err) {
      console.error('Host join error:', err);
      showError('Connection Error', 'Could not start the meeting as host. Please check your internet connection and try again.');
    }
  }

  // ------------------------------------
  // Breakouts — API helpers
  // ------------------------------------
  async function rpcCreateBreakoutSession(opts) {
    return apiCall('create_breakout_session', {
      p_parent_room: opts.parentRoom,
      p_creator_identity: opts.creatorIdentity,
      p_duration_seconds: opts.durationSeconds,
      p_room_count: opts.roomCount,
      p_auto_assign: opts.autoAssign,
      p_assignments: opts.assignments || [],
      // Disambiguate PGRST203 — two overloads of create_breakout_session
      // exist on the server (6-arg legacy vs 7-arg with capacity limit).
      // Always send the 7th so PostgREST picks the newer definition.
      p_max_participants_per_room: null,
    });
  }

  async function rpcAutoAssignBreakoutParticipants(sessionId, identities) {
    return apiCall('auto_assign_breakout_participants', {
      p_session_id: sessionId,
      p_participant_identities: identities,
    });
  }

  async function rpcJoinBreakoutRoom(sessionId, roomId, participantIdentity) {
    return apiCall('join_breakout_room', {
      p_session_id: sessionId,
      p_room_id: roomId,
      p_participant_identity: participantIdentity,
    });
  }

  async function rpcMoveParticipant(sessionId, participantIdentity, targetRoomId, moverIdentity) {
    return apiCall('move_participant_to_breakout', {
      p_session_id: sessionId,
      p_participant_identity: participantIdentity,
      p_target_room_id: targetRoomId,
      p_mover_identity: moverIdentity,
    });
  }

  async function rpcBroadcastToBreakouts(sessionId, message, senderIdentity) {
    return apiCall('broadcast_to_breakouts', {
      p_session_id: sessionId,
      p_message: message,
      p_sender_identity: senderIdentity,
    });
  }

  async function rpcEndBreakoutSession(sessionId, enderIdentity) {
    return apiCall('end_breakout_session', {
      p_session_id: sessionId,
      p_ender_identity: enderIdentity,
    });
  }

  async function rpcRequestBreakoutHelp(sessionId, roomId, requesterIdentity) {
    return apiCall('request_breakout_help', {
      p_session_id: sessionId,
      p_room_id: roomId,
      p_requester_identity: requesterIdentity,
    });
  }

  async function rpcResolveHelpRequest(helpId, resolverIdentity) {
    return apiCall('resolve_help_request', {
      p_help_id: helpId,
      p_resolver_identity: resolverIdentity,
    });
  }

  async function rpcGetBreakoutSession(parentRoom) {
    return apiCall('get_breakout_session', { p_parent_room: parentRoom });
  }

  // ------------------------------------
  // Breakouts — Control visibility
  // ------------------------------------
  function updateBreakoutButtonVisibility() {
    const btn = $('btn-breakouts');
    if (!btn) return;
    // Show to host always (create + manage). Participants get no button —
    // they see the in-breakout banner instead when they're assigned.
    if (state.isHost) {
      btn.classList.remove('hidden');
    } else {
      btn.classList.add('hidden');
    }
  }

  function setBreakoutsBadge(count) {
    const badge = $('breakouts-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ------------------------------------
  // Breakouts — Room-switch helper
  // ------------------------------------
  // Disconnect from the current LiveKit room and connect to a new one with
  // a fresh token, preserving mic/camera state across the transition.
  async function switchRoom(serverUrl, token, reason) {
    if (state.isSwitchingRoom) {
      console.warn('switchRoom: already switching, ignoring reason=' + reason);
      return { ok: false, error: 'already_switching' };
    }
    if (!state.room) {
      return { ok: false, error: 'no_room' };
    }
    state.isSwitchingRoom = true;
    const LivekitClient = window.LivekitClient;

    // Snapshot mic/camera state before teardown.
    const wasMicMuted = state.isMicMuted;
    const wasVideoOff = state.isVideoOff;

    try {
      try { state.room.disconnect(); } catch (e) { /* ignore */ }
      state.room = null;

      const newRoom = new LivekitClient.Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: LivekitClient.VideoPresets.h720.resolution,
        },
      });

      state.room = newRoom;
      setupRoomEvents(newRoom);
      await newRoom.connect(serverUrl, token);

      // Re-apply mic/camera state. For audio-only calls, camera is no-op.
      const isVideo = state.callLink && state.callLink.call_type === 'video';
      await newRoom.localParticipant.setMicrophoneEnabled(!wasMicMuted);
      if (isVideo) {
        await newRoom.localParticipant.setCameraEnabled(!wasVideoOff);
      }
      state.isMicMuted = wasMicMuted;
      state.isVideoOff = isVideo ? wasVideoOff : true;
      // Identity stays the same — generate_livekit_token encoded it.
      state.myIdentity = newRoom.localParticipant.identity || state.myIdentity;

      updateControlButtons();
      renderParticipants();
      return { ok: true };
    } catch (err) {
      console.error('switchRoom failed:', err);
      return { ok: false, error: err.message || String(err) };
    } finally {
      state.isSwitchingRoom = false;
    }
  }

  // ------------------------------------
  // Breakouts — DataPacket handlers
  // ------------------------------------
  async function handleBreakoutAssignPacket(msg) {
    // Ignore if we're currently switching already (race w/ stale packet).
    if (state.isSwitchingRoom) return;

    const serverUrl = msg.server_url;
    const token = msg.token;
    const roomName = msg.room_name;
    if (!serverUrl || !token || !roomName) {
      console.warn('breakout_assign: missing fields', msg);
      return;
    }

    // Show takeover modal (non-blocking) then switch.
    showBreakoutTakeover(msg.room_label || roomName, 3);

    // Wait ~1.2s so the user sees the notice; then switch.
    await new Promise((r) => setTimeout(r, 1200));

    const result = await switchRoom(serverUrl, token, 'breakout_assign');
    hideBreakoutTakeover();

    if (result.ok) {
      state.currentBreakout = {
        sessionId: msg.session_id || '',
        roomId: msg.room_id || '',
        roomName: roomName,
        roomLabel: msg.room_label || roomName,
        closesAt: msg.closes_at ? new Date(msg.closes_at) : null,
      };
      showBreakoutBanner();
      startBreakoutCountdown();
      startBreakoutSessionPoll();
    } else {
      showCallToast('Could not move to breakout: ' + (result.error || 'unknown'), '⚠');
    }
  }

  async function handleBreakoutEndedPacket(msg) {
    if (!state.currentBreakout) {
      // Packet arrived but we aren't in a breakout — ignore.
      return;
    }
    const reason = msg.reason || 'timer_expired';
    state.kickedToMainReason = reason;

    // Stop banner + polls; session is over.
    stopBreakoutCountdown();
    stopBreakoutSessionPoll();
    hideBreakoutBanner();
    state.currentBreakout = null;

    showCallToast(
      reason === 'host_ended'
        ? 'Host ended breakouts. Returning to main room...'
        : 'Breakout time is up. Returning to main room...',
      '↩',
    );

    // Re-mint a main-room token. Guests get a new guest identity (acceptable
    // tradeoff — the breakout session is over). Hosts reuse the host_token.
    try {
      const mainRoom = await mintMainRoomToken();
      if (!mainRoom) {
        throw new Error('Could not mint main-room token');
      }
      const result = await switchRoom(
        mainRoom.server_url,
        mainRoom.token,
        'breakout_ended',
      );
      if (!result.ok) {
        throw new Error(result.error || 'switch failed');
      }
    } catch (e) {
      console.error('return-to-main after breakout_ended failed:', e);
      showCallToast('Could not return to main room. Try Rejoin.', '⚠');
      // Fall back to end screen — user can click Rejoin.
      endCall();
    }
  }

  // Detect "I have an active assignment in a running session" right after
  // joining the main room and, if so, jump straight into the breakout. Used
  // when a host refreshes the page mid-breakout. Guests are skipped: every
  // call to join_call_as_guest mints a new guest-<hex>, so the previous
  // assignment row is orphaned and can't be resolved back to "me".
  async function maybeRehydrateBreakoutAssignment() {
    if (!state.parentRoomName || !state.myIdentity) return;
    if (!state.isHost) return; // guests have unstable identities
    let session;
    try {
      session = await rpcGetBreakoutSession(state.parentRoomName);
    } catch (e) {
      return; // transient; nothing to rehydrate
    }
    if (!session || session.error) return;
    if (!session.session) return;
    const status = session.session.status;
    if (status !== 'open' && status !== 'scheduled') return;

    const myAssignment = (session.assignments || [])
      .find((a) => a.participant_identity === state.myIdentity);
    if (!myAssignment) return;

    const room = (session.rooms || []).find((r) => r.id === myAssignment.room_id);
    if (!room) return;

    // Mint a breakout token and switch in. No takeover modal — this is a
    // silent rehydrate, user just lands in the room they already belonged to.
    try {
      const res = await rpcJoinBreakoutRoom(
        session.session.id,
        room.id,
        state.myIdentity,
      );
      if (!res || res.error || !res.token) return;
      const serverUrl = res.server_url || (state.joinData && state.joinData.server_url);
      const result = await switchRoom(serverUrl, res.token, 'rehydrate_breakout');
      if (!result.ok) return;
      state.currentBreakout = {
        sessionId: session.session.id,
        roomId: room.id,
        roomName: res.room_name || room.room_name,
        roomLabel: room.label,
        closesAt: session.session.closes_at
          ? new Date(session.session.closes_at)
          : null,
      };
      showBreakoutBanner();
      startBreakoutCountdown();
      startBreakoutSessionPoll();
    } catch (e) {
      console.debug('rehydrate breakout failed:', e && e.message);
    }
  }

  async function mintMainRoomToken() {
    if (state.hostToken) {
      const data = await joinCallAsHost(state.token, state.hostToken);
      if (data && !data.error && data.token) return data;
    }
    if (state.lastGuestName) {
      const data = await joinCallAsGuest(state.token, state.lastGuestName);
      if (data && !data.error && data.token && data.admission_status !== 'waiting') {
        return data;
      }
    }
    return null;
  }

  // ------------------------------------
  // Breakouts — Takeover modal + banner
  // ------------------------------------
  function showBreakoutTakeover(roomLabel, countSec) {
    const el = $('breakout-takeover');
    const roomEl = $('breakout-takeover-room');
    const countEl = $('breakout-takeover-count');
    if (!el || !roomEl || !countEl) return;
    roomEl.textContent = roomLabel;
    let remaining = countSec;
    countEl.textContent = String(remaining);
    el.classList.remove('hidden');
    const iv = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(iv);
        return;
      }
      countEl.textContent = String(remaining);
    }, 1000);
    // Auto-clear the interval when hideTakeover runs.
    el._iv = iv;
  }

  function hideBreakoutTakeover() {
    const el = $('breakout-takeover');
    if (!el) return;
    if (el._iv) { try { clearInterval(el._iv); } catch (_) {} el._iv = null; }
    el.classList.add('hidden');
  }

  function showBreakoutBanner() {
    const el = $('breakout-banner');
    if (!el || !state.currentBreakout) return;
    $('breakout-banner-room').textContent = state.currentBreakout.roomLabel;
    updateBreakoutBannerCountdown();
    el.classList.remove('hidden');
  }

  function hideBreakoutBanner() {
    const el = $('breakout-banner');
    if (el) el.classList.add('hidden');
  }

  function updateBreakoutBannerCountdown() {
    if (!state.currentBreakout || !state.currentBreakout.closesAt) return;
    const remaining = state.currentBreakout.closesAt.getTime() - Date.now();
    const secs = Math.max(0, Math.floor(remaining / 1000));
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    const el = $('breakout-banner-time');
    if (el) el.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    // Also the host panel active countdown
    const hostEl = $('breakout-active-time');
    if (hostEl) hostEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function startBreakoutCountdown() {
    stopBreakoutCountdown();
    state.breakoutCountdownTimer = setInterval(updateBreakoutBannerCountdown, 1000);
  }

  function stopBreakoutCountdown() {
    if (state.breakoutCountdownTimer) {
      clearInterval(state.breakoutCountdownTimer);
      state.breakoutCountdownTimer = null;
    }
  }

  // ------------------------------------
  // Breakouts — Session poll
  // ------------------------------------
  // Polls get_breakout_session every 5s. Used by host (panel open or session
  // active) and participant (inside a breakout, to pick up broadcast messages
  // and detect session close).
  function startBreakoutSessionPoll() {
    stopBreakoutSessionPoll();
    state.breakoutPollTimer = setInterval(pollBreakoutSession, 5000);
    pollBreakoutSession();
  }

  function stopBreakoutSessionPoll() {
    if (state.breakoutPollTimer) {
      clearInterval(state.breakoutPollTimer);
      state.breakoutPollTimer = null;
    }
  }

  async function pollBreakoutSession() {
    if (!state.parentRoomName) return;
    try {
      const data = await rpcGetBreakoutSession(state.parentRoomName);
      if (data && !data.error) {
        state.breakoutSession = data.session ? data : null;
        // Broadcast toast dedup
        if (state.breakoutSession && state.breakoutSession.session) {
          const bcastAt = state.breakoutSession.session.broadcast_at;
          const bcastMsg = state.breakoutSession.session.broadcast_message;
          if (bcastAt && bcastMsg && bcastAt !== state.lastBroadcastAt) {
            state.lastBroadcastAt = bcastAt;
            // Only surface on participants (hosts see their own send).
            if (!state.isHost && state.currentBreakout) {
              showCallToast('Host: ' + bcastMsg, '📢');
            }
          }
        }
        // Host-side unresolved help request badge
        if (state.isHost) {
          const help = (state.breakoutSession && state.breakoutSession.help_requests) || [];
          setBreakoutsBadge(help.length);
          if (state.hostPanelOpen) renderHostPanel();
        }
      }
    } catch (e) {
      console.debug('pollBreakoutSession:', e.message);
    }
  }

  // ------------------------------------
  // Breakouts — Participant help request
  // ------------------------------------
  async function participantRequestHelp() {
    if (!state.currentBreakout) return;
    const now = Date.now();
    if (state.helpRequestPendingUntil > now) return; // 10s cooldown
    state.helpRequestPendingUntil = now + 10000;
    const btn = $('btn-breakout-help');
    if (btn) btn.disabled = true;
    try {
      await rpcRequestBreakoutHelp(
        state.currentBreakout.sessionId,
        state.currentBreakout.roomId,
        state.myIdentity,
      );
      showCallToast('Help request sent', '✓');
    } catch (e) {
      console.error('requestHelp failed:', e);
      showCallToast('Could not send help request', '⚠');
    } finally {
      setTimeout(() => {
        const b = $('btn-breakout-help');
        if (b) b.disabled = false;
      }, 10000);
    }
  }

  // ------------------------------------
  // Breakouts — Host panel
  // ------------------------------------
  function toggleBreakoutHostPanel() {
    if (state.hostPanelOpen) hideBreakoutHostPanel();
    else showBreakoutHostPanel();
  }

  function showBreakoutHostPanel() {
    const el = $('breakout-host-panel');
    if (!el) return;
    state.hostPanelOpen = true;
    el.classList.remove('hidden');
    startBreakoutSessionPoll();
    renderHostPanel();
  }

  function hideBreakoutHostPanel() {
    const el = $('breakout-host-panel');
    if (!el) return;
    state.hostPanelOpen = false;
    el.classList.add('hidden');
    // Keep polling if there's still an active session (for badge).
    if (!state.breakoutSession || !state.breakoutSession.session) {
      stopBreakoutSessionPoll();
    }
  }

  // Re-render the manual-assignment picker list from current remote-participant
  // set. Shown only when mode=='manual'. Preserves prior selections by reading
  // the existing DOM's dataset values before rebuilding.
  function renderManualAssignPickers() {
    const list = $('breakout-manual-list');
    const modeSel = $('breakout-assign-mode');
    if (!list || !modeSel) return;
    const mode = modeSel.value;
    if (mode !== 'manual') {
      list.classList.add('hidden');
      list.innerHTML = '';
      return;
    }

    // Preserve existing selections.
    const prior = {};
    list.querySelectorAll('.breakout-manual-picker').forEach((sel) => {
      if (sel.dataset.identity) prior[sel.dataset.identity] = sel.value;
    });

    const roomCount = parseInt($('breakout-room-count').value, 10) || 2;
    const participants = [];
    if (state.room) {
      state.room.remoteParticipants.forEach((p) => {
        participants.push({ identity: p.identity, name: p.name || p.identity });
      });
    }

    list.innerHTML = '';
    if (participants.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'breakout-manual-empty';
      empty.textContent = 'No other participants in the call yet.';
      list.appendChild(empty);
      list.classList.remove('hidden');
      return;
    }

    const header = document.createElement('div');
    header.className = 'breakout-manual-header';
    header.textContent = 'Assign participants';
    list.appendChild(header);

    participants.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'breakout-manual-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'breakout-manual-name';
      nameEl.textContent = shortIdentity(p.identity);
      row.appendChild(nameEl);

      const sel = document.createElement('select');
      sel.className = 'breakout-manual-picker';
      sel.dataset.identity = p.identity;
      const none = document.createElement('option');
      none.value = '0';
      none.textContent = 'None';
      sel.appendChild(none);
      for (let i = 1; i <= roomCount; i++) {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = 'Room ' + i;
        sel.appendChild(opt);
      }
      // Restore prior value if still within range.
      const priorVal = parseInt(prior[p.identity], 10);
      if (priorVal >= 1 && priorVal <= roomCount) {
        sel.value = String(priorVal);
      } else {
        sel.value = '0';
      }
      row.appendChild(sel);
      list.appendChild(row);
    });

    list.classList.remove('hidden');
  }

  function renderHostPanel() {
    const createForm = $('breakout-create-form');
    const active = $('breakout-active');
    const hasActive =
      state.breakoutSession &&
      state.breakoutSession.session &&
      ['open', 'scheduled'].includes(state.breakoutSession.session.status);

    if (hasActive) {
      createForm.classList.add('hidden');
      active.classList.remove('hidden');
      renderActiveSession();
    } else {
      createForm.classList.remove('hidden');
      active.classList.add('hidden');
      renderManualAssignPickers();
    }
  }

  function renderActiveSession() {
    const sess = state.breakoutSession.session;
    const rooms = state.breakoutSession.rooms || [];
    const assignments = state.breakoutSession.assignments || [];
    const help = state.breakoutSession.help_requests || [];

    if (sess.closes_at) {
      state.currentBreakout = state.currentBreakout || {};
      state.currentBreakout.closesAt = new Date(sess.closes_at);
      updateBreakoutBannerCountdown();
    }

    // Rooms grid with participant counts
    const list = $('breakout-rooms-list');
    list.innerHTML = '';
    rooms.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'breakout-room-card';

      const head = document.createElement('div');
      head.className = 'breakout-room-card-head';
      const assigned = assignments.filter((a) => a.room_id === r.id);
      head.innerHTML =
        '<span>' + escapeHtml(r.label) + '</span>' +
        '<span class="breakout-room-card-count">' + assigned.length + ' people</span>';
      card.appendChild(head);

      if (assigned.length > 0) {
        const names = document.createElement('div');
        names.className = 'breakout-room-card-assignees';
        names.textContent = assigned
          .map((a) => shortIdentity(a.participant_identity))
          .join(', ');
        card.appendChild(names);
      }

      const actions = document.createElement('div');
      actions.className = 'breakout-room-card-actions';
      const visitBtn = document.createElement('button');
      visitBtn.className = 'btn btn-secondary btn-small';
      visitBtn.textContent = 'Visit';
      visitBtn.addEventListener('click', () => hostVisitRoom(r));
      actions.appendChild(visitBtn);
      card.appendChild(actions);

      list.appendChild(card);
    });

    // Help requests block
    const helpBlock = $('breakout-help-block');
    const helpList = $('breakout-help-list');
    if (help.length > 0) {
      helpBlock.classList.remove('hidden');
      helpList.innerHTML = '';
      help.forEach((h) => {
        const item = document.createElement('div');
        item.className = 'breakout-help-item';
        item.innerHTML =
          '<span>' + escapeHtml(shortIdentity(h.requester_identity)) + '</span>' +
          '<span class="breakout-help-actions"></span>';
        const actions = item.querySelector('.breakout-help-actions');
        const roomForHelp = rooms.find((r) => r.id === h.room_id);
        if (roomForHelp) {
          const visitBtn = document.createElement('button');
          visitBtn.className = 'btn btn-secondary btn-small';
          visitBtn.textContent = 'Visit';
          visitBtn.addEventListener('click', () => hostVisitRoom(roomForHelp));
          actions.appendChild(visitBtn);
        }
        const resolveBtn = document.createElement('button');
        resolveBtn.className = 'btn btn-ghost btn-small';
        resolveBtn.textContent = 'Dismiss';
        resolveBtn.addEventListener('click', () => hostResolveHelp(h.id));
        actions.appendChild(resolveBtn);
        helpList.appendChild(item);
      });
    } else {
      helpBlock.classList.add('hidden');
    }
  }

  async function hostCreateBreakouts() {
    const errorEl = $('breakout-create-error');
    errorEl.classList.add('hidden');

    const roomCount = parseInt($('breakout-room-count').value, 10);
    const durationMin = parseInt($('breakout-duration').value, 10);
    const mode = $('breakout-assign-mode').value; // 'auto' | 'manual'

    if (!(roomCount >= 2 && roomCount <= 20)) {
      errorEl.textContent = 'Room count must be 2-20';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!(durationMin >= 1 && durationMin <= 120)) {
      errorEl.textContent = 'Duration must be 1-120 minutes';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!state.creatorIdentity) {
      errorEl.textContent = 'Host identity missing — cannot create';
      errorEl.classList.remove('hidden');
      return;
    }

    // Build manual-assignment list from the per-participant pickers rendered
    // by renderManualAssignPickers(). Entries with value "" (None) stay
    // in the main room. Picker values are 1-based room indexes.
    const manualAssignments = [];
    if (mode === 'manual') {
      const pickers = document.querySelectorAll('.breakout-manual-picker');
      pickers.forEach((sel) => {
        const identity = sel.dataset.identity;
        const roomIndex = parseInt(sel.value, 10);
        if (identity && roomIndex >= 1 && roomIndex <= roomCount) {
          manualAssignments.push({
            participant_identity: identity,
            room_index: roomIndex,
          });
        }
      });
    }

    const btn = $('btn-breakout-create');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    try {
      const created = await rpcCreateBreakoutSession({
        parentRoom: state.parentRoomName,
        creatorIdentity: state.creatorIdentity,
        durationSeconds: durationMin * 60,
        roomCount: roomCount,
        autoAssign: mode === 'auto',
        assignments: manualAssignments,
      });
      if (created.error) throw new Error(created.error);

      const sessionId = created.session.id;
      const serverUrl = state.joinData && state.joinData.server_url;
      const closesAt = created.session.closes_at || null;

      // Per-participant tokens to publish (manual assigns from create + auto).
      const tokens = Array.isArray(created.tokens) ? [...created.tokens] : [];

      if (mode === 'auto') {
        const participants = getRemoteParticipantIdentities();
        if (participants.length > 0) {
          const res = await rpcAutoAssignBreakoutParticipants(sessionId, participants);
          if (res && res.error) throw new Error(res.error);
          if (res && Array.isArray(res.assignments)) {
            tokens.push(...res.assignments);
          }
        }
      }

      // Publish per-participant breakout_assign packets.
      const rooms = created.rooms || [];
      const labelByName = {};
      rooms.forEach((r) => { labelByName[r.room_name] = r.label; });
      for (const t of tokens) {
        if (!t || !t.participant_identity || t.participant_identity === state.myIdentity) {
          continue; // skip host self-assignments
        }
        await publishBreakoutAssignPacket({
          targetIdentity: t.participant_identity,
          sessionId: sessionId,
          serverUrl: serverUrl,
          token: t.token,
          roomName: t.room_name,
          roomLabel: labelByName[t.room_name] || t.room_name,
          closesAt: closesAt,
        });
      }

      showCallToast('Breakouts started', '✓');
      await pollBreakoutSession();
      renderHostPanel();
    } catch (e) {
      console.error('hostCreateBreakouts failed:', e);
      errorEl.textContent = 'Could not start breakouts: ' + (e.message || e);
      errorEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Start breakouts';
    }
  }

  async function hostEndBreakouts() {
    if (!state.breakoutSession || !state.breakoutSession.session) return;
    if (!confirm('End breakouts for everyone? Participants will be returned to the main room.')) {
      return;
    }
    try {
      const res = await rpcEndBreakoutSession(
        state.breakoutSession.session.id,
        state.creatorIdentity,
      );
      if (res && res.error) throw new Error(res.error);
      showCallToast('Breakouts ended', '✓');
      await pollBreakoutSession();
      renderHostPanel();
    } catch (e) {
      console.error('hostEndBreakouts failed:', e);
      showCallToast('Could not end: ' + e.message, '⚠');
    }
  }

  async function hostBroadcast() {
    if (!state.breakoutSession || !state.breakoutSession.session) return;
    const input = $('breakout-broadcast-msg');
    const msg = (input.value || '').trim();
    if (!msg) return;
    try {
      const res = await rpcBroadcastToBreakouts(
        state.breakoutSession.session.id,
        msg,
        state.creatorIdentity,
      );
      if (res && res.error) throw new Error(res.error);
      input.value = '';
      showCallToast('Broadcast sent', '✓');
    } catch (e) {
      console.error('hostBroadcast failed:', e);
      showCallToast('Broadcast failed: ' + e.message, '⚠');
    }
  }

  async function hostVisitRoom(room) {
    if (!state.breakoutSession || !state.breakoutSession.session) return;
    try {
      const res = await rpcJoinBreakoutRoom(
        state.breakoutSession.session.id,
        room.id,
        state.creatorIdentity,
      );
      if (res && res.error) throw new Error(res.error);
      if (!res || !res.token) throw new Error('No token returned');

      // Host uses the same switchRoom flow as participants.
      hideBreakoutHostPanel();
      showBreakoutTakeover(room.label, 2);
      await new Promise((r) => setTimeout(r, 800));
      const result = await switchRoom(
        res.server_url || (state.joinData && state.joinData.server_url),
        res.token,
        'host_visit',
      );
      hideBreakoutTakeover();
      if (result.ok) {
        state.currentBreakout = {
          sessionId: state.breakoutSession.session.id,
          roomId: room.id,
          roomName: res.room_name || room.room_name,
          roomLabel: room.label,
          closesAt: state.breakoutSession.session.closes_at
            ? new Date(state.breakoutSession.session.closes_at) : null,
        };
        showBreakoutBanner();
        startBreakoutCountdown();
      }
    } catch (e) {
      console.error('hostVisitRoom failed:', e);
      showCallToast('Could not visit room: ' + e.message, '⚠');
    }
  }

  async function hostResolveHelp(helpId) {
    try {
      const res = await rpcResolveHelpRequest(helpId, state.creatorIdentity);
      if (res && res.error) throw new Error(res.error);
      await pollBreakoutSession();
    } catch (e) {
      console.error('hostResolveHelp failed:', e);
      showCallToast('Could not dismiss: ' + e.message, '⚠');
    }
  }

  async function publishBreakoutAssignPacket(opts) {
    if (!state.room) return;
    try {
      const payload = {
        type: 'breakout_assign',
        session_id: opts.sessionId,
        server_url: opts.serverUrl,
        token: opts.token,
        room_name: opts.roomName,
        room_label: opts.roomLabel,
      };
      if (opts.closesAt) payload.closes_at = opts.closesAt;
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      await state.room.localParticipant.publishData(bytes, {
        reliable: true,
        destinationIdentities: [opts.targetIdentity],
      });
    } catch (e) {
      console.error('publishBreakoutAssignPacket failed:', e);
    }
  }

  function getRemoteParticipantIdentities() {
    if (!state.room) return [];
    const out = [];
    state.room.remoteParticipants.forEach((p) => { out.push(p.identity); });
    return out;
  }

  function shortIdentity(id) {
    if (!id) return 'unknown';
    if (id.startsWith('guest-')) return 'Guest ' + id.slice(6, 12);
    if (id.length > 10) return id.slice(0, 8);
    return id;
  }

  // ------------------------------------
  // Toast
  // ------------------------------------
  let _toastTimer = null;
  function showCallToast(text, icon) {
    const el = $('call-toast');
    const textEl = $('call-toast-text');
    const iconEl = $('call-toast-icon');
    if (!el || !textEl) return;
    textEl.textContent = text;
    if (iconEl) iconEl.textContent = icon || 'ℹ';
    el.classList.remove('hidden');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      el.classList.add('hidden');
      _toastTimer = null;
    }, 4000);
  }

  // Track last guest name so we can re-mint a main-room token after a
  // breakout ends. Captured at click time (vs. reading input later, which
  // may be cleared by the time we need it).
  document.addEventListener('click', function (e) {
    if (e.target) {
      const btn = e.target.closest && e.target.closest('#btn-join');
      if (btn) {
        const nameInput = $('guest-name');
        if (nameInput) state.lastGuestName = (nameInput.value || '').trim();
      }
    }
  }, true);

  // Start the app
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
