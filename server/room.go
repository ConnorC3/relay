package main

import (
	"encoding/json"
	"log"
	"time"
)

type PlaybackState struct {
	Position  float64 // stored in seconds
	Playing   bool
	UpdatedAt time.Time
	VideoURL  string
}

type Message struct {
	Type    string          `json:"type"`
	PeerID  string          `json:"peer_id"`
	Target  string          `json:"target,omitempty"`
	Payload json.RawMessage `json:"payload"`
}

type Room struct {
	clients    map[string]*Client // peer ID -> Client
	playback   PlaybackState
	register   chan *Client
	unregister chan *Client
	broadcast  chan Message
	sfu        *SFU
}

func newRoom() *Room {
	r := &Room{
		clients:    make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan Message),
	}
	r.sfu = newSFU(r)
	go r.Run()
	return r
}

func (r *Room) sendRoomState(c *Client) {
	log.Printf("playback state: position=%.2f playing=%v updatedAt=%v",
		r.playback.Position, r.playback.Playing, r.playback.UpdatedAt)

	log.Printf("Sending video link to new client: %v", r.playback.VideoURL)

	currentPos := r.playback.Position
	if r.playback.Playing {
		currentPos += time.Since(r.playback.UpdatedAt).Seconds()
	}

	state := map[string]any{
		"type": "room_state",
		"payload": map[string]any{
			"position":   currentPos,
			"playing":    r.playback.Playing,
			"peer_count": len(r.clients),
			"video_url":  r.playback.VideoURL,
		},
	}

	r.sendToClient(c.id, state)
}

func (r *Room) sendPeerID(c *Client) {
	msg := map[string]any{
		"type":    "peer_id",
		"payload": map[string]any{"peer_id": c.id},
	}

	r.sendToClient(c.id, msg)
}

func (r *Room) broadcastPeerCount() {
	for _, client := range r.clients {
		msg := map[string]any{
			"type":    "peer_count",
			"payload": map[string]any{"count": len(r.clients)},
		}
		r.sendToClient(client.id, msg)
	}
}

func (r *Room) broadcastPeerLeft(peerID string) {
	r.sfu.listLock.RLock()
	peer, ok := r.sfu.peers[peerID]
	var streamIDs []string
	if ok {
		seen := map[string]bool{}
		for _, trackID := range peer.tracks {
			if track, exists := r.sfu.localTracks[trackID]; exists {
				sid := track.StreamID()
				if !seen[sid] {
					seen[sid] = true
					streamIDs = append(streamIDs, sid)
				}
			}
		}
	}
	r.sfu.listLock.RUnlock()

	for id, client := range r.clients {
		if id == peerID {
			continue
		}
		msg := map[string]any{
			"type": "peer_left",
			"payload": map[string]any{
				"peer_id":    peerID,
				"stream_ids": streamIDs,
			},
		}
		r.sendToClient(client.id, msg)
	}
}

func (r *Room) Run() {
	for {
		select {
		case client := <-r.register:
			log.Println("Registering client")

			r.clients[client.id] = client
			// send room state to client
			r.sendPeerID(client)
			r.sendRoomState(client)
			// add peer to sfu
			r.sfu.AddPeer(client.id)
			r.broadcastPeerCount()

			log.Printf("Client id: %s", client.id)
		case client := <-r.unregister:
			log.Println("Unregistering client")

			if _, ok := r.clients[client.id]; ok {
				r.broadcastPeerLeft(client.id)
				delete(r.clients, client.id)
				close(client.send)
				r.sfu.RemovePeer(client.id)
				r.broadcastPeerCount()
			}
		case msg := <-r.broadcast:
			switch msg.Type {
			case "answer":
				r.sfu.HandleAnswer(msg.PeerID, msg)
			case "ice_candidate":
				r.sfu.HandleCandidate(msg.PeerID, msg)
			case "play", "pause", "seek":
				// sync server-side room state
				var payload struct {
					Position float64 `json:"position"`
					VideoURL string  `json:"video_url"`
				}

				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("Error unmarshaling payload: %v", err)
					continue
				}

				log.Printf("Playback event: type=%s position=%.2f from peer=%s, video link=%s", msg.Type, payload.Position, msg.PeerID, payload.VideoURL)
				switch msg.Type {
				case "play":
					r.playback.Playing = true
					r.playback.Position = payload.Position
				case "pause":
					if r.playback.Playing {
						r.playback.Position += time.Since(r.playback.UpdatedAt).Seconds()
					}
					r.playback.Playing = false
				case "seek":
					r.playback.Position = payload.Position
				}

				r.playback.UpdatedAt = time.Now()
				if payload.VideoURL != "" {
					r.playback.VideoURL = payload.VideoURL
				}

				// sync playback for all room members
				for id, member := range r.clients {
					if id != msg.PeerID {
						r.sendToClient(member.id, msg)
					}
				}
			default:
				log.Printf("Unknown message: %+v", msg)
			}
		}
	}
}

// Non-blocking send to client with id 'peerID'
func (r *Room) sendToClient(peerID string, v any) {
	c, ok := r.clients[peerID]
	if !ok {
		return
	}

	rawBytes, err := json.Marshal(v)
	if err != nil {
		log.Printf("Error marshaling message: %v", err)
		return
	}

	select {
	case c.send <- rawBytes:
	default:
		delete(r.clients, c.id)
		close(c.send)
	}
}
