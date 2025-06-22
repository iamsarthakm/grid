const WebSocket = require('ws');
const { v4: uuid } = require('uuid');
const axios = require('axios');

const wss = new WebSocket.Server({ port: 8080 });

const grid = {}; // { cellId: { rawValue, computedValue, lastUpdated, lastUpdatedBy } }
const clients = {}; // { connectionId: { ws, userId, position, name } }

console.log('WebSocket server running on ws://localhost:8080');

// Lambda-backed functions
// Lambda endpoint (local or deployed)
const LAMBDA_ENDPOINT = 'http://lambda-local:9001/2015-03-31/functions/function/invocations';
const GRID_FILE_ID = 'empty_grid_001'; // Hardcoded for demo, can be dynamic

// Update a cell via Lambda
async function lam_update_cell(gridFileId, cellCoordinate, rawValue) {
  const payload = {
    operation: 'update_cell',
    gridFileId,
    cellCoordinate,
    rawValue
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

// Fetch grid data via Lambda
async function lam_get_grid_data(gridFileId) {
  const payload = {
    operation: 'get_grid_data',
    gridFileId
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

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
          rawValue: '',
          computedValue: '',
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

wss.on('connection', async (ws) => {
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

  broadcastUserList();

  ws.on('message', async (msg) => {
    try {
      const data = JSON.parse(msg);
      await handleMessage(connectionId, data, ws);
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

async function handleMessage(senderId, message, ws) {
  switch (message.type) {
    case 'set-name':
      clients[senderId].name = message.name;
      broadcastUserList();
      break;

    case 'cell-edit': {
      const { cellId, value } = message;
      // Update in-memory grid and broadcast instantly
      if (!grid[cellId]) {
        grid[cellId] = { rawValue: '', computedValue: '', lastUpdated: Date.now(), lastUpdatedBy: senderId };
      }
      grid[cellId].rawValue = value;
      grid[cellId].lastUpdated = Date.now();
      grid[cellId].lastUpdatedBy = senderId;
      // Broadcast to all clients immediately
      broadcast({
        type: 'cell-update',
        cellId,
        rawValue: value,
        computedValue: value, // Temporary, will be updated after Lambda returns
        lastUpdatedBy: senderId,
        timestamp: Date.now()
      });
      // Sync to Lambda/DynamoDB in the background
      (async () => {
        // Convert cellId (e.g., '0-0') to cellRef (e.g., 'A1')
        const [row, col] = cellId.split('-').map(Number);
        const cellRef = String.fromCharCode(65 + col) + (row + 1);
        try {
          const lambdaResp = await lam_update_cell(GRID_FILE_ID, cellRef, value);
          const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
          if (body.changedCells && Array.isArray(body.changedCells)) {
            body.changedCells.forEach(cell => {
              const match = cell.cellCoordinate.match(/^([A-Z]+)(\d+)$/);
              if (match) {
                let col = 0;
                for (let i = 0; i < match[1].length; i++) {
                  col = col * 26 + (match[1].charCodeAt(i) - 65 + 1);
                }
                col -= 1;
                const row = parseInt(match[2], 10) - 1;
                const cellIdStr = `${row}-${col}`;
                // Update in-memory grid with computed value
                if (!grid[cellIdStr]) grid[cellIdStr] = {};
                grid[cellIdStr].rawValue = cell.rawValue;
                grid[cellIdStr].computedValue = cell.computedValue;
                grid[cellIdStr].lastUpdated = Date.now();
                grid[cellIdStr].lastUpdatedBy = senderId;
                // Broadcast the computed value
                broadcast({
                  type: 'cell-update',
                  cellId: cellIdStr,
                  rawValue: cell.rawValue,
                  computedValue: cell.computedValue,
                  lastUpdatedBy: senderId,
                  timestamp: Date.now()
                });
              }
            });
          }
        } catch (err) {
          console.error('Lambda update_cell error:', err);
        }
      })();
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

    case 'add-row':
    case 'delete-row':
    case 'add-col':
    case 'delete-col':
      // Not implemented in Lambda yet
      break;

    case 'init-grid': {
      try {
        const lambdaResp = await lam_get_grid_data(GRID_FILE_ID);
        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
        // Update in-memory grid with latest from Lambda
        const latestGrid = convertGridDataToRowCol(body.gridData);
        Object.keys(grid).forEach(key => delete grid[key]); // Clear old
        Object.assign(grid, latestGrid);
        ws.send(JSON.stringify({
          type: 'full-grid',
          grid: latestGrid,
          timestamp: Date.now()
        }));
      } catch (err) {
        console.error('Lambda get_grid_data error:', err);
      }
      break;
    }

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

// Converts { 'A1': {...}, 'B2': {...} } to { '0-0': {...}, '1-1': {...} }
function convertGridDataToRowCol(gridData) {
  const result = {};
  for (const cellRef in gridData) {
    const match = cellRef.match(/^([A-Z]+)(\d+)$/);
    if (match) {
      let col = 0;
      for (let i = 0; i < match[1].length; i++) {
        col = col * 26 + (match[1].charCodeAt(i) - 65 + 1);
      }
      col -= 1;
      const row = parseInt(match[2], 10) - 1;
      result[`${row}-${col}`] = gridData[cellRef];
    }
  }
  return result;
}