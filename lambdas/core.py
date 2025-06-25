import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


# Custom JSON encoder to handle Decimal types
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)


# --- DynamoDB Setup ---

dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=os.getenv("DB_ENDPOINT"),
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)
grid_table = dynamodb.Table("GridFile")
values_table = dynamodb.Table("GridFileValues")


# --- Helper Functions ---


def generate_grid_name():
    """Generate a simple random grid name"""
    import random

    adjectives = [
        "Quick",
        "Smart",
        "Fast",
        "Bright",
        "Clear",
        "Fresh",
        "New",
        "Modern",
        "Simple",
        "Easy",
    ]
    nouns = [
        "Grid",
        "Sheet",
        "Table",
        "Data",
        "Work",
        "Project",
        "Task",
        "List",
        "Chart",
        "Report",
    ]
    adjective = random.choice(adjectives)
    noun = random.choice(nouns)
    number = random.randint(1, 999)
    return f"{adjective} {noun} {number}"


def cell_ref_to_index(ref):
    match = re.match(r"^([A-Z]+)(\d+)$", ref)
    if not match:
        return None
    col = 0
    for ch in match.group(1):
        col = col * 26 + (ord(ch) - 65 + 1)
    col -= 1
    row = int(match.group(2)) - 1
    return row, col


def get_cell_value(grid, row, col):
    cell_id = f"{row}-{col}"
    cell = grid.get(cell_id, {})
    return cell.get("value", "")


def get_range_values(grid, range_str):
    logger.info(f"Getting range values for: {range_str}")
    match = re.match(r"^([A-Z]+\d+):([A-Z]+\d+)$", range_str)
    if not match:
        logger.warning(f"Range string '{range_str}' did not match expected format.")
        return []
    start = cell_ref_to_index(match.group(1))
    end = cell_ref_to_index(match.group(2))
    if not start or not end:
        logger.warning(f"Could not convert range '{range_str}' to indices.")
        return []
    values = []
    for r in range(min(start[0], end[0]), max(start[0], end[0]) + 1):
        for c in range(min(start[1], end[1]), max(start[1], end[1]) + 1):
            values.append(get_cell_value(grid, r, c))
    logger.info(f"Values for range '{range_str}': {values}")
    return values


def eval_formula(formula, grid):
    logger.info(f"Evaluating formula: '{formula}'")

    def repl_fn(match):
        fn, arg = match.group(1), match.group(2)
        logger.info(f"Found function '{fn}' with argument '{arg}'")
        values = get_range_values(grid, arg.strip())

        if fn.upper() == "SUM":
            total = 0
            for v in values:
                try:
                    total += float(v)
                except (ValueError, TypeError):
                    continue
            logger.info(f"SUM of {values} is {total}")
            return str(total)

        elif fn.upper() == "AVG":
            nums = []
            for v in values:
                try:
                    nums.append(float(v))
                except (ValueError, TypeError):
                    continue
            avg = sum(nums) / len(nums) if nums else 0
            logger.info(f"AVG of {values} is {avg}")
            return str(avg)

        elif fn.upper() == "COUNT":
            count = len([v for v in values if v not in (None, "", "#ERR")])
            logger.info(f"COUNT of {values} is {count}")
            return str(count)

        return "0"

    # Replace aggregate functions like SUM, AVG, COUNT
    formula_after_fns = re.sub(
        r"(SUM|AVG|COUNT)\(([^)]+)\)", repl_fn, formula, flags=re.IGNORECASE
    )
    logger.info(f"Formula after function replacement: '{formula_after_fns}'")

    def cell_ref_repl(match):
        idx = cell_ref_to_index(match.group(1))
        if not idx:
            return "0"
        val = get_cell_value(grid, idx[0], idx[1])
        if isinstance(val, str) and val.startswith("="):
            try:
                # Recursively evaluate formula
                return str(eval_formula(val[1:], grid))
            except Exception:
                return "0"  # Return 0 if sub-formula has an error
        try:
            # Convert to float for calculations, then to string
            return str(float(val))
        except (ValueError, TypeError):
            return "0"  # Return 0 if value is not a number

    # Replace individual cell references
    expr = re.sub(r"([A-Z]+\d+)", cell_ref_repl, formula_after_fns)
    logger.info(f"Final expression to evaluate: '{expr}'")

    # Final evaluation
    if re.search(r"[^0-9+\-*/(). ]", expr):
        logger.warning(f"Expression '{expr}' contains invalid characters.")
        return "#ERR"
    try:
        result = str(eval(expr))
        logger.info(f"Evaluated '{expr}' to '{result}'")
        return result
    except Exception as e:
        logger.error(f"Failed to evaluate expression '{expr}': {e}")
        return "#ERR"


def set_cell_value(grid, cell_ref, raw_value_input):
    logger.info(f"Setting cell '{cell_ref}' to '{raw_value_input}'")
    idx = cell_ref_to_index(cell_ref)
    if not idx:
        return grid, "#ERR"
    row, col = idx
    cell_id = f"{row}-{col}"

    computed_value = raw_value_input
    if isinstance(raw_value_input, str) and raw_value_input.startswith("="):
        try:
            # Pass formula without the '='
            computed_value = eval_formula(raw_value_input[1:], grid)
        except Exception as e:
            logger.error(f"Error evaluating formula '{raw_value_input}': {e}")
            computed_value = "#ERR"

    grid[cell_id] = {"rawValue": raw_value_input, "value": computed_value}
    logger.info(
        f"Set cell '{cell_ref}' (id: {cell_id}) computed value to '{computed_value}'"
    )
    return grid, computed_value


def find_dependent_cells(grid, changed_cell_ref):
    logger.info(f"Finding cells dependent on '{changed_cell_ref}'")
    dependents = []

    # Convert the changed cell ref to an index tuple for easy comparison
    changed_idx = cell_ref_to_index(changed_cell_ref)
    if not changed_idx:
        return []

    for cell_id, cell in grid.items():
        raw = cell.get("rawValue", "")
        if not (isinstance(raw, str) and raw.startswith("=")):
            continue

        is_dependent = False

        # 1. Check for individual cell references (e.g., =A1+B1)
        # We need to extract cell refs but avoid function names
        formula_body = raw[1:]
        # Remove function calls to avoid capturing their names as cell refs
        formula_body_no_funcs = re.sub(r"[A-Z]+\([^)]*\)", "", formula_body)
        individual_refs = set(re.findall(r"([A-Z]+\d+)", formula_body_no_funcs))
        if changed_cell_ref in individual_refs:
            is_dependent = True

        # 2. Check for ranges inside functions (e.g., =SUM(A1:C10))
        if not is_dependent:
            # Find patterns like FUNC(A1:B5) or A1:B5
            range_matches = re.findall(r"([A-Z]+\d+):([A-Z]+\d+)", formula_body)
            for start_ref, end_ref in range_matches:
                start_idx = cell_ref_to_index(start_ref)
                end_idx = cell_ref_to_index(end_ref)
                if not start_idx or not end_idx:
                    continue

                # Check if changed_cell is within this range
                min_row, max_row = sorted((start_idx[0], end_idx[0]))
                min_col, max_col = sorted((start_idx[1], end_idx[1]))

                if (
                    min_row <= changed_idx[0] <= max_row
                    and min_col <= changed_idx[1] <= max_col
                ):
                    is_dependent = True
                    break  # Found dependency, no need to check other ranges

        if is_dependent:
            # This cell depends on the changed cell, so add it to the list
            row, col = map(int, cell_id.split("-"))
            col_ref = ""
            n = col + 1
            while n > 0:
                n, r = divmod(n - 1, 26)
                col_ref = chr(65 + r) + col_ref
            dependents.append(f"{col_ref}{row + 1}")

    logger.info(f"Found dependents: {dependents}")
    return list(set(dependents))


# --- Lambda Handler ---


def handler(event, context):
    logger.info(f"Received event: {json.dumps(event, cls=DecimalEncoder)}")
    try:
        op = event.get("operation")
        if op == "update_cell":
            return update_cell(event)
        elif op == "get_grid_data":
            return get_grid_data(event)
        elif op == "list_grids":
            return list_grids(event)
        elif op == "create_grid":
            return create_grid(event)
        elif op == "add_row":
            return add_row(event)
        elif op == "delete_row":
            return delete_row(event)
        elif op == "add_column":
            return add_column(event)
        elif op == "delete_column":
            return delete_column(event)
        elif op == "sort_column":
            return sort_column(event)
        elif op == "sort_row":
            return sort_row(event)
        else:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Invalid operation"}, cls=DecimalEncoder),
            }
    except Exception as e:
        logger.error(f"Handler error: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def list_grids(event):
    """List all available grids"""
    logger.info("Listing all grids")
    try:
        resp = grid_table.scan()
        grids = []
        for item in resp.get("Items", []):
            grids.append(
                {
                    "id": item["id"],
                    "name": item.get("name", "Unnamed Grid"),
                    "createdAt": item.get("createdAt"),
                    "updatedAt": item.get("updatedAt"),
                    "dimensions": item.get(
                        "dimensions", {"totalRows": 100, "totalCols": 26}
                    ),
                }
            )

        logger.info(f"Found {len(grids)} grids")
        return {
            "statusCode": 200,
            "body": json.dumps({"grids": grids}, cls=DecimalEncoder),
        }
    except Exception as e:
        logger.error(f"Error listing grids: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def create_grid(event):
    """Create a new grid"""
    logger.info("Creating new grid")
    try:
        grid_id = str(uuid.uuid4())
        grid_name = event.get("name") or generate_grid_name()
        current_time = datetime.now(timezone.utc).isoformat()

        # Create grid metadata
        grid_table.put_item(
            Item={
                "id": grid_id,
                "name": grid_name,
                "createdAt": current_time,
                "updatedAt": current_time,
                "dimensions": {"totalRows": 100, "totalCols": 26},
            }
        )

        logger.info(f"Created grid '{grid_name}' with ID '{grid_id}'")
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridId": grid_id,
                    "name": grid_name,
                    "createdAt": current_time,
                    "dimensions": {"totalRows": 100, "totalCols": 26},
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error creating grid: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def update_cell(event):
    gridFileId = event.get("gridFileId")
    cellCoordinate = event.get("cellCoordinate")
    rawValue = event.get("rawValue")
    logger.info(
        f"Updating cell '{cellCoordinate}' for grid '{gridFileId}' with value '{rawValue}'"
    )
    if not gridFileId or not cellCoordinate or rawValue is None:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing required parameters"}),
        }

    logger.info(f"DB HIT: Querying database for grid '{gridFileId}'")
    resp = values_table.query(KeyConditionExpression=Key("gridFileId").eq(gridFileId))
    items = resp.get("Items", [])
    logger.info(f"DB QUERY Complete: Found {len(items)} items for grid '{gridFileId}'")

    grid = {}
    cell_ref_map = {}  # Map cell_id (e.g. '0-0') to cell ref (e.g. 'A1')
    for item in items:
        idx = cell_ref_to_index(item["cellCoordinate"])
        if idx:
            cell_id = f"{idx[0]}-{idx[1]}"
            grid[cell_id] = {
                "rawValue": item.get("rawValue", ""),
                "value": item.get("value", ""),
            }
            cell_ref_map[cell_id] = item["cellCoordinate"]

    # 1. Update the target cell
    grid, computed_value = set_cell_value(grid, cellCoordinate, rawValue)
    now = datetime.now(timezone.utc).isoformat()
    changed_cells = [
        {
            "cellCoordinate": cellCoordinate,
            "rawValue": rawValue,
            "computedValue": computed_value,
        }
    ]

    # 2. Recalculate all dependent cells (recursively)
    to_recalc = set(find_dependent_cells(grid, cellCoordinate))
    logger.info(f"Found dependent cells to recalculate: {to_recalc}")
    seen = set()
    while to_recalc:
        ref = to_recalc.pop()
        if ref in seen:
            continue
        seen.add(ref)
        idx = cell_ref_to_index(ref)
        if not idx:
            continue
        cell_id = f"{idx[0]}-{idx[1]}"
        raw = grid.get(cell_id, {}).get("rawValue", "")
        if raw == "":
            continue
        logger.info(f"Recalculating dependent cell '{ref}'")
        grid, new_val = set_cell_value(grid, ref, raw)
        changed_cells.append(
            {"cellCoordinate": ref, "rawValue": raw, "computedValue": new_val}
        )
        # Add further dependents
        to_recalc.update(find_dependent_cells(grid, ref))

    # Batch write all changed cells to DynamoDB
    logger.info(f"DB HIT: Starting batch write for {len(changed_cells)} cells.")
    with values_table.batch_writer() as batch:
        for cell in changed_cells:
            logger.info(f"DB WRITE: Putting cell '{cell['cellCoordinate']}'")
            batch.put_item(
                Item={
                    "gridFileId": gridFileId,
                    "cellCoordinate": cell["cellCoordinate"],
                    "rawValue": cell["rawValue"],
                    "value": cell["computedValue"],
                    "updatedAt": now,
                }
            )
    logger.info("DB BATCH WRITE Complete.")

    logger.info(
        f"Update complete. Changed cells: {json.dumps(changed_cells, cls=DecimalEncoder)}"
    )
    return {
        "statusCode": 200,
        "body": json.dumps(
            {"gridFileId": gridFileId, "changedCells": changed_cells, "updatedAt": now},
            cls=DecimalEncoder,
        ),
    }


def get_grid_data(event):
    gridFileId = event.get("gridFileId")
    logger.info(f"Getting grid data for grid '{gridFileId}'")
    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"}, cls=DecimalEncoder),
        }

    try:
        # Get grid metadata to get current dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        # Convert Decimal to int for consistency
        current_dimensions = {
            "totalRows": int(current_dimensions["totalRows"]),
            "totalCols": int(current_dimensions["totalCols"]),
        }
        logger.info(f"Grid dimensions: {current_dimensions}")

    logger.info(f"DB HIT: Querying database for grid '{gridFileId}'")
        resp = values_table.query(
            KeyConditionExpression=Key("gridFileId").eq(gridFileId)
        )
    items = resp.get("Items", [])
        logger.info(
            f"DB QUERY Complete: Found {len(items)} items for grid '{gridFileId}'"
        )

    gridData = {}
    for item in items:
        gridData[item["cellCoordinate"]] = {
            "rawValue": item.get("rawValue", ""),
            "computedValue": item.get("value", ""),
        }

        logger.info(
            f"Returning {len(gridData)} cells for grid '{gridFileId}' with dimensions {current_dimensions}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "gridData": gridData,
                    "dimensions": current_dimensions,
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error getting grid data: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def add_row(event):
    """Add a row to the grid"""
    gridFileId = event.get("gridFileId")
    logger.info(f"Adding row to grid '{gridFileId}'")

    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"}, cls=DecimalEncoder),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        # Convert Decimal to int for calculations
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])
        new_rows = current_rows + 1
        new_cols = current_cols

        # Update grid dimensions
        grid_table.update_item(
            Key={"id": gridFileId},
            UpdateExpression="SET dimensions.totalRows = :rows, updatedAt = :now",
            ExpressionAttributeValues={
                ":rows": new_rows,
                ":now": datetime.now(timezone.utc).isoformat(),
            },
        )

        logger.info(
            f"Added row to grid '{gridFileId}'. New dimensions: {new_rows}x{new_cols}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "newDimensions": {"totalRows": new_rows, "totalCols": new_cols},
                    "operation": "add_row",
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error adding row: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def delete_row(event):
    """Delete the last row from the grid"""
    gridFileId = event.get("gridFileId")
    logger.info(f"Deleting row from grid '{gridFileId}'")

    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"}, cls=DecimalEncoder),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        # Convert Decimal to int for calculations
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])

        # Prevent deletion if only 1 row remains
        if current_rows <= 1:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"error": "Cannot delete row. Minimum 1 row required."},
                    cls=DecimalEncoder,
                ),
            }

        new_rows = current_rows - 1
        new_cols = current_cols

        # Update grid dimensions
        grid_table.update_item(
            Key={"id": gridFileId},
            UpdateExpression="SET dimensions.totalRows = :rows, updatedAt = :now",
            ExpressionAttributeValues={
                ":rows": new_rows,
                ":now": datetime.now(timezone.utc).isoformat(),
            },
        )

        # Delete cells in the last row only
        last_row = current_rows
        for col in range(1, new_cols + 1):
            col_letter = ""
            temp_col = col
            while temp_col > 0:
                temp_col, remainder = divmod(temp_col - 1, 26)
                col_letter = chr(65 + remainder) + col_letter

            cell_coordinate = f"{col_letter}{last_row}"
            try:
                values_table.delete_item(
                    Key={"gridFileId": gridFileId, "cellCoordinate": cell_coordinate}
                )
                logger.info(f"Deleted cell {cell_coordinate}")
            except Exception as e:
                logger.warning(f"Could not delete cell {cell_coordinate}: {e}")

        logger.info(
            f"Deleted row from grid '{gridFileId}'. New dimensions: {new_rows}x{new_cols}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "newDimensions": {"totalRows": new_rows, "totalCols": new_cols},
                    "operation": "delete_row",
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error deleting row: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def add_column(event):
    """Add a column to the grid"""
    gridFileId = event.get("gridFileId")
    logger.info(f"Adding column to grid '{gridFileId}'")

    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"}, cls=DecimalEncoder),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        # Convert Decimal to int for calculations
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])
        new_rows = current_rows
        new_cols = current_cols + 1

        # Update grid dimensions
        grid_table.update_item(
            Key={"id": gridFileId},
            UpdateExpression="SET dimensions.totalCols = :cols, updatedAt = :now",
            ExpressionAttributeValues={
                ":cols": new_cols,
                ":now": datetime.now(timezone.utc).isoformat(),
            },
        )

        logger.info(
            f"Added column to grid '{gridFileId}'. New dimensions: {new_rows}x{new_cols}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "newDimensions": {"totalRows": new_rows, "totalCols": new_cols},
                    "operation": "add_column",
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error adding column: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def delete_column(event):
    """Delete the last column from the grid"""
    gridFileId = event.get("gridFileId")
    logger.info(f"Deleting column from grid '{gridFileId}'")

    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"}, cls=DecimalEncoder),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        # Convert Decimal to int for calculations
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])

        # Prevent deletion if only 1 column remains
        if current_cols <= 1:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"error": "Cannot delete column. Minimum 1 column required."},
                    cls=DecimalEncoder,
                ),
            }

        new_rows = current_rows
        new_cols = current_cols - 1

        # Update grid dimensions
        grid_table.update_item(
            Key={"id": gridFileId},
            UpdateExpression="SET dimensions.totalCols = :cols, updatedAt = :now",
            ExpressionAttributeValues={
                ":cols": new_cols,
                ":now": datetime.now(timezone.utc).isoformat(),
            },
        )

        # Delete cells in the last column only
        last_col = current_cols
        col_letter = ""
        temp_col = last_col
        while temp_col > 0:
            temp_col, remainder = divmod(temp_col - 1, 26)
            col_letter = chr(65 + remainder) + col_letter

        for row in range(1, new_rows + 1):
            cell_coordinate = f"{col_letter}{row}"
            try:
                values_table.delete_item(
                    Key={"gridFileId": gridFileId, "cellCoordinate": cell_coordinate}
                )
                logger.info(f"Deleted cell {cell_coordinate}")
            except Exception as e:
                logger.warning(f"Could not delete cell {cell_coordinate}: {e}")

        logger.info(
            f"Deleted column from grid '{gridFileId}'. New dimensions: {new_rows}x{new_cols}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "newDimensions": {"totalRows": new_rows, "totalCols": new_cols},
                    "operation": "delete_column",
                },
                cls=DecimalEncoder,
            ),
        }
    except Exception as e:
        logger.error(f"Error deleting column: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def sort_column(event):
    """Sort data by column (ascending or descending)"""
    gridFileId = event.get("gridFileId")
    column_index = event.get("columnIndex")  # 0-based index
    sort_direction = event.get("direction", "asc")  # "asc" or "desc"

    logger.info(
        f"Sorting column {column_index} in {sort_direction} direction for grid '{gridFileId}'"
    )

    if not gridFileId or column_index is None:
        return {
            "statusCode": 400,
            "body": json.dumps(
                {"error": "Missing gridFileId or columnIndex"}, cls=DecimalEncoder
            ),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])

        # Validate column index
        if column_index < 0 or column_index >= current_cols:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"error": f"Invalid column index: {column_index}"},
                    cls=DecimalEncoder,
                ),
            }

        # Get all grid data
        resp = values_table.query(
            KeyConditionExpression=Key("gridFileId").eq(gridFileId)
        )
        items = resp.get("Items", [])

        # Convert column index to letter (e.g., 0 -> A, 1 -> B, 26 -> AA)
        col_letter = ""
        temp_col = column_index + 1
        while temp_col > 0:
            temp_col, remainder = divmod(temp_col - 1, 26)
            col_letter = chr(65 + remainder) + col_letter

        logger.info(f"Sorting column {col_letter} (index {column_index})")

        # Extract column data with row numbers
        column_data = []
        for item in items:
            cell_coord = item["cellCoordinate"]
            if cell_coord.startswith(col_letter):
                try:
                    row_num = int(cell_coord[len(col_letter) :])
                    column_data.append(
                        {
                            "row": row_num,
                            "cellCoordinate": cell_coord,
                            "rawValue": item.get("rawValue", ""),
                            "computedValue": item.get("value", ""),
                        }
                    )
                except ValueError:
                    continue

        # Sort the column data
        if sort_direction == "asc":
            column_data.sort(
                key=lambda x: (x["computedValue"] == "", x["computedValue"])
            )
        else:  # desc
            column_data.sort(
                key=lambda x: (x["computedValue"] == "", x["computedValue"]),
                reverse=True,
            )

        # Create mapping of old row -> new row
        row_mapping = {}
        for i, data in enumerate(column_data):
            old_row = data["row"]
            new_row = i + 1
            row_mapping[old_row] = new_row

        # Get all cells that need to be moved
        all_cells = {}
        for item in items:
            cell_coord = item["cellCoordinate"]
            match = re.match(r"^([A-Z]+)(\d+)$", cell_coord)
            if match:
                col_ref = match.group(1)
                row_num = int(match.group(2))
                if row_num in row_mapping:
                    all_cells[cell_coord] = {
                        "colRef": col_ref,
                        "oldRow": row_num,
                        "newRow": row_mapping[row_num],
                        "rawValue": item.get("rawValue", ""),
                        "computedValue": item.get("value", ""),
                    }

        # Delete all existing cells
        for cell_coord in all_cells.keys():
            try:
                values_table.delete_item(
                    Key={"gridFileId": gridFileId, "cellCoordinate": cell_coord}
                )
            except Exception as e:
                logger.warning(f"Could not delete cell {cell_coord}: {e}")

        # Insert cells in new positions
        new_cells = []
        for cell_coord, cell_data in all_cells.items():
            new_cell_coord = f"{cell_data['colRef']}{cell_data['newRow']}"

            # Skip empty cells (don't store them in database)
            if cell_data["rawValue"].strip() or cell_data["computedValue"].strip():
                new_cells.append(
                    {
                        "gridFileId": gridFileId,
                        "cellCoordinate": new_cell_coord,
                        "rawValue": cell_data["rawValue"],
                        "value": cell_data["computedValue"],
                    }
                )

        # Batch write new cells
        if new_cells:
            with values_table.batch_writer() as batch:
                for cell in new_cells:
                    batch.put_item(Item=cell)

        logger.info(f"Sorted column {col_letter}. Moved {len(new_cells)} cells.")

        return {
            "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "columnIndex": column_index,
                    "columnLetter": col_letter,
                    "direction": sort_direction,
                    "movedCells": len(new_cells),
                    "operation": "sort_column",
                },
                cls=DecimalEncoder,
            ),
        }

    except Exception as e:
        logger.error(f"Error sorting column: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
        }


def sort_row(event):
    """Sort data by row (ascending or descending)"""
    gridFileId = event.get("gridFileId")
    row_index = event.get("rowIndex")  # 0-based index
    sort_direction = event.get("direction", "asc")  # "asc" or "desc"

    logger.info(
        f"Sorting row {row_index} in {sort_direction} direction for grid '{gridFileId}'"
    )

    if not gridFileId or row_index is None:
        return {
            "statusCode": 400,
            "body": json.dumps(
                {"error": "Missing gridFileId or rowIndex"}, cls=DecimalEncoder
            ),
        }

    try:
        # Get current grid dimensions
        grid_resp = grid_table.get_item(Key={"id": gridFileId})
        if "Item" not in grid_resp:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Grid not found"}, cls=DecimalEncoder),
            }

        current_dimensions = grid_resp["Item"].get(
            "dimensions", {"totalRows": 100, "totalCols": 26}
        )
        current_rows = int(current_dimensions["totalRows"])
        current_cols = int(current_dimensions["totalCols"])

        # Validate row index
        if row_index < 0 or row_index >= current_rows:
            return {
                "statusCode": 400,
                "body": json.dumps(
                    {"error": f"Invalid row index: {row_index}"}, cls=DecimalEncoder
                ),
            }

        # Get all grid data
        resp = values_table.query(
            KeyConditionExpression=Key("gridFileId").eq(gridFileId)
        )
        items = resp.get("Items", [])

        target_row = row_index + 1  # Convert to 1-based row number

        logger.info(f"Sorting row {target_row} (index {row_index})")

        # Extract row data with column letters
        row_data = []
        for item in items:
            cell_coord = item["cellCoordinate"]
            match = re.match(r"^([A-Z]+)(\d+)$", cell_coord)
            if match:
                col_ref = match.group(1)
                row_num = int(match.group(2))
                if row_num == target_row:
                    # Convert column letter to index for sorting
                    col_index = 0
                    for char in col_ref:
                        col_index = col_index * 26 + (ord(char) - ord("A") + 1)
                    col_index -= 1

                    row_data.append(
                        {
                            "colIndex": col_index,
                            "colRef": col_ref,
                            "cellCoordinate": cell_coord,
                            "rawValue": item.get("rawValue", ""),
                            "computedValue": item.get("value", ""),
                        }
                    )

        # Sort the row data
        if sort_direction == "asc":
            row_data.sort(key=lambda x: (x["computedValue"] == "", x["computedValue"]))
        else:  # desc
            row_data.sort(
                key=lambda x: (x["computedValue"] == "", x["computedValue"]),
                reverse=True,
            )

        # Create mapping of old column -> new column
        col_mapping = {}
        for i, data in enumerate(row_data):
            old_col_index = data["colIndex"]
            new_col_index = i
            col_mapping[old_col_index] = new_col_index

        # Convert new column indices back to letters
        new_col_letters = {}
        for old_col_index, new_col_index in col_mapping.items():
            new_col_letter = ""
            temp_col = new_col_index + 1
            while temp_col > 0:
                temp_col, remainder = divmod(temp_col - 1, 26)
                new_col_letter = chr(65 + remainder) + new_col_letter
            new_col_letters[old_col_index] = new_col_letter

        # Get all cells that need to be moved (only in the target row)
        cells_to_move = {}
        for item in items:
            cell_coord = item["cellCoordinate"]
            match = re.match(r"^([A-Z]+)(\d+)$", cell_coord)
            if match:
                col_ref = match.group(1)
                row_num = int(match.group(2))
                if row_num == target_row:
                    # Convert column letter to index
                    col_index = 0
                    for char in col_ref:
                        col_index = col_index * 26 + (ord(char) - ord("A") + 1)
                    col_index -= 1

                    if col_index in col_mapping:
                        cells_to_move[cell_coord] = {
                            "oldColIndex": col_index,
                            "newColIndex": col_mapping[col_index],
                            "newColRef": new_col_letters[col_index],
                            "rawValue": item.get("rawValue", ""),
                            "computedValue": item.get("value", ""),
                        }

        # Delete all existing cells in the target row
        for cell_coord in cells_to_move.keys():
            try:
                values_table.delete_item(
                    Key={"gridFileId": gridFileId, "cellCoordinate": cell_coord}
                )
            except Exception as e:
                logger.warning(f"Could not delete cell {cell_coord}: {e}")

        # Insert cells in new positions
        new_cells = []
        for cell_coord, cell_data in cells_to_move.items():
            new_cell_coord = f"{cell_data['newColRef']}{target_row}"

            # Skip empty cells (don't store them in database)
            if cell_data["rawValue"].strip() or cell_data["computedValue"].strip():
                new_cells.append(
                    {
                        "gridFileId": gridFileId,
                        "cellCoordinate": new_cell_coord,
                        "rawValue": cell_data["rawValue"],
                        "value": cell_data["computedValue"],
                    }
                )

        # Batch write new cells
        if new_cells:
            with values_table.batch_writer() as batch:
                for cell in new_cells:
                    batch.put_item(Item=cell)

        logger.info(f"Sorted row {target_row}. Moved {len(new_cells)} cells.")

    return {
        "statusCode": 200,
            "body": json.dumps(
                {
                    "gridFileId": gridFileId,
                    "rowIndex": row_index,
                    "rowNumber": target_row,
                    "direction": sort_direction,
                    "movedCells": len(new_cells),
                    "operation": "sort_row",
                },
                cls=DecimalEncoder,
            ),
        }

    except Exception as e:
        logger.error(f"Error sorting row: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)}, cls=DecimalEncoder),
    }
