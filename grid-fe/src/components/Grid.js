import React, { useState, useEffect, useRef, useCallback } from 'react';

// Constants
const DEFAULT_COLS = 26;
const DEFAULT_ROWS = 100;
const USER_COLORS = [
    '#FF5252', '#FF4081', '#E040FB', '#7C4DFF', '#536DFE',
    '#448AFF', '#40C4FF', '#18FFFF', '#64FFDA', '#69F0AE',
    '#B2FF59', '#EEFF41', '#FFFF00', '#FFD740', '#FFAB40'
];

// Helper functions
const getCellId = (row, col) => `${row}-${col}`;

const getCellPosFromId = (cellId) => {
    const [row, col] = cellId.split('-').map(Number);
    return { row, col };
};

const isValidDate = (str) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
    const [year, month, day] = str.split('-').map(Number);
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;
    const date = new Date(year, month - 1, day);
    return (
        date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day
    );
};

const cellRefToIndex = (ref) => {
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    let col = 0;
    for (let i = 0; i < match[1].length; i++) {
        col = col * 26 + (match[1].charCodeAt(i) - 65 + 1);
    }
    col -= 1;
    const row = parseInt(match[2], 10) - 1;
    return { row, col };
};

const getRangeValues = (range, getCellValue) => {
    const match = range.match(/^([A-Z]+\d+):([A-Z]+\d+)$/);
    if (!match) return [];
    const start = cellRefToIndex(match[1]);
    const end = cellRefToIndex(match[2]);
    if (!start || !end) return [];
    const values = [];
    for (let r = Math.min(start.row, end.row); r <= Math.max(start.row, end.row); r++) {
        for (let c = Math.min(start.col, end.col); c <= Math.max(start.col, end.col); c++) {
            values.push(getCellValue(r, c));
        }
    }
    return values;
};

const evaluateFormula = (formula, getCellValue) => {
    formula = formula.replace(/(SUM|AVG|COUNT)\(([^)]+)\)/gi, (match, fn, arg) => {
        const values = getRangeValues(arg.trim(), getCellValue);
        if (fn.toUpperCase() === 'SUM') {
            return values.reduce((acc, v) => acc + (parseFloat(v) || 0), 0);
        } else if (fn.toUpperCase() === 'AVG') {
            const nums = values.map(v => parseFloat(v)).filter(v => !isNaN(v));
            return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
        } else if (fn.toUpperCase() === 'COUNT') {
            return values.filter(v => v !== undefined && v !== null && v !== '').length;
        }
        return 0;
    });

    let expr = formula.replace(/([A-Z]+\d+)/g, (ref) => {
        const idx = cellRefToIndex(ref);
        if (!idx) return '0';
        const val = getCellValue(idx.row, idx.col);
        if (typeof val === 'string' && val.startsWith('=')) {
            try {
                return evaluateFormula(val.slice(1), getCellValue);
            } catch {
                return '0';
            }
        }
        return val === undefined || val === null || val === '' ? '0' : isNaN(Number(val)) ? '0' : Number(val);
    });

    if (/[^0-9+\-*/(). ]/.test(expr)) return '#ERR';
    try {
        // eslint-disable-next-line no-eval
        return eval(expr);
    } catch {
        return '#ERR';
    }
};

// Helper function to generate column headers dynamically
const generateColHeaders = (numCols) => {
    return Array.from({ length: numCols }, (_, i) => {
        let colLetter = '';
        let colNum = i + 1;
        while (colNum > 0) {
            colNum--;
            colLetter = String.fromCharCode(65 + (colNum % 26)) + colLetter;
            colNum = Math.floor(colNum / 26);
        }
        return colLetter;
    });
};

function Grid() {
    // State
    const [gridData, setGridData] = useState(
        Array.from({ length: DEFAULT_ROWS }, () =>
            Array.from({ length: DEFAULT_COLS }, () => ({ rawValue: '', computedValue: '' }))
        )
    );
    const [gridDimensions, setGridDimensions] = useState({ totalRows: DEFAULT_ROWS, totalCols: DEFAULT_COLS });
    const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });
    const [editingCell, setEditingCell] = useState(null);
    const [ws, setWs] = useState(null);
    const [userId, setUserId] = useState(null);
    const [otherUsers, setOtherUsers] = useState({});
    const [userColors, setUserColors] = useState({});
    const [userName, setUserName] = useState('');
    const [showNameDialog, setShowNameDialog] = useState(true);
    const [lastUpdatedCells, setLastUpdatedCells] = useState({});

    // New state for grid selection
    const [grids, setGrids] = useState([]);
    const [selectedGridId, setSelectedGridId] = useState('');
    const [showGridDropdown, setShowGridDropdown] = useState(false);

    // Refs
    const cellRefs = useRef({});
    const debounceTimers = useRef({});

    // Generate column headers dynamically
    const colHeaders = generateColHeaders(gridDimensions.totalCols);

    // Helper functions
    const getCellValue = (row, col) => {
        if (row < 0 || row >= gridData.length || col < 0 || col >= (gridData[0]?.length || 0)) {
            return '';
        }
        return gridData[row][col]?.computedValue || '';
    };

    // Derived state
    const displayGrid = gridData.map((row, rowIdx) =>
        row.map((cell, colIdx) => {
            return { ...cell, display: cell.computedValue };
        })
    );

    const updateUserPresence = (users) => {
        const usersObj = {};
        const colors = {};

        users.forEach(user => {
            usersObj[user.userId] = {
                position: user.position,
                name: user.name,
                color: user.color
            };
            colors[user.userId] = user.color;
        });

        setOtherUsers(usersObj);
        setUserColors(colors);
    };

    const handleRemoteCellUpdate = (msg) => {
        const { row, col } = getCellPosFromId(msg.cellId);
        const cellKey = getCellId(row, col);

        // Don't update if this cell is currently being edited by the local user
        const isCurrentlyEditing = editingCell?.row === row && editingCell?.col === col;
        if (isCurrentlyEditing) {
            return;
        }

        setGridData(prev => {
            const newGrid = [...prev];
            // Ensure the grid has enough rows and columns
            while (newGrid.length <= row) {
                newGrid.push(Array.from({ length: gridDimensions.totalCols }, () => ({ rawValue: '', computedValue: '' })));
            }
            if (!newGrid[row]) {
                newGrid[row] = Array.from({ length: gridDimensions.totalCols }, () => ({ rawValue: '', computedValue: '' }));
            }
            while (newGrid[row].length <= col) {
                newGrid[row].push({ rawValue: '', computedValue: '' });
            }
            if (!newGrid[row][col]) {
                newGrid[row][col] = { rawValue: '', computedValue: '' };
            }
            newGrid[row][col] = {
                ...newGrid[row][col],
                rawValue: msg.rawValue,
                computedValue: msg.computedValue,
                lastUpdatedBy: msg.lastUpdatedBy
            };
            return newGrid;
        });
        setLastUpdatedCells(prev => ({
            ...prev,
            [cellKey]: Date.now()
        }));
        setTimeout(() => {
            setLastUpdatedCells(prev => {
                const newState = { ...prev };
                delete newState[cellKey];
                return newState;
            });
        }, 100);
    };

    const handleRowAdded = (msg) => {
        setGridData(prev => [...prev, Array.from({ length: gridDimensions.totalCols }, () => ({ rawValue: '', computedValue: '' }))]);
    };

    const handleGridDimensionsChanged = (msg) => {
        const { newDimensions } = msg;
        setGridDimensions(newDimensions);

        // Update grid data to match new dimensions
        setGridData(prev => {
            const newGrid = [...prev];

            // Adjust rows
            while (newGrid.length < newDimensions.totalRows) {
                newGrid.push(Array.from({ length: newDimensions.totalCols }, () => ({ rawValue: '', computedValue: '' })));
            }
            if (newGrid.length > newDimensions.totalRows) {
                newGrid.splice(newDimensions.totalRows);
            }

            // Adjust columns for each row
            newGrid.forEach((row, rowIdx) => {
                while (row.length < newDimensions.totalCols) {
                    row.push({ rawValue: '', computedValue: '' });
                }
                if (row.length > newDimensions.totalCols) {
                    row.splice(newDimensions.totalCols);
                }
            });

            return newGrid;
        });

        // Adjust selected cell if it's now out of bounds
        setSelectedCell(prev => ({
            row: Math.min(prev.row, newDimensions.totalRows - 1),
            col: Math.min(prev.col, newDimensions.totalCols - 1)
        }));
    };

    const handleSetName = () => {
        if (ws?.readyState === 1 && userName.trim()) {
            ws.send(JSON.stringify({
                type: 'set-name',
                name: userName.trim()
            }));
            // Request grid list immediately
            ws.send(JSON.stringify({ type: 'list-grids' }));
            setShowGridDropdown(true);
        }
    };

    const handleGridSelection = (gridId) => {
        setSelectedGridId(gridId);
        setShowNameDialog(false);
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'select-grid',
                gridId
            }));
        }
    };

    const handleCreateNewGrid = () => {
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'create-grid',
                name: ''
            }));
        }
    };

    const handleJoinSpreadsheet = () => {
        if (selectedGridId && selectedGridId !== 'create-new') {
            handleGridSelection(selectedGridId);
        }
    };

    // Debounced cell edit sender
    const debouncedCellEdit = useCallback((row, col, value) => {
        const cellKey = getCellId(row, col);
        if (debounceTimers.current[cellKey]) {
            clearTimeout(debounceTimers.current[cellKey]);
        }
        debounceTimers.current[cellKey] = setTimeout(() => {
            if (ws?.readyState === 1) {
                ws.send(JSON.stringify({
                    type: 'cell-edit',
                    cellId: cellKey,
                    value,
                    timestamp: Date.now()
                }));
            }
            delete debounceTimers.current[cellKey];
        }, 150);
    }, [ws]);

    // Replace handleCellEdit with debounced version
    const handleCellEdit = (row, col, value) => {
        // Update local state immediately for responsive UI
        setGridData(prev => {
            const newGrid = [...prev];
            if (!newGrid[row]) newGrid[row] = [];
            if (!newGrid[row][col]) newGrid[row][col] = { rawValue: '', computedValue: '' };
            newGrid[row][col] = {
                ...newGrid[row][col],
                rawValue: value
                // Don't update computedValue here - let server handle it
            };
            return newGrid;
        });

        // Send to server with debouncing
        debouncedCellEdit(row, col, value);
    };

    const handleAddRow = () => {
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: 'add-row' }));
        }
    };

    const handleDeleteRow = () => {
        if (ws?.readyState === 1 && gridData.length > 1) {
            ws.send(JSON.stringify({ type: 'delete-row' }));
        }
    };

    const handleAddCol = () => {
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({ type: 'add-col' }));
        }
    };

    const handleDeleteCol = () => {
        if (ws?.readyState === 1 && gridData[0]?.length > 1) {
            ws.send(JSON.stringify({ type: 'delete-col' }));
        }
    };

    const handleSortColumn = (columnIndex, direction = 'asc') => {
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'sort-column',
                columnIndex,
                direction
            }));
        }
    };

    const handleSortRow = (rowIndex, direction = 'asc') => {
        if (ws?.readyState === 1) {
            ws.send(JSON.stringify({
                type: 'sort-row',
                rowIndex,
                direction
            }));
        }
    };

    // WebSocket connection
    useEffect(() => {
        const socket = new WebSocket('ws://localhost:8080');
        setWs(socket);

        socket.onopen = () => {
            // Request grid list immediately when connected
            socket.send(JSON.stringify({ type: 'list-grids' }));
            setShowGridDropdown(true);
        };

        socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                switch (msg.type) {
                    case 'init':
                        setUserId(msg.userId);
                        setUserColors(prev => ({ ...prev, [msg.userId]: msg.color }));
                        break;

                    case 'user-list':
                        updateUserPresence(msg.users);
                        break;

                    case 'grid-list':
                        setGrids(msg.grids || []);
                        break;

                    case 'grid-created':
                        if (msg.grid && !msg.error) {
                            // Auto-select the newly created grid
                            handleGridSelection(msg.grid.id);
                        }
                        break;

                    case 'cell-update':
                        handleRemoteCellUpdate(msg);
                        break;

                    case 'user-position-update':
                        setOtherUsers(prev => ({
                            ...prev,
                            [msg.userId]: {
                                ...prev[msg.userId],
                                position: msg.position
                            }
                        }));
                        break;

                    case 'row-added':
                        handleRowAdded(msg);
                        break;

                    case 'row-deleted':
                        setGridData(prev => prev.slice(0, -1));
                        break;

                    case 'col-added':
                        setGridData(prev => prev.map(row => [...row, { rawValue: '', computedValue: '' }]));
                        break;

                    case 'col-deleted':
                        setGridData(prev => prev.map(row => row.slice(0, -1)));
                        break;

                    case 'full-grid':
                        if (msg.grid) {
                            // Get dimensions from the message or use defaults
                            const dimensions = msg.dimensions || { totalRows: DEFAULT_ROWS, totalCols: DEFAULT_COLS };
                            setGridDimensions(dimensions);

                            // Create grid with the correct dimensions from the server
                            const newGrid = Array.from({ length: dimensions.totalRows }, () =>
                                Array.from({ length: dimensions.totalCols }, () => ({ rawValue: '', computedValue: '' }))
                            );

                            // Fill in the actual data from sparse grid
                            Object.keys(msg.grid).forEach(cellId => {
                                const { row, col } = getCellPosFromId(cellId);
                                if (row >= 0 && row < dimensions.totalRows && col >= 0 && col < dimensions.totalCols) {
                                    newGrid[row][col] = {
                                        rawValue: msg.grid[cellId].rawValue || '',
                                        computedValue: msg.grid[cellId].computedValue || ''
                                    };
                                }
                            });

                            setGridData(newGrid);
                            console.log(`Loaded grid with dimensions: ${dimensions.totalRows}x${dimensions.totalCols} and ${Object.keys(msg.grid).length} populated cells`);
                        } else {
                            // If no grid data, still create empty full grid with default dimensions
                            const dimensions = msg.dimensions || { totalRows: DEFAULT_ROWS, totalCols: DEFAULT_COLS };
                            const emptyGrid = Array.from({ length: dimensions.totalRows }, () =>
                                Array.from({ length: dimensions.totalCols }, () => ({ rawValue: '', computedValue: '' }))
                            );
                            setGridData(emptyGrid);
                            setGridDimensions(dimensions);
                            console.log(`Created empty grid with dimensions: ${dimensions.totalRows}x${dimensions.totalCols}`);
                        }
                        break;

                    case 'grid-dimensions-changed':
                        handleGridDimensionsChanged(msg);
                        break;

                    case 'grid-dimension-error':
                    case 'grid-operation-error':
                        console.error('Grid operation error:', msg.error);
                        // You could add a toast notification here to show the error to the user
                        alert(`Grid operation failed: ${msg.error}`);
                        break;

                    default:
                        console.warn(`Unhandled message type: ${msg.type}`);
                }
            } catch (e) {
                console.error('Error processing message:', e);
            }
        };

        // Explicitly close the WebSocket on unmount or tab close
        const cleanup = () => {
            if (socket.readyState === 1) socket.close();
        };
        window.addEventListener('beforeunload', cleanup);

        return () => {
            cleanup();
            window.removeEventListener('beforeunload', cleanup);
        };
    }, []);

    // Focus selected cell
    useEffect(() => {
        const { row, col } = selectedCell;
        const ref = cellRefs.current[getCellId(row, col)];
        if (ref) ref.focus();
    }, [selectedCell]);

    // Keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;

            e.preventDefault();
            setSelectedCell(prev => {
                let { row, col } = prev;
                if (e.key === 'ArrowDown') row = Math.min(gridData.length - 1, row + 1);
                if (e.key === 'ArrowUp') row = Math.max(0, row - 1);
                if (e.key === 'ArrowRight') col = Math.min((gridData[0]?.length || DEFAULT_COLS) - 1, col + 1);
                if (e.key === 'ArrowLeft') col = Math.max(0, col - 1);
                return { row, col };
            });
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [gridData]);

    // Send position updates
    useEffect(() => {
        if (ws?.readyState === 1 && userId) {
            ws.send(JSON.stringify({
                type: 'user-cell-position-change',
                position: selectedCell,
                timestamp: Date.now()
            }));
        }
    }, [selectedCell, userId, ws]);

    const renderCell = (rowIdx, colIdx) => {
        const cellKey = getCellId(rowIdx, colIdx);
        const isSelected = selectedCell.row === rowIdx && selectedCell.col === colIdx;
        const isEditing = editingCell?.row === rowIdx && editingCell?.col === colIdx;
        const cell = gridData[rowIdx]?.[colIdx] || { rawValue: '', computedValue: '' };

        // Show rawValue when editing, computedValue when not editing
        const cellValue = isEditing ? cell.rawValue : cell.computedValue;

        const usersHere = Object.entries(otherUsers)
            .filter(([uid, user]) =>
                user.position?.row === rowIdx &&
                user.position?.col === colIdx &&
                uid !== userId
            );

        const wasRecentlyUpdated = lastUpdatedCells[cellKey];
        const updatedBy = wasRecentlyUpdated ?
            otherUsers[gridData[rowIdx]?.[colIdx]?.lastUpdatedBy]?.name : null;

        return (
            <td
                key={colIdx}
                style={{
                    position: 'relative',
                    backgroundColor: wasRecentlyUpdated ? '#fffde7' : undefined,
                    transition: wasRecentlyUpdated ? 'background-color 1s ease-out' : undefined
                }}
            >
                <input
                    ref={el => (cellRefs.current[cellKey] = el)}
                    value={cellValue}
                    onChange={(e) => handleCellEdit(rowIdx, colIdx, e.target.value)}
                    onFocus={() => {
                        setSelectedCell({ row: rowIdx, col: colIdx });
                        setEditingCell({ row: rowIdx, col: colIdx });
                    }}
                    onBlur={() => setEditingCell(null)}
                    style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        backgroundColor: isSelected ? '#e3f2fd' : 'white',
                        border: usersHere.length > 0 ? `2px solid ${userColors[usersHere[0][0]]}` : '1px solid #ddd',
                        padding: '8px',
                        fontSize: '14px'
                    }}
                />

                {usersHere.map(([uid, user], index) => (
                    <div
                        key={uid}
                        style={{
                            position: 'absolute',
                            top: 2,
                            right: 2 + index * 14,
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            backgroundColor: user.color,
                            border: '1px solid white',
                            zIndex: 2
                        }}
                        title={user.name}
                    />
                ))}

                {wasRecentlyUpdated && (
                    <div
                        style={{
                            position: 'absolute',
                            bottom: 0,
                            right: 0,
                            fontSize: 9,
                            color: '#666',
                            backgroundColor: 'rgba(255, 255, 255, 0.8)',
                            padding: '0 3px',
                            borderRadius: 3
                        }}
                    >
                        {updatedBy ? `Updated by ${updatedBy}` : 'Updated'}
                    </div>
                )}
            </td>
        );
    };

    // Render name dialog
    if (showNameDialog) {
        return (
            <div style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 1000
            }}>
                <div style={{
                    backgroundColor: 'white',
                    padding: '20px',
                    borderRadius: '8px',
                    width: '300px',
                    textAlign: 'center'
                }}>
                    <h3>Enter Your Name</h3>
                    <input
                        type="text"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder="Your name"
                        style={{
                            width: '100%',
                            padding: '8px',
                            margin: '10px 0',
                            fontSize: '16px',
                            boxSizing: 'border-box'
                        }}
                        onKeyPress={(e) => e.key === 'Enter' && handleSetName()}
                    />

                    <div style={{ marginTop: '10px' }}>
                        <h4 style={{ margin: '10px 0', fontSize: '14px' }}>Select a Spreadsheet:</h4>
                        <select
                            value={selectedGridId}
                            onChange={(e) => {
                                if (e.target.value === 'create-new') {
                                    handleCreateNewGrid();
                                } else if (e.target.value) {
                                    setSelectedGridId(e.target.value);
                                }
                            }}
                            style={{
                                width: '100%',
                                padding: '8px',
                                fontSize: '14px',
                                border: '1px solid #ddd',
                                borderRadius: '4px',
                                marginBottom: '10px'
                            }}
                        >
                            <option value="">Select a spreadsheet...</option>
                            <option value="create-new" style={{ fontWeight: 'bold' }}>
                                ➕ Create New Spreadsheet
                            </option>
                            {grids.map(grid => (
                                <option key={grid.id} value={grid.id}>
                                    📊 {grid.name} ({new Date(grid.createdAt).toLocaleDateString()})
                                </option>
                            ))}
                        </select>

                        <button
                            onClick={handleJoinSpreadsheet}
                            disabled={!selectedGridId || selectedGridId === 'create-new'}
                            style={{
                                backgroundColor: selectedGridId && selectedGridId !== 'create-new' ? '#4CAF50' : '#ccc',
                                color: 'white',
                                border: 'none',
                                padding: '10px 15px',
                                borderRadius: '4px',
                                cursor: selectedGridId && selectedGridId !== 'create-new' ? 'pointer' : 'not-allowed',
                                fontSize: '16px',
                                width: '100%'
                            }}
                        >
                            Join Spreadsheet
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div style={{ position: 'relative', padding: '20px' }}>
            <div style={{
                position: 'fixed',
                top: '10px',
                right: '10px',
                backgroundColor: 'white',
                padding: '10px',
                borderRadius: '8px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
                zIndex: 100,
                maxWidth: '200px'
            }}>
                <h4 style={{ margin: '0 0 10px 0' }}>Active Users</h4>
                {Object.entries(otherUsers).map(([uid, user]) => {
                    const isCurrentUser = uid === userId;
                    let displayName = user.name || `User ${uid.slice(0, 4)}`;
                    if (isCurrentUser && userName) {
                        displayName = userName;
                    }
                    return (
                        <div key={uid} style={{
                            display: 'flex',
                            alignItems: 'center',
                            margin: '5px 0',
                            fontWeight: isCurrentUser ? 'bold' : 'normal'
                        }}>
                            <div style={{
                                width: '12px',
                                height: '12px',
                                borderRadius: '50%',
                                backgroundColor: user.color,
                                marginRight: '8px'
                            }} />
                            <span style={{
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis'
                            }}>
                                {displayName}{isCurrentUser && ' (You)'}
                            </span>
                        </div>
                    );
                })}
            </div>

            <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ marginRight: '20px', fontSize: '14px', color: '#666' }}>
                    Grid Size: {gridDimensions.totalRows} × {gridDimensions.totalCols}
                </div>
                <button
                    onClick={handleAddRow}
                    style={buttonStyle}
                >
                    ➕ Add Row
                </button>
                <button
                    onClick={handleDeleteRow}
                    style={buttonStyle}
                    disabled={gridDimensions.totalRows <= 1}
                >
                    ➖ Delete Row
                </button>
                <button
                    onClick={handleAddCol}
                    style={buttonStyle}
                >
                    ➕ Add Column
                </button>
                <button
                    onClick={handleDeleteCol}
                    style={buttonStyle}
                    disabled={gridDimensions.totalCols <= 1}
                >
                    ➖ Delete Column
                </button>
                <div style={{ marginLeft: '20px', borderLeft: '1px solid #ddd', paddingLeft: '20px' }}>
                    <span style={{ fontSize: '14px', color: '#666', marginRight: '10px' }}>Sort:</span>
                    <div style={{ fontSize: '12px', color: '#999', marginBottom: '5px' }}>
                        Selected: {colHeaders[selectedCell.col]}{selectedCell.row + 1}
                    </div>
                    <button
                        onClick={() => handleSortColumn(selectedCell.col, 'asc')}
                        style={{ ...buttonStyle, backgroundColor: '#4CAF50' }}
                        title="Sort selected column ascending"
                    >
                        ↑ Sort Col
                    </button>
                    <button
                        onClick={() => handleSortColumn(selectedCell.col, 'desc')}
                        style={{ ...buttonStyle, backgroundColor: '#FF9800' }}
                        title="Sort selected column descending"
                    >
                        ↓ Sort Col
                    </button>
                    <button
                        onClick={() => handleSortRow(selectedCell.row, 'asc')}
                        style={{ ...buttonStyle, backgroundColor: '#2196F3' }}
                        title="Sort selected row ascending"
                    >
                        ← Sort Row
                    </button>
                    <button
                        onClick={() => handleSortRow(selectedCell.row, 'desc')}
                        style={{ ...buttonStyle, backgroundColor: '#9C27B0' }}
                        title="Sort selected row descending"
                    >
                        → Sort Row
                    </button>
                </div>
            </div>

            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 150px)' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                        <tr>
                            <th style={headerCellStyle}></th>
                            {colHeaders.map((letter, colIdx) => (
                                <th key={colIdx} style={headerCellStyle}>
                                    {letter}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {gridData.map((row, rowIdx) => (
                            <tr key={rowIdx}>
                                <td style={rowHeaderStyle}>{rowIdx + 1}</td>
                                {row.map((_, colIdx) => renderCell(rowIdx, colIdx))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// Style constants
const buttonStyle = {
    backgroundColor: '#2196F3',
    color: 'white',
    border: 'none',
    padding: '8px 12px',
    borderRadius: '4px',
    marginRight: '8px',
    cursor: 'pointer',
    fontSize: '14px'
};

const headerCellStyle = {
    backgroundColor: '#f5f5f5',
    padding: '8px',
    textAlign: 'center',
    fontWeight: 'bold',
    border: '1px solid #ddd',
    minWidth: '100px',
    position: 'sticky',
    top: 0
};

const rowHeaderStyle = {
    backgroundColor: '#f5f5f5',
    padding: '8px',
    textAlign: 'center',
    fontWeight: 'bold',
    border: '1px solid #ddd',
    position: 'sticky',
    left: 0
};

export default Grid;