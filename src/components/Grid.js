import React, { useState, useEffect, useRef } from 'react';

const COLS = 26;
const ROWS = 100;
const colHeaders = Array.from({ length: COLS }, (_, i) =>
    String.fromCharCode(65 + i)
);

function Grid() {
    const [gridData, setGridData] = useState(
        Array.from({ length: ROWS }, () => Array(COLS).fill(''))
    );

    const [selectedCell, setSelectedCell] = useState({ row: 0, col: 0 });

    const cellRefs = useRef([]);

    const handleChange = (rowIdx, colIdx, value) => {
        const newData = [...gridData];
        newData[rowIdx][colIdx] = value;
        setGridData(newData);
    };

    // Focus the selected cell
    useEffect(() => {
        const { row, col } = selectedCell;
        const ref = cellRefs.current?.[`${row}-${col}`];
        if (ref) ref.focus();
    }, [selectedCell]);

    // Handle arrow key movement
    useEffect(() => {
        const handleKeyDown = (e) => {
            setSelectedCell((prev) => {
                let { row, col } = prev;
                if (e.key === 'ArrowDown') row = Math.min(ROWS - 1, row + 1);
                if (e.key === 'ArrowUp') row = Math.max(0, row - 1);
                if (e.key === 'ArrowRight') col = Math.min(COLS - 1, col + 1);
                if (e.key === 'ArrowLeft') col = Math.max(0, col - 1);
                return { row, col };
            });
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <table>
            <thead>
                <tr>
                    <th></th>
                    {colHeaders.map((letter, colIdx) => (
                        <th key={colIdx}>{letter}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {gridData.map((row, rowIdx) => (
                    <tr key={rowIdx}>
                        <td>{rowIdx + 1}</td>
                        {row.map((cell, colIdx) => {
                            const isSelected =
                                selectedCell.row === rowIdx && selectedCell.col === colIdx;
                            const cellKey = `${rowIdx}-${colIdx}`;
                            return (
                                <td key={colIdx}>
                                    <input
                                        ref={(el) => {
                                            if (!cellRefs.current) cellRefs.current = {};
                                            cellRefs.current[cellKey] = el;
                                        }}
                                        value={cell}
                                        onFocus={() =>
                                            setSelectedCell({ row: rowIdx, col: colIdx })
                                        }
                                        onChange={(e) =>
                                            handleChange(rowIdx, colIdx, e.target.value)
                                        }
                                        style={{
                                            backgroundColor: isSelected ? '#e3f2fd' : 'white',
                                        }}
                                    />
                                </td>
                            );
                        })}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export default Grid;
