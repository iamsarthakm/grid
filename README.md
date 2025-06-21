# Collaborative Spreadsheet (Grid)

Hey there! If you've ever wanted a Google Sheets-style app you can hack on, you're in the right place. This is a fun, live-editing spreadsheet you can run locally and play with friends or teammates.

---

## 🚦 Quick Start: Running Locally

1. **Clone this repo:**
   ```bash
   git clone [<repo-url>](https://github.com/iamsarthakm/grid.git)
   cd grid-fe
   ```
2. **Install everything:**
   ```bash
   npm install
   ```
3. **Start the backend (WebSocket server):**
   ```bash
   node server.js
   ```
4. **Start the frontend (React app):**
   ```bash
   npm start
   ```

- Open [http://localhost:3000](http://localhost:3000) in your browser.
- The backend runs on ws://localhost:8080

---

## 🏗️ How It's Built (Architecture in Plain English)

- **Frontend (React):**
  - Shows a big grid of cells (like Excel, but simpler)
  - Handles typing, clicking, and moving around
  - Lets you add/delete rows and columns
  - Shows who else is online and where their cursor is
  - Talks to the backend in real time

- **Backend (Node.js + WebSocket):**
  - Keeps track of all the cell values (the "source of truth")
  - Handles lots of users at once
  - Makes sure everyone sees the same thing
  - Resolves conflicts if two people edit the same cell (last one wins)

- **Sync:**
  - Every change you make is sent to the server and instantly shared with everyone else. It's like magic!

---

## Collaboration Features

- See other people's cursors and edits as they happen
- Instantly updates for everyone (no refresh needed)
- Each user gets a color and a name (pick your own!)
- If two people edit the same cell, the last change wins (simple and predictable)

---

## What Can You Do?

- Edit a 100x26 spreadsheet
- Type numbers, text, or formulas (try `=SUM(A1:A3)`!)
- See who's online and where they're editing
- Watch cells highlight when someone else changes them
- All changes are live and shared

---

## Why I Built It This Way

- **WebSocket:** For super-fast, real-time updates
- **Last-write-wins:** It's simple and avoids weird merge issues
- **Formulas on the client:** Keeps the server light and fast
- **Colors for users:** Makes it easy to see who's who

---

## What's Missing (for now)

- No login or authentication (anyone can join, so don't use for secrets!)
- Data isn't saved if you restart the server
- No import/export yet
- No fancy spreadsheet stuff (like charts or merged cells)
- Formulas only work in your browser (not checked by the server)

---

## What I'd Add Next

- User accounts and login
- Save data to a real database
- Import/export (CSV, Excel, etc.)
- Server-side formula checks
- More spreadsheet features (sorting, comments, etc.)
- Make it look great on mobile

---

## How to Test It (Collaboration Style)

- Open the app in two browser windows (or invite a friend!)
- Try editing the same cell at the same time
- Add and delete rows/columns
- Watch the user list and cell highlights
- Try typing formulas and see them update live
- If you want to get fancy, try disconnecting/reconnecting or simulating slow network (DevTools > Network > Slow 3G)

---
