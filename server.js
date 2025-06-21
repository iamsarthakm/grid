const WebSocket = require('ws');
const { v4: uuid } = require('uuid');

const wss = new WebSocket.Server({ port: 8080 });

const grid = {}; // { cellId: { value, lastUpdated, lastUpdatedBy } }
const clients = {}; // { connectionId: { ws, userId, position, name } }

console.log('WebSocket server running on ws://localhost:8080');

function ensureGridSize(minRows = 100, minCols = 26) {
  let maxRow = -1, maxCol = -1;
  Object.keys(grid).forEach(cellId => {
    const [r, c] = cellId.split('-').map(Number);
    if (r > maxRow) maxRow = r;
    if (c > maxCol) maxCol = c;
  });
  
  for (let r = 0; r < Math.max(minRows, maxRow + 1); r++) {
    for (let c = 0; c < Math.max(minCols, maxCol + 1); c++) {
      const cellId = `${r}-${c}`;
      if (!grid[cellId]) {
        grid[cellId] = { 
          value: '', 
          lastUpdated: Date.now(),
          lastUpdatedBy: null
        };
      }
    }
  }
}

function broadcastUserList() {
  const userList = Object.values(clients)
    .filter(client => client.name) // Only users who have set their name
    .map(client => ({
      userId: client.userId,
      name: client.name,
      position: client.position,
      color: client.color
    }));
  
  broadcast({ 
    type: 'user-list', 
    users: userList,
    timestamp: Date.now()
  });
}

wss.on('connection', (ws) => {
  const connectionId = uuid();
  const userColor = getRandomColor();
  clients[connectionId] = { 
    ws, 
    userId: connectionId, 
    position: null,
    name: null,  // Initialize name as null
    color: userColor
  };

  console.log(`[Connected] ${connectionId}`);

  // Send initialization data
  ws.send(JSON.stringify({ 
    type: 'init', 
    userId: connectionId,
    color: userColor
  }));

  ensureGridSize();
  ws.send(JSON.stringify({ 
    type: 'full-grid', 
    grid,
    timestamp: Date.now()
  }));

  broadcastUserList();

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      handleMessage(connectionId, data);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });

  ws.on('close', () => {
    delete clients[connectionId];
    broadcast({ 
      type: 'user-leave', 
      userId: connectionId,
      timestamp: Date.now()
    });
    broadcastUserList();
    console.log(`[Disconnected] ${connectionId}`);
  });
});

function handleMessage(senderId, message) {
  switch (message.type) {
    case 'set-name':
      clients[senderId].name = message.name;
      broadcastUserList();
      break;

    case 'cell-edit': {
      const { cellId, value } = message;
      const currentCell = grid[cellId];
      
      // Conflict resolution: last write wins
      if (!currentCell || message.timestamp >= (currentCell.lastUpdated || 0)) {
        grid[cellId] = { 
          value, 
          lastUpdated: message.timestamp || Date.now(),
          lastUpdatedBy: senderId
        };
        
        broadcast({ 
          type: 'cell-update', 
          cellId,
          value,
          lastUpdatedBy: senderId,
          timestamp: message.timestamp || Date.now()
        });
      }
      break;
    }

    case 'user-cell-position-change': {
      clients[senderId].position = message.position;
      broadcast({ 
        type: 'user-position-update', 
        userId: senderId, 
        position: message.position,
        timestamp: Date.now()
      });
      break;
    }

    case 'add-row': {
      const colCount = Object.keys(grid).reduce((max, cellId) => {
        const col = parseInt(cellId.split('-')[1], 10);
        return Math.max(max, col);
      }, 25) + 1;
      
      const newRowIdx = Object.keys(grid).reduce((max, cellId) => {
        const row = parseInt(cellId.split('-')[0], 10);
        return Math.max(max, row);
      }, 99) + 1;
      
      for (let c = 0; c < colCount; c++) {
        grid[`${newRowIdx}-${c}`] = { 
          value: '', 
          lastUpdated: Date.now(),
          lastUpdatedBy: senderId
        };
      }
      
      broadcast({ 
        type: 'row-added', 
        rowIndex: newRowIdx,
        colCount,
        timestamp: Date.now()
      });
      break;
    }

    case 'delete-row': {
      const rowToDelete = Object.keys(grid).reduce((max, cellId) => {
        const row = parseInt(cellId.split('-')[0], 10);
        return Math.max(max, row);
      }, 99);
      
      for (let c = 0; c < COLS; c++) {
        delete grid[`${rowToDelete}-${c}`];
      }
      
      broadcast({ 
        type: 'row-deleted', 
        rowIndex: rowToDelete,
        timestamp: Date.now()
      });
      break;
    }

    // Similar implementations for add-col and delete-col
    // ...
    
    default:
      console.warn(`Unhandled message type: ${message.type}`);
  }
}

function broadcast(data) {
  const message = JSON.stringify(data);
  Object.values(clients).forEach(client => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

function getRandomColor() {
  const colors = [
    '#FF5252', '#FF4081', '#E040FB', '#7C4DFF', '#536DFE',
    '#448AFF', '#40C4FF', '#18FFFF', '#64FFDA', '#69F0AE',
    '#B2FF59', '#EEFF41', '#FFFF00', '#FFD740', '#FFAB40'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}