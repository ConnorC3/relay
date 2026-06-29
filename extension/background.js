const SERVER_URL = 'ws://localhost:8080'

// Service worker lifecycle 

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.session.remove('relay')
})

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.remove('relay')
})

// Message router 

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Popup 

    case 'get_state':
      handleGetState(sender, sendResponse)
      return true

    case 'create_room':
    case 'join_room':
      handleJoinRoom(msg.code, msg.tabId, sendResponse)
      return true

    case 'leave_room':
      handleLeaveRoom(msg.tabId ?? sender.tab?.id, sendResponse)
      return true

    // Content script lifecycle 

    // Content script signals it's ready after navigation or injection
    case 'content_ready':
      handleContentReady(sender.tab?.id)
      break

    // Content script reports its peer count for popup display
    case 'peer_count_update':
      updatePeerCount(sender.tab?.id, msg.count, sendResponse)
      break

    // Media controls forwarded from popup to content script 

    case 'mute':
    case 'unmute':
    case 'camera_off':
    case 'camera_on':
      // Forward to the tab the popup is currently viewing
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: msg.type }).catch(() => {})
      })
      break

    default:
      console.warn('[background] unknown message type:', msg.type)
  }
})

// Room management 

async function handleGetState(sender, sendResponse) {
  const { relay } = await chrome.storage.session.get('relay')
  if (!relay || !relay.inRoom) {
    sendResponse({ inRoom: false })
    return
  }

  // Check if this popup is being opened from a tab already in the room
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const currentTabId = tabs[0]?.id
  const tabInRoom = relay.tabs?.[currentTabId]

  sendResponse({
    inRoom: !!tabInRoom,
    roomCode: relay.roomCode,
    peerCount: relay.peerCount ?? 1
  })
}

async function handleJoinRoom(code, tabId, sendResponse) {
    const { relay } = await chrome.storage.session.get('relay')

    // Update storage — add this tab to the room
    const tabs = relay?.tabs ?? {}
    tabs[tabId] = true

    await chrome.storage.session.set({
        relay: {
        inRoom: true,
        roomCode: code,
        peerCount: relay?.peerCount ?? 1,
        tabs
        }
    })

    // Tell the content script in this tab to connect and inject sidebar
    chrome.tabs.sendMessage(tabId, {
        type: 'join_room',
        roomCode: code,
        serverURL: SERVER_URL
    }).then(() => {
        console.log('[background] join_room sent to tab', tabId)
    }).catch((err) => {
        console.warn('[background] failed to send join_room to content script:', err.message)
    })

    sendResponse({})
}

async function handleLeaveRoom(tabId, sendResponse) {
  const { relay } = await chrome.storage.session.get('relay')

  if (relay?.tabs) {
    delete relay.tabs[tabId]
    const remainingTabs = Object.keys(relay.tabs)

    if (remainingTabs.length === 0) {
      // No more tabs in the room — clear session entirely
      await chrome.storage.session.remove('relay')
    } else {
      await chrome.storage.session.set({ relay })
    }
  }

  // Tell content script to teardown
  chrome.tabs.sendMessage(tabId, { type: 'leave_room' }).catch(() => {})
  sendResponse?.({})
}

async function handleContentReady(tabId) {
  if (!tabId) return
  const { relay } = await chrome.storage.session.get('relay')
  if (!relay?.inRoom || !relay.tabs?.[tabId]) return

  // Re-send join_room so content script reinitializes after navigation
  chrome.tabs.sendMessage(tabId, {
    type: 'join_room',
    roomCode: relay.roomCode,
    serverURL: SERVER_URL
  }).catch(() => {})
}

async function updatePeerCount(tabId, count) {
  const { relay } = await chrome.storage.session.get('relay')
  if (!relay) return

  await chrome.storage.session.set({
    relay: { ...relay, peerCount: count }
  })

  // Notify popup if open
  chrome.runtime.sendMessage({ type: 'peer_count_update', count }).catch(() => {})
}
