const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ' // ambiguous chars removed

const themeBtn = document.getElementById('themeBtn')

// Resolve initial theme: stored preference → system preference → light
function getInitialTheme() {
  const stored = localStorage.getItem('relay-theme')
  if (stored) return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme) {
  if (theme === 'dark') {
    document.body.classList.add('dark')
    themeBtn.textContent = '☽'
    themeBtn.setAttribute('aria-label', 'Switch to light mode')
  } else {
    document.body.classList.remove('dark')
    themeBtn.textContent = '☀'
    themeBtn.setAttribute('aria-label', 'Switch to dark mode')
  }
}

let currentTheme = getInitialTheme()
applyTheme(currentTheme)

themeBtn.onclick = () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark'
  localStorage.setItem('relay-theme', currentTheme)
  applyTheme(currentTheme)
}

// Also react to system changes if no stored preference
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!localStorage.getItem('relay-theme')) {
    currentTheme = e.matches ? 'dark' : 'light'
    applyTheme(currentTheme)
  }
})

// UI elements 

const idleState  = document.getElementById('idleState')
const roomState  = document.getElementById('roomState')
const createBtn  = document.getElementById('createBtn')
const joinBtn    = document.getElementById('joinBtn')
const leaveBtn   = document.getElementById('leaveBtn')
const muteBtn    = document.getElementById('muteBtn')
const cameraBtn  = document.getElementById('cameraBtn')
const copyBtn    = document.getElementById('copyBtn')
const codeInput  = document.getElementById('codeInput')
const displayCode = document.getElementById('displayCode')
const peerCount  = document.getElementById('peerCount')
const status     = document.getElementById('status')

// track local toggle state
let muted = false
let cameraOff = false

// On popup open, check if already in a room
chrome.runtime.sendMessage({ type: 'get_state' }, (response) => {
  if (response && response.inRoom) {
    showRoomState(response.roomCode, response.peerCount)
  }
})

// Listen for peer count updates from background while popup is open
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'peer_count_update') {
    updatePeerCount(msg.count)
  }
})

// Get the currently active tab ID — needed because sender.tab is null for popup messages
function getActiveTabId(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    callback(tabs[0]?.id ?? null)
  })
}

createBtn.onclick = () => {
  const code = generateCode()
  setStatus('')
  getActiveTabId((tabId) => {
    chrome.runtime.sendMessage({ type: 'create_room', code, tabId }, (response) => {
      if (response && response.error) {
        setStatus(response.error)
        return
      }
      showRoomState(code, 1)
    })
  })
}

joinBtn.onclick = () => {
  const code = codeInput.value.toUpperCase().trim()
  if (code.length !== 4) {
    setStatus('Enter a 4-letter room code')
    return
  }
  setStatus('')
  getActiveTabId((tabId) => {
    chrome.runtime.sendMessage({ type: 'join_room', code, tabId }, (response) => {
      if (response && response.error) {
        setStatus(response.error)
        return
      }
      showRoomState(code, response.peerCount)
    })
  })
}

// allow hitting enter in the input to join
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinBtn.click()
})

// force uppercase as user types
codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase()
})

leaveBtn.onclick = () => {
  getActiveTabId((tabId) => {
    chrome.runtime.sendMessage({ type: 'leave_room', tabId }, () => {
      showIdleState()
    })
  })
}

muteBtn.onclick = () => {
  muted = !muted
  muteBtn.textContent = muted ? 'Unmute' : 'Mute'
  muteBtn.classList.toggle('active', muted)
  chrome.runtime.sendMessage({ type: muted ? 'mute' : 'unmute' })
}

cameraBtn.onclick = () => {
  cameraOff = !cameraOff
  cameraBtn.textContent = cameraOff ? 'Show camera' : 'Camera'
  cameraBtn.classList.toggle('active', cameraOff)
  chrome.runtime.sendMessage({ type: cameraOff ? 'camera_off' : 'camera_on' })
}

copyBtn.onclick = () => {
  const code = displayCode.textContent
  navigator.clipboard.writeText(code).then(() => {
    copyBtn.textContent = 'Copied!'
    setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
  })
}

function showRoomState(code, count) {
  idleState.classList.add('hidden')
  roomState.classList.remove('hidden')
  displayCode.textContent = code
  updatePeerCount(count)

  // reset toggle state visually
  muted = false
  cameraOff = false
  muteBtn.textContent = 'Mute'
  cameraBtn.textContent = 'Camera'
  muteBtn.classList.remove('active')
  cameraBtn.classList.remove('active')
}

function showIdleState() {
  roomState.classList.add('hidden')
  idleState.classList.remove('hidden')
  peerCount.textContent = ''
  codeInput.value = ''
  setStatus('')
}

function updatePeerCount(count) {
  peerCount.textContent = `${count} watching`
}

function setStatus(msg) {
  status.textContent = msg
}

function generateCode() {
  return Array.from({ length: 4 }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('')
}
