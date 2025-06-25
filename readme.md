# Collaborative Grid

This is a full-stack, real-time collaborative spreadsheet application, similar to a simplified Google Sheets. It's designed to be run locally using Docker and Docker Compose, making it easy to set up and experiment with.

---

## 🏗️ Architecture

The project is built with a microservices-oriented architecture, with each component running in its own Docker container:

-   **Frontend (`grid-fe`)**: A **React** application that provides the user interface for the grid. It communicates with the backend via WebSockets.
    -   *Runs on `http://localhost:3000`*

-   **Backend (`web-socket-server`)**: A **Node.js + WebSocket** server that manages client connections, broadcasts real-time updates, and acts as a gateway to the Lambda functions.
    -   *Runs on `ws://localhost:8080`*

-   **Logic Layer (`lambdas`)**: A **Python Lambda** function that handles all the business logic, including formula evaluation (`=SUM(A1:B5)`), data validation, and communication with the database.
    -   *Runs via `lambci/lambda` on `http://localhost:9001`*

-   **Database (`dynamoDB`)**: **DynamoDB Local** running in a container to persist all grid and cell data.
    -   *Runs on `http://localhost:8000`*
    -   *Admin interface available at `http://localhost:8001`*

---

## ✨ Features

- **Real-time, multi-user collaboration** with live cursors and user presence
- **Grid Interface**: 26 columns (A-Z), 100+ rows, keyboard navigation, responsive design
- **Cell Editing**: Double-click or Enter to edit, visual selection indicators
- **Formula Support**: `=SUM()`, `=AVERAGE()`, `=COUNT()`
- **Row/Column Operations**: Add and delete rows/columns dynamically
- **Sorting**: Sort by column (ascending/descending) and row (ascending/descending)
- **Conflict Resolution**: Cell locking prevents simultaneous edits
- **Grid Management**: Create new spreadsheets, select existing ones
- **Data Persistence**: All data stored in DynamoDB with real-time sync

## 🐛 Known Limitations

1. **No copy/paste**: Not implemented yet (core requirement)
2. **Limited formulas**: Only SUM, AVERAGE, COUNT implemented
3. **No cell formatting**: Basic text only
4. **No undo/redo**: No command history
5. **No data import/export**: Manual data entry only
6. **Single grid per session**: No multiple sheets support

---

## 🚀 How to Run Locally

### Prerequisites

-   [Docker](https://www.docker.com/get-started) and [Docker Compose](https://docs.docker.com/compose/install/)
-   [Python](https://www.python.org/downloads/) and `pip`

### Steps

1.  **Install Python Dependencies for Lambda:**
    The Lambda function has Python dependencies that need to be available in the `lambdas` directory.
    ```bash
    pip install requests==2.28.2 urllib3==1.26.15 -t ./lambdas
    ```

2.  **Start All Services:**
    This single command will build the Docker images, create the containers, and start all the services in the background.
    ```bash
    docker-compose up --build -d
    ```

3.  **Set Up the Database Table:**
    Run this script once to create the necessary `GridFileValues` table in the local DynamoDB instance.
    ```bash
    python dynamoDB/setup-dynamodb.py
    ```
    *You may need to wait a few seconds after `docker-compose up` for the database container to be ready.*

4.  **Open the App:**
    Navigate to **[http://localhost:3000](http://localhost:3000)** in your browser to start using the collaborative grid!

---

### Managing the Services

-   **View logs for all services:**
    ```bash
    docker-compose logs -f
    ```
-   **View logs for a specific service (e.g., the lambda):**
    ```bash
    docker-compose logs -f lambda-local
    ```
-   **Stop all services:**
    ```bash
    docker-compose down
    ```

