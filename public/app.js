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
  };

  // ------------------------------------
  // DOM References
  // ------------------------------------
  const $ = (id) => document.getElementById(id);

  const screens = {
    landing: $('screen-landing'),
    loading: $('screen-loading'),
    error: $('screen-error'),
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
      $('btn-open-app').href = `${DEEP_LINK_BASE}/${state.token}`;
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

    // Remove old listeners before adding to prevent accumulation on rejoin
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

    // Show loading state
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

    // Add connecting overlay
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

      // Set up event handlers before connecting
      setupRoomEvents(room);

      // Connect to the room
      await room.connect(joinData.server_url, joinData.token);

      // Determine which tracks to publish
      const isVideo = joinData.call_type === 'video';

      // Publish local tracks
      await room.localParticipant.setMicrophoneEnabled(!state.isPreviewMicOff);
      if (isVideo) {
        await room.localParticipant.setCameraEnabled(!state.isPreviewCameraOff);
      }

      state.isMicMuted = state.isPreviewMicOff;
      state.isVideoOff = isVideo ? state.isPreviewCameraOff : true;

      // Update button states
      updateControlButtons();

      // Hide video button for audio-only calls
      if (!isVideo) {
        $('btn-video').style.display = 'none';
      }

      // Remove connecting overlay
      overlay.remove();

      // Update status
      $('call-status').textContent = 'Connected';
      $('call-status').classList.add('connected');

      // Start timer
      state.callStartTime = Date.now();
      state.timerInterval = setInterval(updateCallTimer, 1000);

      // Render initial participants
      renderParticipants();

    } catch (err) {
      console.error('Call start error:', err);
      overlay.remove();
      showError('Connection Failed', 'Could not connect to the call. Please try again.');
    }
  }

  function setupRoomEvents(room) {
    const LivekitClient = window.LivekitClient;

    room.on(LivekitClient.RoomEvent.ParticipantConnected, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackMuted, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.TrackUnmuted, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.LocalTrackPublished, () => {
      renderParticipants();
    });

    room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, () => {
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

    // Check for video track
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
      // Show avatar placeholder
      const avatar = document.createElement('div');
      avatar.className = 'avatar-placeholder';
      avatar.textContent = getInitials(participant.name || participant.identity);
      tile.appendChild(avatar);
    }

    // Name label
    const nameEl = document.createElement('div');
    nameEl.className = 'participant-name';

    // Mic indicator
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

    // Mic button
    micBtn.classList.toggle('muted', state.isMicMuted);
    micBtn.querySelector('.icon-mic-on').classList.toggle('hidden', state.isMicMuted);
    micBtn.querySelector('.icon-mic-off').classList.toggle('hidden', !state.isMicMuted);

    // Video button
    videoBtn.classList.toggle('muted', state.isVideoOff);
    videoBtn.querySelector('.icon-video-on').classList.toggle('hidden', state.isVideoOff);
    videoBtn.querySelector('.icon-video-off').classList.toggle('hidden', !state.isVideoOff);
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

    $('btn-hangup').addEventListener('click', () => {
      if (state.room) {
        state.room.disconnect();
      }
      endCall();
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

    // Stop timer
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }

    // Calculate duration
    let durationText = '';
    if (state.callStartTime) {
      const elapsed = Math.floor((Date.now() - state.callStartTime) / 1000);
      durationText = `Duration: ${formatDuration(elapsed)}`;
    }

    // Disconnect room
    if (state.room) {
      try {
        state.room.disconnect();
      } catch (e) {
        // ignore
      }
      state.room = null;
    }

    // Show ended screen
    $('ended-duration').textContent = durationText;
    showScreen('ended');

    // Rejoin button
    $('btn-rejoin').onclick = () => {
      _endingCall = false;
      state.callStartTime = null;
      state.isMicMuted = false;
      state.isVideoOff = false;
      showScreen('join');
      // Re-enable join button
      const joinBtn = $('btn-join');
      joinBtn.disabled = !$('guest-name').value.trim();
      joinBtn.querySelector('.btn-text').textContent = 'Join Call';
      joinBtn.querySelector('.btn-spinner').classList.add('hidden');
      // Restart video preview if it was a video call
      if (state.callLink && state.callLink.call_type === 'video') {
        startVideoPreview();
      }
    };
  }

  // ------------------------------------
  // Initialization
  // ------------------------------------
  async function init() {
    // Extract token from URL path
    const path = window.location.pathname.replace(/^\/+|\/+$/g, '');

    if (!path) {
      // Root page — show the landing page
      showScreen('landing');
      return;
    }

    state.token = path;

    // Set up call controls early
    setupCallControls();

    try {
      const data = await getCallLink(state.token);

      if (data.error) {
        showError('Link Not Found', data.error);
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
