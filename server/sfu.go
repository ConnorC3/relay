package main

import (
	"sync"

	"github.com/pion/webrtc/v4"
)

type Peer struct {
	peerConnection *webrtc.PeerConnection
	// different tracks
}

type SFU struct {
	listLock        sync.RWMutex
	peerConnections map[string]*Peer // Peer ID -> Peer
	localTracks     []*webrtc.TrackLocalStaticRTP
	room            *Room
}
