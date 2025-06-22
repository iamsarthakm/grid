import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

# Setup logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# --- DynamoDB Setup ---

dynamodb = boto3.resource(
    "dynamodb",
    endpoint_url=os.getenv("DB_ENDPOINT"),
    region_name=os.getenv("AWS_REGION"),
    aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
)
table = dynamodb.Table("GridFileValues")


# --- Helper Functions ---


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
    logger.info(f"Received event: {json.dumps(event)}")
    try:
        op = event.get("operation")
        if op == "update_cell":
            return update_cell(event)
        elif op == "get_grid_data":
            return get_grid_data(event)
        else:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Invalid operation"}),
            }
    except Exception as e:
        logger.error(f"Handler error: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


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
    resp = table.query(KeyConditionExpression=Key("gridFileId").eq(gridFileId))
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
    with table.batch_writer() as batch:
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

    logger.info(f"Update complete. Changed cells: {json.dumps(changed_cells)}")
    return {
        "statusCode": 200,
        "body": json.dumps(
            {"gridFileId": gridFileId, "changedCells": changed_cells, "updatedAt": now}
        ),
    }


def get_grid_data(event):
    gridFileId = event.get("gridFileId")
    logger.info(f"Getting grid data for grid '{gridFileId}'")
    if not gridFileId:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing gridFileId"})}

    logger.info(f"DB HIT: Querying database for grid '{gridFileId}'")
    resp = table.query(KeyConditionExpression=Key("gridFileId").eq(gridFileId))
    items = resp.get("Items", [])
    logger.info(f"DB QUERY Complete: Found {len(items)} items for grid '{gridFileId}'")

    gridData = {}
    for item in items:
        gridData[item["cellCoordinate"]] = {
            "rawValue": item.get("rawValue", ""),
            "computedValue": item.get("value", ""),
        }

    logger.info(f"Returning {len(gridData)} cells for grid '{gridFileId}'")
    return {
        "statusCode": 200,
        "body": json.dumps({"gridFileId": gridFileId, "gridData": gridData}),
    }
