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

			log.Printf("Client id: %s", client.id)
		case client := <-r.unregister:
			log.Println("Unregistering client")

			if _, ok := r.clients[client.id]; ok {
				delete(r.clients, client.id)
				close(client.send)
				r.sfu.RemovePeer(client.id)
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
				}

				if err := json.Unmarshal(msg.Payload, &payload); err != nil {
					log.Printf("Error unmarshaling payload: %v", err)
					continue
				}

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
