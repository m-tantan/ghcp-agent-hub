#!/usr/bin/env python3
"""
Test script to verify GHCP-Agent-Hub parser logic against real Copilot session data.
This validates that our Swift implementation handles real-world events correctly.
"""

import json
import os
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, Any, List

# Path to Copilot session data
COPILOT_PATH = Path.home() / ".copilot" / "session-state"

def parse_timestamp(ts: Optional[str]) -> Optional[datetime]:
    """Parse ISO8601 timestamp."""
    if not ts:
        return None
    try:
        # Handle with and without microseconds
        for fmt in ["%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ"]:
            try:
                return datetime.strptime(ts, fmt)
            except ValueError:
                continue
    except Exception:
        pass
    return None

def parse_events_file(filepath: Path) -> Dict[str, Any]:
    """Parse events.jsonl and extract monitoring data (mirrors Swift implementation)."""
    result = {
        "model": None,
        "message_count": 0,
        "tool_calls": {},
        "pending_tool_uses": {},
        "recent_activities": [],
        "session_started_at": None,
        "last_activity_at": None,
        "git_branch": None,
        "copilot_version": None,
        "cwd": None,
    }

    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")
            data = event.get("data", {})
            timestamp = parse_timestamp(event.get("timestamp"))

            # Track timestamps
            if timestamp:
                if result["session_started_at"] is None:
                    result["session_started_at"] = timestamp
                result["last_activity_at"] = timestamp

            # Process event types (mirrors Swift SessionEventsParser logic)
            if event_type == "session.start":
                context = data.get("context", {})
                result["git_branch"] = context.get("branch")
                result["cwd"] = context.get("cwd")
                result["copilot_version"] = data.get("copilotVersion")

            elif event_type == "user.message":
                result["message_count"] += 1
                content = data.get("content", "")
                if content:
                    result["recent_activities"].append({
                        "type": "user_message",
                        "description": content[:80],
                        "timestamp": timestamp
                    })

            elif event_type == "assistant.message":
                result["message_count"] += 1

                # Process tool requests
                tool_requests = data.get("toolRequests", [])
                for tool_req in tool_requests:
                    name = tool_req.get("name")
                    tool_call_id = tool_req.get("toolCallId")
                    if name and tool_call_id:
                        result["tool_calls"][name] = result["tool_calls"].get(name, 0) + 1
                        result["pending_tool_uses"][tool_call_id] = {
                            "tool_name": name,
                            "timestamp": timestamp
                        }
                        result["recent_activities"].append({
                            "type": "tool_use",
                            "name": name,
                            "timestamp": timestamp
                        })

                # Check for text content
                content = data.get("content", "")
                if content:
                    result["recent_activities"].append({
                        "type": "assistant_message",
                        "description": content[:50],
                        "timestamp": timestamp
                    })

            elif event_type == "tool.result":
                tool_call_id = data.get("toolCallId")
                if tool_call_id and tool_call_id in result["pending_tool_uses"]:
                    tool_name = result["pending_tool_uses"][tool_call_id]["tool_name"]
                    del result["pending_tool_uses"][tool_call_id]
                    is_error = data.get("isError", False)
                    result["recent_activities"].append({
                        "type": "tool_result",
                        "name": tool_name,
                        "success": not is_error,
                        "timestamp": timestamp
                    })

            elif event_type == "assistant.turn_start":
                result["recent_activities"].append({
                    "type": "thinking",
                    "timestamp": timestamp
                })

    # Keep only last 100 activities (mirrors Swift implementation)
    result["recent_activities"] = result["recent_activities"][-100:]

    return result

def read_workspace_yaml(filepath: Path) -> Dict[str, str]:
    """Read workspace.yaml metadata."""
    result = {}
    if not filepath.exists():
        return result

    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            if ':' in line:
                key, value = line.split(':', 1)
                result[key.strip()] = value.strip()

    return result

def main():
    print("=" * 60)
    print("GHCP-Agent-Hub Parser Verification")
    print("=" * 60)

    if not COPILOT_PATH.exists():
        print(f"❌ Copilot session path not found: {COPILOT_PATH}")
        return

    # Find all session directories
    sessions = [d for d in COPILOT_PATH.iterdir()
                if d.is_dir() and len(d.name) == 36 and '-' in d.name]

    print(f"\n📁 Found {len(sessions)} sessions in {COPILOT_PATH}\n")

    if not sessions:
        print("No sessions found to test.")
        return

    # Test parsing a few sessions
    for session_dir in sessions[:3]:
        session_id = session_dir.name
        events_file = session_dir / "events.jsonl"
        workspace_file = session_dir / "workspace.yaml"

        print(f"\n{'─' * 50}")
        print(f"Session: {session_id}")
        print(f"{'─' * 50}")

        # Parse workspace metadata
        if workspace_file.exists():
            meta = read_workspace_yaml(workspace_file)
            print(f"  Branch: {meta.get('branch', 'unknown')}")
            print(f"  CWD: {meta.get('cwd', 'unknown')[:50]}...")
            print(f"  Summary: {meta.get('summary', 'none')[:60]}...")

        # Parse events
        if events_file.exists():
            result = parse_events_file(events_file)
            print(f"  Messages: {result['message_count']}")
            print(f"  Tool Calls: {dict(result['tool_calls'])}")
            print(f"  Pending Tools: {len(result['pending_tool_uses'])}")
            print(f"  Activities: {len(result['recent_activities'])}")
            print(f"  Copilot Version: {result['copilot_version']}")

            # Show last few activities
            if result['recent_activities']:
                print("  Recent Activity Types:")
                for act in result['recent_activities'][-5:]:
                    act_type = act.get('type', 'unknown')
                    name = act.get('name', act.get('description', '')[:30])
                    print(f"    - {act_type}: {name}")
        else:
            print("  ⚠️  No events.jsonl file")

    print(f"\n{'=' * 60}")
    print("✅ Parser verification complete")
    print("=" * 60)

if __name__ == "__main__":
    main()
