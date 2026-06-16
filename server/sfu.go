package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

type Peer struct {
	conn   *webrtc.PeerConnection
	tracks []string // Track IDs
}

type SFU struct {
	listLock    sync.RWMutex
	peers       map[string]*Peer                       // Peer ID -> Peer
	localTracks map[string]*webrtc.TrackLocalStaticRTP // Track ID -> Track
	room        *Room
}

func newSFU(room *Room) *SFU {
	s := &SFU{
		room:        room,
		peers:       make(map[string]*Peer),
		localTracks: make(map[string]*webrtc.TrackLocalStaticRTP),
	}
	s.startKeyFrameDispatcher()
	return s
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

	peerConnection.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}

		candidateJSON, err := json.Marshal(cand.ToJSON())
		if err != nil {
			log.Printf("Failed to marhsal candidate to json: %v", err)
			return
		}

		log.Printf("Send candidate to client: %s", candidateJSON)

		msg := &Message{Type: "ice_candidate", Payload: candidateJSON}
		s.room.sendToClient(peerID, msg)
	})

	peerConnection.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		// May need to use RTPReceiver in the future, but not now
		s.onTrackReceived(peerID, tr)
	})

	s.listLock.Lock()
	s.peers[peerID] = &Peer{conn: peerConnection}
	s.listLock.Unlock()

	s.signalConnections()
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
	s.signalConnections()
	s.dispatchKeyFrame()

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
		s.signalConnections()
	}()

	delete(s.localTracks, t.ID())
}

func (s *SFU) RemovePeer(peerID string) {
	s.listLock.Lock()
	defer func() {
		s.listLock.Unlock()
		// signalConnections
		s.signalConnections()
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
	peer.conn.Close()
}

func (s *SFU) signalConnections() {
	s.listLock.Lock()
	defer func() {
		s.listLock.Unlock()
		s.dispatchKeyFrame()
	}()

	attemptSync := func() bool {
		for peerID, peer := range s.peers {
			if peer.conn.ConnectionState() == webrtc.PeerConnectionStateClosed {
				delete(s.peers, peerID)
				return true
			}

			existingSenders := make(map[string]bool)
			for _, sender := range peer.conn.GetSenders() {
				if sender.Track() == nil {
					continue
				}

				existingSenders[sender.Track().ID()] = true

				if _, ok := s.localTracks[sender.Track().ID()]; !ok {
					if err := peer.conn.RemoveTrack(sender); err != nil {
						log.Printf("Error removing track: %v", err)
						return true
					}
				}
			}

			// Make sure we don't receive tracks (A/V) we are sending
			for _, receiver := range peer.conn.GetReceivers() {
				if receiver.Track() == nil {
					continue
				}

				existingSenders[receiver.Track().ID()] = true
			}

			// Add tracks we aren't sending yet to the peerConnection
			for trackID, track := range s.localTracks {
				if _, ok := existingSenders[trackID]; !ok {
					if _, err := peer.conn.AddTrack(track); err != nil {
						log.Printf("Error adding new sending track: %v", err)
						return true
					}
				}
			}

			offer, err := peer.conn.CreateOffer(nil)
			if err != nil {
				log.Printf("Error creating offer: %v", err)
				return true
			}

			if err := peer.conn.SetLocalDescription(offer); err != nil {
				log.Printf("Error setting local description: %v", err)
				return true
			}

			offerJSON, err := json.Marshal(offer)
			if err != nil {
				log.Printf("Failed to marshal offer to json: %v", err)
				return true
			}

			msg := &Message{Type: "offer", Payload: offerJSON}
			s.room.sendToClient(peerID, msg)
		}
		return false
	}

	for attempt := 0; ; attempt++ {
		if attempt == 25 {
			go func() {
				time.Sleep(time.Second * 3)
				s.signalConnections()
			}()
			return
		}

		if !attemptSync() {
			break
		}
	}
}

func (s *SFU) dispatchKeyFrame() {
	s.listLock.Lock()
	defer s.listLock.Unlock()

	for _, peer := range s.peers {
		// log.Printf("Dispatching PLI to %d receivers for peer %s", len(peer.conn.GetReceivers()), peerID)
		for _, receiver := range peer.conn.GetReceivers() {
			if receiver.Track() == nil {
				continue
			}

			if err := peer.conn.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{
					MediaSSRC: uint32(receiver.Track().SSRC()),
				},
			}); err != nil {
				log.Printf("Error dispatching keyframe: %v", err)
			}
		}
	}
}

func (s *SFU) startKeyFrameDispatcher() {
	ticker := time.NewTicker(time.Second * 3)
	go func() {
		for range ticker.C {
			s.dispatchKeyFrame()
		}
	}()
}

func (s *SFU) HandleAnswer(peerID string, msg Message) {
	answer := webrtc.SessionDescription{}

	if err := json.Unmarshal(msg.Payload, &answer); err != nil {
		log.Printf("Error unmarshaling answer: %v", err)
		return
	}

	log.Printf("Got answer: %v", answer)

	s.listLock.Lock()
	peer, ok := s.peers[peerID]
	s.listLock.Unlock()

	if !ok {
		log.Printf("No peer with peerID %s found when handling browser answer", peerID)
		return
	}

	if err := peer.conn.SetRemoteDescription(answer); err != nil {
		log.Printf("Failed to set remote description: %v", err)
		return
	}
}

func (s *SFU) HandleCandidate(peerID string, msg Message) {
	candidate := webrtc.ICECandidateInit{}

	if err := json.Unmarshal(msg.Payload, &candidate); err != nil {
		log.Printf("Error unmarshaling candidate: %v", err)
		return
	}

	log.Printf("Got candidate: %v", candidate)

	s.listLock.Lock()
	peer, ok := s.peers[peerID]
	s.listLock.Unlock()

	if !ok {
		log.Printf("No peer with peerID %s found when handling ice candidate", peerID)
		return
	}

	if err := peer.conn.AddICECandidate(candidate); err != nil {
		log.Printf("Error adding ice candidate: %v", err)
		return
	}
}
