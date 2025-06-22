import time
from datetime import datetime

import boto3


def get_dynamodb_resource():
    """Helper function to get DynamoDB resource with correct endpoint"""
    try:
        # First try localhost (when running outside Docker)
        return boto3.resource(
            "dynamodb",
            endpoint_url="http://localhost:8000",
            region_name="local",
            aws_access_key_id="local",
            aws_secret_access_key="local",
        )
    except Exception:
        # Fall back to container name (when running inside Docker)
        return boto3.resource(
            "dynamodb",
            endpoint_url="http://dynamodb-local:8000",
            region_name="local",
            aws_access_key_id="local",
            aws_secret_access_key="local",
        )


def create_tables():
    dynamodb = get_dynamodb_resource()

    try:
        # Create GridFile table
        dynamodb.create_table(
            TableName="GridFile",
            KeySchema=[{"AttributeName": "id", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "id", "AttributeType": "S"}],
            ProvisionedThroughput={"ReadCapacityUnits": 5, "WriteCapacityUnits": 5},
        )
        print("Created GridFile table")
    except dynamodb.meta.client.exceptions.ResourceInUseException:
        print("GridFile table already exists")
    except Exception as e:
        print(f"Error creating GridFile: {e}")
        return False

    try:
        # Create GridFileValues table
        dynamodb.create_table(
            TableName="GridFileValues",
            KeySchema=[
                {"AttributeName": "gridFileId", "KeyType": "HASH"},
                {"AttributeName": "cellCoordinate", "KeyType": "RANGE"},
            ],
            AttributeDefinitions=[
                {"AttributeName": "gridFileId", "AttributeType": "S"},
                {"AttributeName": "cellCoordinate", "AttributeType": "S"},
            ],
            ProvisionedThroughput={"ReadCapacityUnits": 26000, "WriteCapacityUnits": 26000},
        )
        print("Created GridFileValues table")
        return True
    except dynamodb.meta.client.exceptions.ResourceInUseException:
        print("GridFileValues table already exists")
        return True
    except Exception as e:
        print(f"Error creating GridFileValues: {e}")
        return False


def seed_empty_grid():
    dynamodb = get_dynamodb_resource()

    try:
        grid_table = dynamodb.Table("GridFile")
        grid_values = dynamodb.Table("GridFileValues")

        grid_id = "empty_grid_001"
        current_time = datetime.now().isoformat()
        total_cols = 26
        total_rows = 100

        # Add grid attributes
        grid_table.put_item(
            Item={
                "id": grid_id,
                "createdAt": current_time,
                "updatedAt": current_time,
                "dimensions": {"totalRows": total_rows, "totalCols": total_cols},
            }
        )

        print(f"Seeding empty grid with {total_rows} rows and {total_cols} columns...")

        # Batch write in chunks to avoid timeouts
        batch_size = 25  # Max items per batch write
        items = []

        for row in range(1, total_rows + 1):
            for col in range(65, 65 + total_cols):
                col_letter = chr(col)
                items.append(
                    {
                        "gridFileId": grid_id,
                        "cellCoordinate": f"{col_letter}{row}",
                        "rowNo": row,
                        "colNo": col_letter,
                        "value": "",
                        "createdAt": current_time,
                        "updatedAt": current_time,
                    }
                )

                # Write in batches
                if len(items) >= batch_size:
                    with grid_values.batch_writer() as batch:
                        for item in items:
                            batch.put_item(Item=item)
                    items = []

        # Write any remaining items
        if items:
            with grid_values.batch_writer() as batch:
                for item in items:
                    batch.put_item(Item=item)

        print("Empty grid seeded successfully!")
        return True
    except Exception as e:
        print(f"Error seeding data: {e}")
        return False


if __name__ == "__main__":
    # Wait for DynamoDB to be ready
    time.sleep(5)

    if create_tables():
        # Wait for tables to be created
        time.sleep(5)
        seed_empty_grid()
