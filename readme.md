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

-   Real-time, multi-user collaboration.
-   See other users' cursors and their live edits.
-   Basic formula support (`SUM`, `AVG`, `COUNT`) with dependency tracking.
-   Data is persisted in a DynamoDB database.
-   The entire stack is containerized for one-command setup.

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

