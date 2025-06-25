import time

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
            ProvisionedThroughput={
                "ReadCapacityUnits": 26000,
                "WriteCapacityUnits": 26000,
            },
        )
        print("Created GridFileValues table")
        return True
    except dynamodb.meta.client.exceptions.ResourceInUseException:
        print("GridFileValues table already exists")
        return True
    except Exception as e:
        print(f"Error creating GridFileValues: {e}")
        return False


if __name__ == "__main__":
    # Wait for DynamoDB to be ready
    time.sleep(5)
    create_tables()
