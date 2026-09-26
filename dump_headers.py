import re

with open('sync_powerbi_relational.py', 'r') as f:
    content = f.read()

replacement = """
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")},
                    "updated_at": now_iso
                },
                {
                    "path": "state/debug_headers",
                    "data": {"headers": header_row},
                    "updated_at": now_iso
                }
            ]
"""

content = content.replace("""
            granular_nodes = [
                {
                    "path": "state/occupancy",
                    "data": {"current": legacy_occupancy_rows, "previous": existing.get("previous")},
                    "updated_at": now_iso
                }
            ]""", replacement.strip())

with open('sync_powerbi_relational.py', 'w') as f:
    f.write(content)
print("Debug headers patch applied.")
