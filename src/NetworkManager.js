import WebSocket from 'ws';
import { EventEmitter } from 'events';

export class NetworkManager extends EventEmitter {
  constructor(wsUrl, roomId) {
    super();
    this.wsUrl = wsUrl;
    this.roomId = roomId;
    this.ws = null;
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.pingTimeout = null;
    this.isOffline = false;
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingInterval);
    clearTimeout(this.pingTimeout);

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      this.isOffline = false;
      this.emit('connected', { wsUrl: this.wsUrl, roomId: this.roomId });

      // Join room
      this.send({ type: 'join', roomId: this.roomId });

      // Request current state from existing clients in the room
      this.send({ type: 'request_state', roomId: this.roomId });

      // Setup Heartbeat
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
          this.pingTimeout = setTimeout(() => {
            this.emit('error', new Error('Heartbeat failed. Terminating zombie connection...'));
            this.ws.terminate();
          }, 5000);
        }
      }, 5000);
    });

    this.ws.on('pong', () => {
      clearTimeout(this.pingTimeout);
    });

    this.ws.on('message', (messageAsString) => {
      try {
        const parsedMessage = JSON.parse(messageAsString);
        this.emit('message', parsedMessage);
      } catch (error) {
        this.emit('error', new Error(`Error parsing incoming message: ${error.message}`));
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
    
    this.ws.on('close', () => {
      clearInterval(this.pingInterval);
      clearTimeout(this.pingTimeout);
      
      this.emit('disconnected', this.isOffline);
      this.isOffline = true;
      
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }

  send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      this.emit('error', new Error('WebSocket is not open.'));
    }
  }

  isConnected() {
    return this.ws !== null && this.ws.readyState === 1;
  }
}
