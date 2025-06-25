const WebSocket = require('ws');
const { v4: uuid } = require('uuid');
const axios = require('axios');

const wss = new WebSocket.Server({ port: 8080 });

// Remove in-memory grid storage - data comes from Lambda/DynamoDB
const clients = {}; // { connectionId: { ws, userId, position, name, selectedGridId } }

console.log('WebSocket server running on ws://localhost:8080');

// Lambda-backed functions
// Lambda endpoint (local or deployed)
// const LAMBDA_ENDPOINT = 'http://lambda-local:9001/2015-03-31/functions/function/invocations';
const LAMBDA_ENDPOINT = 'http://localhost:9001/2015-03-31/functions/function/invocations';

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

// List all grids via Lambda
async function lam_list_grids() {
  const payload = {
    operation: 'list_grids'
  };
  try {
    console.log('Making request to Lambda:', LAMBDA_ENDPOINT, 'with payload:', payload);
    const response = await axios.post(LAMBDA_ENDPOINT, payload);
    console.log('Lambda response received:', response.status, response.data);
    return response.data;
  } catch (error) {
    console.error('Lambda list_grids error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
}

// Create a new grid via Lambda
async function lam_create_grid(name) {
  const payload = {
    operation: 'create_grid',
    name
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

// Add row via Lambda
async function lam_add_row(gridFileId) {
  const payload = {
    operation: 'add_row',
    gridFileId
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

// Delete row via Lambda
async function lam_delete_row(gridFileId) {
  const payload = {
    operation: 'delete_row',
    gridFileId
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

// Add column via Lambda
async function lam_add_column(gridFileId) {
  const payload = {
    operation: 'add_column',
    gridFileId
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
}

// Delete column via Lambda
async function lam_delete_column(gridFileId) {
  const payload = {
    operation: 'delete_column',
    gridFileId
  };
  const response = await axios.post(LAMBDA_ENDPOINT, payload);
  return response.data;
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
    color: userColor,
    selectedGridId: null
  };

  console.log(`[Connected] ${connectionId}`);

  // Send initialization data
  ws.send(JSON.stringify({
    type: 'init',
    userId: connectionId,
    color: userColor
  }));

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

    case 'init-grid': {
      console.log('Received init-grid request from:', senderId);
      // Since we removed the hardcoded grid, we need to handle this differently
      // For now, create a default grid or use the first available grid
      try {
        console.log('Calling Lambda list_grids...');
        const lambdaResp = await lam_list_grids();
        console.log('Lambda response:', lambdaResp);
        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
        const grids = body.grids || [];
        console.log('Found grids:', grids.length);

        if (grids.length > 0) {
          // Use the first available grid
          const firstGrid = grids[0];
          clients[senderId].selectedGridId = firstGrid.id;
          console.log('Using existing grid:', firstGrid.id);

          const gridDataResp = await lam_get_grid_data(firstGrid.id);
          const gridDataBody = gridDataResp.body ? JSON.parse(gridDataResp.body) : gridDataResp;
          const gridData = convertGridDataToRowCol(gridDataBody.gridData || {});
          const dimensions = gridDataBody.dimensions || { totalRows: 100, totalCols: 26 };

          ws.send(JSON.stringify({
            type: 'full-grid',
            grid: gridData,
            gridId: firstGrid.id,
            dimensions: dimensions,
            timestamp: Date.now()
          }));
        } else {
          // No grids exist, create a default one
          console.log('Creating default grid...');
          const createResp = await lam_create_grid('Default Grid');
          const createBody = createResp.body ? JSON.parse(createResp.body) : createResp;

          clients[senderId].selectedGridId = createBody.gridId;
          console.log('Created grid:', createBody.gridId);

          ws.send(JSON.stringify({
            type: 'full-grid',
            grid: {},
            gridId: createBody.gridId,
            dimensions: { totalRows: 100, totalCols: 26 },
            timestamp: Date.now()
          }));
        }
      } catch (err) {
        console.error('Lambda init_grid error:', err);

        // Try to create a grid even if listing fails
        try {
          console.log('Trying to create a grid as fallback...');
          const createResp = await lam_create_grid('Fallback Grid');
          const createBody = createResp.body ? JSON.parse(createResp.body) : createResp;

          clients[senderId].selectedGridId = createBody.gridId;
          console.log('Created fallback grid:', createBody.gridId);

          ws.send(JSON.stringify({
            type: 'full-grid',
            grid: {},
            gridId: createBody.gridId,
            dimensions: { totalRows: 100, totalCols: 26 },
            timestamp: Date.now()
          }));
        } catch (createErr) {
          console.error('Failed to create fallback grid:', createErr);
          // Only use a fake grid ID as last resort - this will cause issues
          const fallbackGridId = 'fallback-grid-' + Date.now();
          clients[senderId].selectedGridId = fallbackGridId;
          console.log('Using fake fallback grid:', fallbackGridId);

          ws.send(JSON.stringify({
            type: 'full-grid',
            grid: {},
            gridId: fallbackGridId,
            timestamp: Date.now()
          }));
        }
      }
      break;
    }

    case 'list-grids': {
      try {
        const lambdaResp = await lam_list_grids();
        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
        ws.send(JSON.stringify({
          type: 'grid-list',
          grids: body.grids || [],
          timestamp: Date.now()
        }));
      } catch (err) {
        console.error('Lambda list_grids error:', err);
        ws.send(JSON.stringify({
          type: 'grid-list',
          grids: [],
          error: 'Failed to load grids',
          timestamp: Date.now()
        }));
      }
      break;
    }

    case 'create-grid': {
      try {
        const lambdaResp = await lam_create_grid(message.name);
        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
        const newGrid = {
          id: body.gridId,
          name: body.name,
          createdAt: body.createdAt,
          dimensions: body.dimensions
        };

        // Send the new grid to the client
        ws.send(JSON.stringify({
          type: 'grid-created',
          grid: newGrid,
          timestamp: Date.now()
        }));

        // Also send updated grid list to all clients
        const listResp = await lam_list_grids();
        const listBody = listResp.body ? JSON.parse(listResp.body) : listResp;
        broadcast({
          type: 'grid-list',
          grids: listBody.grids || [],
          timestamp: Date.now()
        });
      } catch (err) {
        console.error('Lambda create_grid error:', err);
        ws.send(JSON.stringify({
          type: 'grid-created',
          error: 'Failed to create grid',
          timestamp: Date.now()
        }));
      }
      break;
    }

    case 'select-grid': {
      clients[senderId].selectedGridId = message.gridId;
      // Load grid data for the selected grid
      try {
        const lambdaResp = await lam_get_grid_data(message.gridId);
        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
        const gridData = convertGridDataToRowCol(body.gridData || {});
        const dimensions = body.dimensions || { totalRows: 100, totalCols: 26 };
        ws.send(JSON.stringify({
          type: 'full-grid',
          grid: gridData,
          gridId: message.gridId,
          dimensions: dimensions,
          timestamp: Date.now()
        }));
      } catch (err) {
        console.error('Lambda get_grid_data error:', err);
        ws.send(JSON.stringify({
          type: 'full-grid',
          grid: {},
          gridId: message.gridId,
          error: 'Failed to load grid data',
          timestamp: Date.now()
        }));
      }
      break;
    }

    case 'cell-edit': {
      const { cellId, value } = message;
      const selectedGridId = clients[senderId].selectedGridId;

      console.log('Cell edit from:', senderId, 'cellId:', cellId, 'value:', value, 'selectedGridId:', selectedGridId);

      if (!selectedGridId) {
        console.error('No grid selected for cell edit');
        return;
      }

      // Convert cellId (e.g., '0-0') to cellRef (e.g., 'A1')
      const [row, col] = cellId.split('-').map(Number);
      const cellRef = String.fromCharCode(65 + col) + (row + 1);
      console.log('Converted cellRef:', cellRef);

      // Broadcast to all clients immediately for real-time feel
      broadcast({
        type: 'cell-update',
        cellId,
        rawValue: value,
        computedValue: value, // Temporary, will be updated after Lambda returns
        lastUpdatedBy: senderId,
        timestamp: Date.now()
      });

      // Skip Lambda call if using a fake grid ID
      if (selectedGridId.startsWith('fallback-grid-')) {
        console.log('Skipping Lambda call for fake grid ID');
        return;
      }

      // Sync to Lambda/DynamoDB in the background
      (async () => {
        try {
          console.log('Calling Lambda update_cell for grid:', selectedGridId, 'cell:', cellRef);
          const lambdaResp = await lam_update_cell(selectedGridId, cellRef, value);
          console.log('Lambda update response:', lambdaResp);
          const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;
          if (body.changedCells && Array.isArray(body.changedCells)) {
            console.log('Changed cells:', body.changedCells);
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
    case 'delete-col': {
      const selectedGridId = clients[senderId].selectedGridId;

      if (!selectedGridId) {
        ws.send(JSON.stringify({
          type: 'grid-dimension-error',
          error: 'No grid selected',
          timestamp: Date.now()
        }));
        return;
      }

      // Skip Lambda call if using a fake grid ID
      if (selectedGridId.startsWith('fallback-grid-')) {
        ws.send(JSON.stringify({
          type: 'grid-dimension-error',
          error: 'Cannot modify fallback grid',
          timestamp: Date.now()
        }));
        return;
      }

      try {
        let lambdaResp;
        let operation;

        switch (message.type) {
          case 'add-row':
            lambdaResp = await lam_add_row(selectedGridId);
            operation = 'add_row';
            break;
          case 'delete-row':
            lambdaResp = await lam_delete_row(selectedGridId);
            operation = 'delete_row';
            break;
          case 'add-col':
            lambdaResp = await lam_add_column(selectedGridId);
            operation = 'add_column';
            break;
          case 'delete-col':
            lambdaResp = await lam_delete_column(selectedGridId);
            operation = 'delete_column';
            break;
        }

        const body = lambdaResp.body ? JSON.parse(lambdaResp.body) : lambdaResp;

        if (body.error) {
          ws.send(JSON.stringify({
            type: 'grid-dimension-error',
            error: body.error,
            timestamp: Date.now()
          }));
          return;
        }

        // Broadcast the dimension change to all clients
        broadcast({
          type: 'grid-dimensions-changed',
          gridId: selectedGridId,
          newDimensions: body.newDimensions,
          operation: operation,
          timestamp: Date.now()
        });

        console.log(`Grid dimensions updated: ${operation} for grid ${selectedGridId}`);
      } catch (err) {
        console.error(`Lambda ${message.type} error:`, err);
        ws.send(JSON.stringify({
          type: 'grid-dimension-error',
          error: `Failed to ${message.type.replace('-', ' ')}`,
          timestamp: Date.now()
        }));
      }
      break;
    }

    default:
      console.warn(`Unhandled message type: ${message.type}`, message);
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