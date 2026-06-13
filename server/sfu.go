package main

import (
	"log"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type Peer struct {
	pc     *webrtc.PeerConnection
	tracks []string // Track IDs
}

type SFU struct {
	listLock    sync.RWMutex
	peers       map[string]*Peer                       // Peer ID -> Peer
	localTracks map[string]*webrtc.TrackLocalStaticRTP // Track ID -> Track
	room        *Room
}

func (s *SFU) AddPeer(peerID string) {
	peerConnection, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		log.Printf("Error creating new peer connection: %v", err)
		return
	}

	// Accept one audio and one video incoming
	for _, codecType := range []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo, webrtc.RTPCodecTypeAudio} {
		if _, err := peerConnection.AddTransceiverFromKind(codecType, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			log.Printf("Error adding transceiver: %v", err)
			return
		}
	}

	peerConnection.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		// May need to use RTPReceiver in the future, but not now
		s.onTrackReceived(peerID, tr)
	})

	s.listLock.Lock()
	s.peers[peerID] = &Peer{pc: peerConnection}
	s.listLock.Unlock()

	// signalConnections to sync state
}

func (s *SFU) onTrackReceived(peerID string, tr *webrtc.TrackRemote) {
	log.Printf("Got remote track: Kind=%s, ID=%s, PayloadType=%d", tr.Kind(), tr.ID(), tr.PayloadType())

	trackLocal, err := webrtc.NewTrackLocalStaticRTP(tr.Codec().RTPCodecCapability, tr.ID(), tr.StreamID())
	if err != nil {
		log.Printf("Error converting remote track to local: %v", err)
		return
	}

	s.listLock.Lock()
	s.localTracks[tr.ID()] = trackLocal
	if peer, ok := s.peers[peerID]; ok {
		peer.tracks = append(peer.tracks, tr.ID())
	}
	s.listLock.Unlock()

	// signalConnections to sync state

	defer s.removeTrack(trackLocal)

	buf := make([]byte, 1500)
	rtpPkt := &rtp.Packet{}

	for {
		n, _, err := tr.Read(buf)
		if err != nil {
			return
		}

		if err = rtpPkt.Unmarshal(buf[:n]); err != nil {
			log.Printf("Failed to unmarshal incoming RTP packet: %v", err)
			return
		}

		rtpPkt.Extension = false
		rtpPkt.Extensions = nil

		if err = trackLocal.WriteRTP(rtpPkt); err != nil {
			return
		}
	}

}

func (s *SFU) removeTrack(t webrtc.TrackLocal) {
	s.listLock.Lock()
	defer func() {
		s.listLock.Unlock()
		// signalConnections
	}()

	delete(s.localTracks, t.ID())
}

func (s *SFU) RemovePeer(peerID string) {
	s.listLock.Lock()
	defer func() {
		s.listLock.Unlock()
		// signalConnections
	}()

	// close peer connection and remove all related tracks

	peer, ok := s.peers[peerID]
	if !ok {
		return
	}

	for _, tID := range peer.tracks {
		delete(s.localTracks, tID)
	}

	delete(s.peers, peerID)
	peer.pc.Close()
}

func (s *SFU) signalConnections() {

}
