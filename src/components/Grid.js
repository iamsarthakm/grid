import React, { useState } from 'react';

const COLS = 26;
const ROWS = 100;
const colHeaders = Array.from({ length: COLS }, (_, i) => String.fromCharCode(65 + i)); // A-Z

function Grid() {
    const [gridData, setGridData] = useState(
        Array.from({ length: ROWS }, () => Array(COLS).fill(''))
    );

    const handleChange = (rowIdx, colIdx, value) => {
        const newData = [...gridData];
        newData[rowIdx][colIdx] = value;
        console.log(gridData)
        setGridData(newData);
    };

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
                        {row.map((cell, colIdx) => (
                            <td key={colIdx}>
                                <input
                                    value={cell}
                                    onChange={(e) => handleChange(rowIdx, colIdx, e.target.value)}
                                />
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export default Grid;
