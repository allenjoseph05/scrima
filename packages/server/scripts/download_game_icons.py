"""
Download ONLY the essential game icons from valorant-api.com for template matching.

Downloads:
  - 29 agent display icons + killfeed portraits + ability icons
  - 18 weapon display icons + killfeed icons
  - 12+ map minimap images
  - Rank tier icons

Total: ~250 images, zero cost, zero auth needed.
Auto-updates: re-run when new agents/weapons/maps are added.
"""

import os
import json
import requests
from pathlib import Path

BASE_URL = "https://valorant-api.com/v1"
ASSETS_DIR = Path("data/assets")


def download(url, path):
    """Download image if not already cached."""
    if path.exists():
        return False
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 200 and len(r.content) > 100:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
            return True
    except Exception:
        pass
    return False


def download_agents():
    print("=== AGENTS ===")
    data = requests.get(f"{BASE_URL}/agents?isPlayableCharacter=true").json()["data"]

    agent_dir = ASSETS_DIR / "agents"
    count = 0
    agent_list = []

    for agent in data:
        name = agent["displayName"]
        slug = name.lower().replace("/", "-")
        d = agent_dir / slug
        role = agent.get("role", {}).get("displayName", "")

        # Essential icons only
        for key in ["displayIcon", "killfeedPortrait"]:
            url = agent.get(key)
            if url and download(url, d / f"{key}.png"):
                count += 1

        # Ability icons (unique per agent — used for agent identification)
        for ability in agent.get("abilities", []):
            icon = ability.get("displayIcon")
            slot = ability.get("slot", "unknown").lower()
            if icon and download(icon, d / f"ability_{slot}.png"):
                count += 1

        agent_list.append({
            "name": name, "slug": slug, "role": role,
            "uuid": agent["uuid"]
        })
        print(f"  {name} ({role})")

    # Save metadata
    with open(agent_dir / "agents.json", "w") as f:
        json.dump(agent_list, f, indent=2)

    print(f"  Downloaded: {count} images for {len(data)} agents\n")
    return data


def download_weapons():
    print("=== WEAPONS ===")
    data = requests.get(f"{BASE_URL}/weapons").json()["data"]

    weapon_dir = ASSETS_DIR / "weapons"
    count = 0
    weapon_list = []

    for weapon in data:
        name = weapon["displayName"]
        slug = name.lower().replace(" ", "-")
        d = weapon_dir / slug
        cost = weapon.get("shopData", {}).get("cost", 0) if weapon.get("shopData") else 0

        # Base icon + killfeed icon only (NO skins)
        for key in ["displayIcon", "killStreamIcon"]:
            url = weapon.get(key)
            if url and download(url, d / f"{key}.png"):
                count += 1

        weapon_list.append({
            "name": name, "slug": slug, "cost": cost,
            "uuid": weapon["uuid"],
            "category": weapon.get("shopData", {}).get("categoryText", "") if weapon.get("shopData") else ""
        })
        print(f"  {name} ({cost} credits)")

    with open(weapon_dir / "weapons.json", "w") as f:
        json.dump(weapon_list, f, indent=2)

    print(f"  Downloaded: {count} images for {len(data)} weapons\n")
    return data


def download_maps():
    print("=== MAPS ===")
    data = requests.get(f"{BASE_URL}/maps").json()["data"]

    map_dir = ASSETS_DIR / "maps"
    count = 0
    map_list = []

    for m in data:
        name = m["displayName"]
        slug = name.lower().replace(" ", "-")
        d = map_dir / slug

        # Minimap + splash only
        for key in ["displayIcon", "listViewIcon", "splash"]:
            url = m.get(key)
            if url and download(url, d / f"{key}.png"):
                count += 1

        # Save callout data (map position names)
        callouts = m.get("callouts")
        if callouts:
            d.mkdir(parents=True, exist_ok=True)
            with open(d / "callouts.json", "w") as f:
                json.dump(callouts, f, indent=2)

        map_list.append({
            "name": name, "slug": slug, "uuid": m["uuid"],
            "mapUrl": m.get("mapUrl", "")
        })
        print(f"  {name}")

    with open(map_dir / "maps.json", "w") as f:
        json.dump(map_list, f, indent=2)

    print(f"  Downloaded: {count} images for {len(data)} maps\n")
    return data


def main():
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    print("Downloading game icons from valorant-api.com (free, no auth)\n")

    agents = download_agents()
    weapons = download_weapons()
    maps = download_maps()

    total = sum(1 for _ in ASSETS_DIR.rglob("*.png"))
    print("=" * 50)
    print(f"DONE: {len(agents)} agents, {len(weapons)} weapons, {len(maps)} maps")
    print(f"Total images: {total}")
    print(f"Saved to: {ASSETS_DIR.absolute()}")
    print(f"\nTo update after new content: python scripts/download_game_icons.py")


if __name__ == "__main__":
    main()
