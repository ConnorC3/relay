package main

import (
	"log"
	"sync"
)

type RoomManager struct {
	rooms map[string]*Room // room code -> Room struct pointer
	mu    sync.RWMutex
}

func newRoomManager() *RoomManager {
	return &RoomManager{
		rooms: make(map[string]*Room),
	}
}

func (rm *RoomManager) getOrCreateRoom(roomID string) *Room {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if room, ok := rm.rooms[roomID]; ok {
		log.Println("Returning existing room")
		return room
	}

	room := newRoom()
	rm.rooms[roomID] = room
	log.Println("Returning newly created room")
	return room
}
