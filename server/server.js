// server/server.js
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();

wss.on('connection', (ws) => {
    let currentRoom = null;

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            const { type, roomId, payload } = parsedMessage;

            if (type === 'join') {
                currentRoom = roomId;
                if (!rooms.has(roomId)) {
                    rooms.set(roomId, new Set());
                }
                rooms.get(roomId).add(ws);
                console.log(`[+] Client joined room: ${roomId}`);
            }

            if (type === 'sync' && currentRoom) {
                console.log(`[*] Broadcasting update in room: ${currentRoom}`);
                const clients = rooms.get(currentRoom);
                clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'update', payload }));
                    }
                });
            }

            if (type === 'request_state' && currentRoom) {
                console.log(`[*] Forwarding state request in room: ${currentRoom}`);
                const clients = rooms.get(currentRoom);
                clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'request_state', roomId: currentRoom }));
                    }
                });
            }
        } catch (error) {
            console.error('[-] Failed to process message:', error);
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms.has(currentRoom)) {
            rooms.get(currentRoom).delete(ws);
            console.log(`[-] Client left room: ${currentRoom}`);
            
            if (rooms.get(currentRoom).size === 0) {
                rooms.delete(currentRoom);
                console.log(`[!] Room ${currentRoom} is empty and has been destroyed.`);
            }
        }
    });
});

// CHANGED: Removed the hardcoded localhost URL so it makes sense in the cloud
console.log(`🚀 Shadow-Sync Relay Server is listening on port ${PORT}`);