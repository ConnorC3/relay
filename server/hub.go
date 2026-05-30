package main

import (
	"log"
	"sync"
)

type Hub struct {
	rooms map[string]*Room // room code -> Room struct pointer
	mu    sync.RWMutex
}

func newHub() *Hub {
	return &Hub{
		rooms: make(map[string]*Room),
	}
}

func (h *Hub) getOrCreateRoom(roomID string) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()

	if room, ok := h.rooms[roomID]; ok {
		log.Println("Returning existing room")
		return room
	}

	room := newRoom()
	h.rooms[roomID] = room
	log.Println("Returning newly created room")
	return room
}
