"""
Power BI Relational Synchronization Runner
Executes the live sync daemon targeting the updated Power BI report endpoint.
"""
import runpy

if __name__ == "__main__":
    runpy.run_path("sync_powerbi_relational.py", run_name="__main__")
