import os
import re
import json
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
import requests


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
    match = re.match(r'^([A-Z]+)(\d+)$', ref)
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
    return cell.get('value', '')


def get_range_values(grid, range_str):
    match = re.match(r'^([A-Z]+\d+):([A-Z]+\d+)$', range_str)
    if not match:
        return []
    start = cell_ref_to_index(match.group(1))
    end = cell_ref_to_index(match.group(2))
    if not start or not end:
        return []
    values = []
    for r in range(min(start[0], end[0]), max(start[0], end[0]) + 1):
        for c in range(min(start[1], end[1]), max(start[1], end[1]) + 1):
            values.append(get_cell_value(grid, r, c))
    return values


def eval_formula(formula, grid):
    def repl_fn(match):
        fn, arg = match.group(1), match.group(2)
        values = get_range_values(grid, arg.strip())
        if fn.upper() == 'SUM':
            return str(sum(float(v) if v not in (None, '', '#ERR') and str(v).replace('.', '', 1).isdigit() else 0 for v in values))
        elif fn.upper() == 'AVG':
            nums = [float(v) for v in values if v not in (None, '', '#ERR') and str(v).replace('.', '', 1).isdigit()]
            return str(sum(nums) / len(nums) if nums else 0)
        elif fn.upper() == 'COUNT':
            return str(len([v for v in values if v not in (None, '', '#ERR')]))
        return '0'

    formula = re.sub(r'(SUM|AVG|COUNT)\(([^)]+)\)', repl_fn, formula, flags=re.IGNORECASE)

    def cell_ref_repl(match):
        idx = cell_ref_to_index(match.group(1))
        if not idx:
            return '0'
        val = get_cell_value(grid, idx[0], idx[1])
        if isinstance(val, str) and val.startswith('='):
            try:
                return str(eval_formula(val[1:], grid))
            except Exception:
                return '0'
        try:
            return str(float(val))
        except Exception:
            return '0'

    expr = re.sub(r'([A-Z]+\d+)', cell_ref_repl, formula)
    if re.search(r'[^0-9+\-*/(). ]', expr):
        return '#ERR'
    try:
        return str(eval(expr))
    except Exception:
        return '#ERR'


def set_cell_value(grid, cell_ref, raw_value_input):
    idx = cell_ref_to_index(cell_ref)
    if not idx:
        return grid, '#ERR'
    row, col = idx
    cell_id = f"{row}-{col}"
    computed_value = raw_value_input
    if isinstance(raw_value_input, str) and raw_value_input.startswith('='):
        try:
            computed_value = eval_formula(raw_value_input[1:], grid)
        except Exception as e:
            print(f"Error evaluating formula {raw_value_input}: {e}")
            computed_value = '#ERR'
    grid[cell_id] = {
        'rawValue': raw_value_input,
        'value': computed_value
    }
    return grid, computed_value


def find_dependent_cells(grid, changed_cell_ref):
    dependents = []
    for cell_id, cell in grid.items():
        raw = cell.get('rawValue', '')
        if isinstance(raw, str) and raw.startswith('='):
            refs = set(re.findall(r'([A-Z]+\d+)', raw[1:]))
            if changed_cell_ref in refs:
                # Convert cell_id (e.g., '0-0') back to cell ref (e.g., 'A1')
                row, col = map(int, cell_id.split('-'))
                col_ref = ''
                n = col + 1
                while n > 0:
                    n, r = divmod(n - 1, 26)
                    col_ref = chr(65 + r) + col_ref
                ref = f"{col_ref}{row + 1}"
                dependents.append(ref)
    return dependents


# --- Lambda Handler ---

def handler(event, context):
    try:
        op = event.get("operation")
        if op == "update_cell":
            return update_cell(event)
        elif op == "get_grid_data":
            return get_grid_data(event)
        else:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Invalid operation"})
            }
    except Exception as e:
        print("Handler error:", e)
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }


def update_cell(event):
    gridFileId = event.get("gridFileId")
    cellCoordinate = event.get("cellCoordinate")
    rawValue = event.get("rawValue")
    if not gridFileId or not cellCoordinate or rawValue is None:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing required parameters"})
        }

    resp = table.query(
        KeyConditionExpression=Key("gridFileId").eq(gridFileId)
    )
    items = resp.get("Items", [])

    grid = {}
    cell_ref_map = {}  # Map cell_id (e.g. '0-0') to cell ref (e.g. 'A1')
    for item in items:
        idx = cell_ref_to_index(item["cellCoordinate"])
        if idx:
            cell_id = f"{idx[0]}-{idx[1]}"
            grid[cell_id] = {
                "rawValue": item.get("rawValue", ""),
                "value": item.get("value", "")
            }
            cell_ref_map[cell_id] = item["cellCoordinate"]

    # 1. Update the target cell
    grid, computed_value = set_cell_value(grid, cellCoordinate, rawValue)
    now = datetime.now(timezone.utc).isoformat()
    changed_cells = [
        {
            "cellCoordinate": cellCoordinate,
            "rawValue": rawValue,
            "computedValue": computed_value
        }
    ]

    # 2. Recalculate all dependent cells (recursively)
    to_recalc = set(find_dependent_cells(grid, cellCoordinate))
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
        raw = grid.get(cell_id, {}).get('rawValue', '')
        if raw == '':
            continue
        grid, new_val = set_cell_value(grid, ref, raw)
        changed_cells.append({
            "cellCoordinate": ref,
            "rawValue": raw,
            "computedValue": new_val
        })
        # Add further dependents
        to_recalc.update(find_dependent_cells(grid, ref))

    # Batch write all changed cells to DynamoDB
    with table.batch_writer() as batch:
        for cell in changed_cells:
            batch.put_item(
                Item={
                    "gridFileId": gridFileId,
                    "cellCoordinate": cell["cellCoordinate"],
                    "rawValue": cell["rawValue"],
                    "value": cell["computedValue"],
                    "updatedAt": now
                }
            )

    # 3. Async recalc Lambda (for demo, not implemented)
    try:
        lambda_endpoint = os.getenv("LAMBDA_ENDPOINT")
        if lambda_endpoint:
            recalc_url = lambda_endpoint.rstrip('/') + '/functions/GridRecalculatorLambda/invocations'
            print(f"Invoking async recalc Lambda via HTTP POST to {recalc_url}")
            payload = {
                "gridFileId": gridFileId,
                "updatedCellCoordinate": cellCoordinate
            }
            requests.post(recalc_url, json=payload)
        else:
            lambda_client = boto3.client("lambda")
            lambda_client.invoke(
                FunctionName="GridRecalculatorLambda",
                InvocationType="Event",
                Payload=json.dumps({
                    "gridFileId": gridFileId,
                    "updatedCellCoordinate": cellCoordinate
                }),
            )
    except Exception as e:
        print("Async recalc Lambda invocation failed:", e)

    return {
        "statusCode": 200,
        "body": json.dumps({
            "gridFileId": gridFileId,
            "changedCells": changed_cells,
            "updatedAt": now
        })
    }


def get_grid_data(event):
    gridFileId = event.get("gridFileId")
    if not gridFileId:
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Missing gridFileId"})
        }
    resp = table.query(
        KeyConditionExpression=Key("gridFileId").eq(gridFileId)
    )
    items = resp.get("Items", [])

    gridData = {}
    for item in items:
        gridData[item["cellCoordinate"]] = {
            "rawValue": item.get("rawValue", ""),
            "computedValue": item.get("value", "")
        }

    return {
        "statusCode": 200,
        "body": json.dumps({
            "gridFileId": gridFileId,
            "gridData": gridData
        })
    } 