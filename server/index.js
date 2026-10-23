const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static web app files (e.g. mobile web interface)
app.use(express.static(path.join(__dirname, 'public')));

// CORS middleware for cross-origin extension requests
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Endpoint for Chrome Extension to fetch dynamic script payload
app.get('/extension-payload.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(__dirname, 'public', 'extension-payload.js'));
});

// WebSocket Relay Broadcaster
wss.on('connection', (ws) => {
  console.log('[Ytm-r Server] Client connected');

  ws.on('message', (message) => {
    // Broadcast commands/state to all connected clients except sender
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });

  ws.on('close', () => console.log('[Ytm-r Server] Client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Ytm-r Server] Active on port ${PORT}`);
});