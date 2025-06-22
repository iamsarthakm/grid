import React, { useState, useEffect, useRef, useCallback } from 'react';

// Constants
const COLS = 26;
const ROWS = 100;
const colHeaders = Array.from({ length: COLS }, (_, i) => String.fromCharCode(65 + i));
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

function Grid() {
    // State
    const [gridData, setGridData] = useState(
        Array.from({ length: ROWS }, () =>
            Array.from({ length: COLS }, () => ({ value: '' }))
        )
    );
    const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });
    const [editingCell, setEditingCell] = useState(null);
    const [ws, setWs] = useState(null);
    const [userId, setUserId] = useState(null);
    const [otherUsers, setOtherUsers] = useState({});
    const [userColors, setUserColors] = useState({});
    const [userName, setUserName] = useState('');
    const [showNameDialog, setShowNameDialog] = useState(true);
    const [lastUpdatedCells, setLastUpdatedCells] = useState({});

    // Refs
    const cellRefs = useRef({});
    const debounceTimers = useRef({});

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
        setGridData(prev => {
            const newGrid = [...prev];
            if (!newGrid[row]) newGrid[row] = [];
            if (!newGrid[row][col]) newGrid[row][col] = { rawValue: '', computedValue: '' };
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
            [msg.cellId]: Date.now()
        }));
        setTimeout(() => {
            setLastUpdatedCells(prev => {
                const newState = { ...prev };
                delete newState[msg.cellId];
                return newState;
            });
        }, 100);
    };

    const handleRowAdded = (msg) => {
        setGridData(prev => {
            const newRow = Array.from({ length: msg.colCount }, () => ({ value: '' }));
            return [...prev, newRow];
        });
    };

    const handleSetName = () => {
        if (ws?.readyState === 1 && userName.trim()) {
            ws.send(JSON.stringify({
                type: 'set-name',
                name: userName.trim()
            }));
            setShowNameDialog(false);
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

    // WebSocket connection
    useEffect(() => {
        const socket = new WebSocket('ws://localhost:8080');
        setWs(socket);

        socket.onopen = () => {
            // Request initial grid from server
            socket.send(JSON.stringify({ type: 'init-grid' }));
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
                        setGridData(prev => prev.map(row => [...row, { value: '' }]));
                        break;

                    case 'col-deleted':
                        setGridData(prev => prev.map(row => row.slice(0, -1)));
                        break;

                    case 'full-grid':
                        const keys = Object.keys(msg.grid);
                        if (keys.length === 0) {
                            setGridData(Array.from({ length: ROWS }, () =>
                                Array.from({ length: COLS }, () => ({ rawValue: '', computedValue: '' }))
                            ));
                        } else {
                            let maxRow = 0, maxCol = 0;
                            keys.forEach(cellId => {
                                const [r, c] = cellId.split('-').map(Number);
                                if (r > maxRow) maxRow = r;
                                if (c > maxCol) maxCol = c;
                            });
                            const newGrid = [];
                            for (let r = 0; r <= maxRow; r++) {
                                const row = [];
                                for (let c = 0; c <= maxCol; c++) {
                                    const cell = msg.grid[`${r}-${c}`];
                                    row.push(cell ? { rawValue: cell.rawValue, computedValue: cell.computedValue } : { rawValue: '', computedValue: '' });
                                }
                                newGrid.push(row);
                            }
                            setGridData(newGrid);
                        }
                        break;
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
                if (e.key === 'ArrowRight') col = Math.min((gridData[0]?.length || COLS) - 1, col + 1);
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

    return (
        <div style={{ position: 'relative', padding: '20px' }}>
            {showNameDialog && (
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
                        <button
                            onClick={handleSetName}
                            style={{
                                backgroundColor: '#4CAF50',
                                color: 'white',
                                border: 'none',
                                padding: '10px 15px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontSize: '16px'
                            }}
                        >
                            Join Spreadsheet
                        </button>
                    </div>
                </div>
            )}

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

            {/* <div style={{ marginBottom: '20px' }}>
                <button
                    onClick={handleAddRow}
                    style={buttonStyle}
                >
                    Add Row
                </button>
                <button
                    onClick={handleDeleteRow}
                    style={buttonStyle}
                    disabled={gridData.length <= 1}
                >
                    Delete Row
                </button>
                <button
                    onClick={handleAddCol}
                    style={buttonStyle}
                >
                    Add Column
                </button>
                <button
                    onClick={handleDeleteCol}
                    style={buttonStyle}
                    disabled={gridData[0]?.length <= 1}
                >
                    Delete Column
                </button>
            </div> */}

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