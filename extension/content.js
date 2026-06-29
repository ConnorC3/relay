// State 

let ws = null
let pc = null
let localStream = null
let myPeerID = null
let serverURL = null
let roomCode = null
let pendingCandidates = []
let remoteDescSet = false
let sidebarInjected = false
let video = null
let remoteTrackCount = 0

const suppressNext = { play: false, pause: false, seeked: false }

const ICE_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
}

// Message router 

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {

    case 'join_room':
      handleJoinRoom(msg.roomCode, msg.serverURL)
      break

    case 'leave_room':
      handleLeaveRoom()
      break

    // Playback sync from other peers via background → server → background → here
    case 'play':
      applyPlay(msg.position)
      break

    case 'pause':
      applyPause(msg.position)
      break

    case 'seek':
      applySeek(msg.position)
      break

    case 'room_state':
      applyRoomState(msg)
      break

    // Media controls from popup
    case 'mute':
      setAudioEnabled(false)
      updateMuteButton(true)
      break

    case 'unmute':
      setAudioEnabled(true)
      updateMuteButton(false)
      break

    case 'camera_off':
      setVideoEnabled(false)
      updateCameraButton(true)
      break

    case 'camera_on':
      setVideoEnabled(true)
      updateCameraButton(false)
      break
  }
})

// Room lifecycle 

async function handleJoinRoom(code, url) {
  if (sidebarInjected) return

  roomCode = code
  serverURL = url

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    injectSidebar(code)
    createPeerConnection()
    attachVideoHooks()
    openWebSocket(code)
  } catch (err) {
    console.error('[relay] failed to join room:', err)
  }
}

function handleLeaveRoom() {
  teardown()
  removeSidebar()
  detachVideoHooks()

  sidebarInjected = false
  roomCode = null
  serverURL = null
}

// WebSocket 

function openWebSocket(code) {
  const url = `${serverURL}/ws/${code}`
  console.log('[relay] connecting to', url)

  ws = new WebSocket(url)

  ws.onopen = () => console.log('[relay] WebSocket connected')

  ws.onclose = () => {
    console.log('[relay] WebSocket closed')
    ws = null
  }

  ws.onerror = () => console.error('[relay] WebSocket error')

  ws.onmessage = (event) => {
    handleServerMessage(JSON.parse(event.data))
  }
}

function sendToServer(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    console.warn('[relay] tried to send but WS not open:', msg.type)
  }
}

// Server message handling 

function handleServerMessage(msg) {
    console.log('[relay] recv:', msg.type)

    switch (msg.type) {

    case 'peer_id':
        myPeerID = msg.payload.peer_id
        break

    case 'room_state':
        updatePeerCount(msg.payload.peer_count ?? 1)

        const videoURL = msg.payload.video_url
        if (videoURL && videoURL !== window.location.href) {
            // Store seek target before navigating
            sessionStorage.setItem('relay-seek-position', msg.payload.position)
            sessionStorage.setItem('relay-seek-playing', msg.payload.playing)
            window.location.href = videoURL
            return // don't apply room state, we're navigating away
        }

        applyRoomState({
            position: msg.payload.position,
            playing: msg.payload.playing
        })
        break

    case 'offer':
        handleOffer(msg.payload)
        break

    case 'ice_candidate':
        handleIceCandidate(msg.payload)
        break

    case 'play':
        applyPlay(msg.payload?.position)
        break

    case 'pause':
        applyPause(msg.payload?.position)
        break

    case 'seek':
        applySeek(msg.payload.position)
        break

    case 'peer_count':
        updatePeerCount(msg.payload.count)
        break

    case 'peer_left':
        console.log('[relay] peer_left stream_ids:', msg.payload.stream_ids)
        const leavingStreamIds = msg.payload.stream_ids ?? []
        leavingStreamIds.forEach(streamId => {
            document.getElementById('relay-tile-' + streamId)?.remove()
        })
        break


    default:
        console.warn('[relay] unhandled message:', msg.type)
    }
}

// PeerConnection 

function createPeerConnection() {
  pc = new RTCPeerConnection(ICE_CONFIG)

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream)
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate) return
    sendToServer({ type: 'ice_candidate', payload: event.candidate.toJSON() })
  }

  pc.ontrack = (event) => {
    console.log('[relay] ontrack:', event.track.kind, event.track.id)

    const stream = event.streams[0]

    if (event.track.kind === 'video') {
        addRemoteVideoTile(stream)
    }

    const tile = document.getElementById('relay-tile-' + stream.id)
    if (tile) {
        const existing = JSON.parse(tile.dataset.trackIds || '[]')
        if (!existing.includes(event.track.id)) {
            tile.dataset.trackIds = JSON.stringify([...existing, event.track.id])
            console.log('[relay] updated tile trackIds:', tile.dataset.trackIds)
        }
    }
  }

  pc.onconnectionstatechange = () => {
    console.log('[relay] PeerConnection state:', pc.connectionState)
  }

  pc.oniceconnectionstatechange = () => {
    console.log('[relay] ICE state:', pc.iceConnectionState)
  }
}

// WebRTC signaling 

async function handleOffer(offer) {
  if (!pc) return

  try {
    await pc.setRemoteDescription(offer)
    remoteDescSet = true

    for (const c of pendingCandidates) {
      await pc.addIceCandidate(c)
    }
    pendingCandidates = []

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    sendToServer({ type: 'answer', payload: pc.localDescription.toJSON() })
  } catch (err) {
    console.error('[relay] error handling offer:', err)
  }
}

async function handleIceCandidate(candidate) {
  if (!pc) return
  if (!remoteDescSet) {
    pendingCandidates.push(candidate)
    return
  }
  try {
    await pc.addIceCandidate(candidate)
  } catch (err) {
    console.error('[relay] error adding ICE candidate:', err)
  }
}

// Teardown 

function teardown() {
  if (ws) { ws.close(); ws = null }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null }
  if (pc) { pc.close(); pc = null }
  myPeerID = null
  remoteDescSet = false
  pendingCandidates = []
  remoteTrackCount = 0
  sidebarInjected = false
}

// Media controls 

function setAudioEnabled(enabled) {
  localStream?.getAudioTracks().forEach(t => t.enabled = enabled)
}

function setVideoEnabled(enabled) {
  localStream?.getVideoTracks().forEach(t => t.enabled = enabled)
  const el = document.getElementById('relay-local-video')
  if (el) el.style.visibility = enabled ? 'visible' : 'hidden'
}

// Playback sync 

function attachVideoHooks() {
  const el = document.querySelector('video')
  if (el) {
    attachListeners(el)
    return
  }

  const interval = setInterval(() => {
    const el = document.querySelector('video')
    if (el) {
      clearInterval(interval)
      attachListeners(el)
    }
  }, 500)
}

function attachListeners(el) {
  video = el
  console.log('[relay] attached to video element')
  video.addEventListener('play', onPlay)
  video.addEventListener('pause', onPause)
  video.addEventListener('seeked', onSeeked)
}

function detachVideoHooks() {
  if (!video) return
  video.removeEventListener('play', onPlay)
  video.removeEventListener('pause', onPause)
  video.removeEventListener('seeked', onSeeked)
  video = null
}

function onPlay() {
  if (suppressNext.play) { suppressNext.play = false; return }
  sendToServer({ type: 'play', payload: { position: video.currentTime, video_url: window.location.href } })
}

function onPause() {
  if (suppressNext.pause) { suppressNext.pause = false; return }
  sendToServer({ type: 'pause', payload: { position: video.currentTime, video_url: window.location.href } })
}

function onSeeked() {
  if (suppressNext.seeked) { suppressNext.seeked = false; return }
  sendToServer({ type: 'seek', payload: { position: video.currentTime, video_url: window.location.href } })
}

function applyRoomState(msg) {
  if (!video) return
  suppressNext.seeked = true
  video.currentTime = msg.position
  if (msg.playing) {
    suppressNext.play = true
    video.play().catch(() => suppressNext.play = false)
  } else {
    suppressNext.pause = true
    video.pause()
  }
}

function applyPlay(position) {
  if (!video) return
  if (position !== undefined) { suppressNext.seeked = true; video.currentTime = position }
  suppressNext.play = true
  video.play().catch(() => suppressNext.play = false)
}

function applyPause(position) {
  if (!video) return
  if (position !== undefined) { suppressNext.seeked = true; video.currentTime = position }
  suppressNext.pause = true
  video.pause()
}

function applySeek(position) {
  if (!video) return
  suppressNext.seeked = true
  video.currentTime = position
}

// Peer count 

function updatePeerCount(count) {
  chrome.runtime.sendMessage({ type: 'peer_count_update', count }).catch(() => {})
}

// Sidebar 

function injectSidebar(code) {
    if (sidebarInjected) return
    sidebarInjected = true

    const sidebarWidth = '250px'

    // Push YouTube's main container
    const container = document.querySelector('ytd-app') || document.querySelector('.html5-video-player') || document.body
    //   const container = document.querySelector('.html5-main-video') || document.body
    container.style.marginRight = sidebarWidth
    container.style.transition = 'margin-right 0.2s ease'

    // 2. Target and push the fixed header/masthead containers
    const masthead = document.querySelector('ytd-masthead')

    if (masthead) {
        masthead.style.transition = 'right 0.2s ease, width 0.2s ease'
        
        // Move the right edge in by 200px
        masthead.style.setProperty('right', sidebarWidth)
        
        // Recalculate width to be (100% viewport width - 200px)
        masthead.style.setProperty('width', `calc(100vw - ${sidebarWidth})`)
        
        // Ensure it stays pinned to the left edge
        masthead.style.setProperty('left', '0px')
    }

    const sidebar = document.createElement('div')
    sidebar.id = 'relay-sidebar'
    sidebar.innerHTML = `
        <div id="relay-header">
        <div id="relay-logo">
            <div id="relay-dot"></div>
            Relay
        </div>
        <span id="relay-code">${code}</span>
        </div>
        <div id="relay-videos">
        <div class="relay-tile" id="relay-local-tile">
            <video id="relay-local-video" autoplay muted playsinline></video>
            <span class="relay-label">You</span>
        </div>
        </div>
        <div id="relay-controls">
        <button class="relay-btn" id="relay-mute-btn">Mute</button>
        <button class="relay-btn" id="relay-camera-btn">Camera</button>
        <button class="relay-btn relay-leave-btn" id="relay-leave-btn">Leave</button>
        </div>
    `

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = chrome.runtime.getURL('sidebar.css')
    document.head.appendChild(link)

    document.body.appendChild(sidebar)

    document.getElementById('relay-local-video').srcObject = localStream

    let muted = false
    let cameraOff = false

    document.getElementById('relay-mute-btn').onclick = () => {
        muted = !muted
        setAudioEnabled(!muted)
        updateMuteButton(muted)
        chrome.runtime.sendMessage({ type: muted ? 'mute' : 'unmute' }).catch(() => {})
    }

    document.getElementById('relay-camera-btn').onclick = () => {
        cameraOff = !cameraOff
        setVideoEnabled(!cameraOff)
        updateCameraButton(cameraOff)
        chrome.runtime.sendMessage({ type: cameraOff ? 'camera_off' : 'camera_on' }).catch(() => {})
    }

    document.getElementById('relay-leave-btn').onclick = () => {
        chrome.runtime.sendMessage({ type: 'leave_room', tabId: null }).catch(() => {})
        handleLeaveRoom()
    }
}

function removeSidebar() {
    const container = document.querySelector('ytd-app') || document.querySelector('.watch-video') || document.body
    const masthead = document.querySelector('ytd-masthead')
    container.style.marginRight = ''

    masthead.style.setProperty('right', '')        
    masthead.style.setProperty('width', '')
    masthead.style.setProperty('left', '')

    document.getElementById('relay-sidebar')?.remove()
    sidebarInjected = false
}

function addRemoteVideoTile(stream) {
  const container = document.getElementById('relay-videos')
  if (!container) return
  if (document.getElementById('relay-tile-' + stream.id)) return

  const tile = document.createElement('div')
  tile.className = 'relay-tile'
  tile.id = 'relay-tile-' + stream.id
  tile.dataset.trackIds = JSON.stringify(stream.getTracks().map(t => t.id))

  const video = document.createElement('video')
  video.autoplay = true
  video.playsinline = true
  video.srcObject = stream

  tile.appendChild(video)
  container.appendChild(tile)
}

function updateMuteButton(muted) {
  const btn = document.getElementById('relay-mute-btn')
  if (btn) btn.textContent = muted ? 'Unmute' : 'Mute'
}

function updateCameraButton(cameraOff) {
  const btn = document.getElementById('relay-camera-btn')
  if (btn) btn.textContent = cameraOff ? 'Show camera' : 'Camera'
}

// Check if we navigated here from a room_state redirect
const pendingPosition = sessionStorage.getItem('relay-seek-position')
if (pendingPosition !== null) {
  const pendingPlaying = sessionStorage.getItem('relay-seek-playing') === 'true'
  sessionStorage.removeItem('relay-seek-position')
  sessionStorage.removeItem('relay-seek-playing')

  // Wait for video element to be ready before seeking
  function waitAndSeek() {
    const el = document.querySelector('video')
    if (el && el.readyState >= 2) {
      applyRoomState({ position: parseFloat(pendingPosition), playing: pendingPlaying })
    } else {
      setTimeout(waitAndSeek, 200)
    }
  }
  waitAndSeek()
}

chrome.runtime.sendMessage({ type: 'content_ready' }).catch(() => {})
