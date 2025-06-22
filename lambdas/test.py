import json

import requests

# Ideally this call be done by web socket

payload = {
    "update_cell": True,
    "gridFileId": "empty_grid_001",
    "cellCoordinate": "A1",
    "value": "Updated Value",
}

# Invoke Lambda locally
response = requests.post(
    "http://localhost:9001/2015-03-31/functions/function/invocations", json=payload
)

print("Status Code:", response.status_code)
print("Response:", json.dumps(response.json(), indent=2))
