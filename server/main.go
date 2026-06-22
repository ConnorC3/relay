package main

import (
	"flag"
	"log"
	"net/http"
)

var addr = flag.String("addr", ":8080", "http service address")

func main() {
	flag.Parse()
	rm := newRoomManager()

	// Register routes
	http.HandleFunc("/ws/", func(w http.ResponseWriter, r *http.Request) {
		// Get room id from url
		roomID := r.URL.Path[len("/ws/"):]
		if roomID == "" {
			http.Error(w, "Room ID required", http.StatusBadRequest)
			return
		}
		room := rm.getOrCreateRoom(roomID)
		serveWs(room, w, r)
	})

	// Start up server
	err := http.ListenAndServe(*addr, nil)
	if err != nil {
		log.Fatal(err)
	}
}
