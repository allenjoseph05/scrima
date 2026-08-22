"""
Download ALL Valorant game assets from valorant-api.com

This API is free, requires no auth, and auto-updates when Riot adds new content.
Downloads agent icons, weapon icons/skins, map images — everything needed for
template matching and classification training.

This solves the "new agent/weapon/map" problem permanently.
"""

import os
import json
import time
import requests
from pathlib import Path

BASE_URL = "https://valorant-api.com/v1"
ASSETS_DIR = Path("data/assets")


def download_image(url, path):
    """Download an image if it doesn't already exist."""
    if path.exists():
        return False
    try:
        resp = requests.get(url, timeout=30)
        if resp.status_code == 200 and len(resp.content) > 100:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(resp.content)
            return True
    except Exception as e:
        print(f"    Failed: {e}")
    return False


def download_agents():
    """Download all agent assets."""
    print("\n=== AGENTS ===")
    resp = requests.get(f"{BASE_URL}/agents?isPlayableCharacter=true")
    agents = resp.json()["data"]

    agent_dir = ASSETS_DIR / "agents"
    total = 0
    agent_names = []

    for agent in agents:
        name = agent["displayName"]
        role = agent.get("role", {}).get("displayName", "Unknown")
        agent_names.append(name)
        slug = name.lower().replace("/", "-")
        adir = agent_dir / slug

        print(f"  {name} ({role})")

        # Download all icon variants
        for key in ["displayIcon", "displayIconSmall", "bustPortrait",
                     "fullPortrait", "fullPortraitV2", "killfeedPortrait",
                     "background"]:
            url = agent.get(key)
            if url:
                ext = ".png"
                if download_image(url, adir / f"{key}{ext}"):
                    total += 1

        # Download ability icons
        for i, ability in enumerate(agent.get("abilities", [])):
            icon_url = ability.get("displayIcon")
            if icon_url:
                aname = ability.get("slot", f"ability_{i}").lower()
                if download_image(icon_url, adir / f"ability_{aname}.png"):
                    total += 1

    print(f"\n  Total agents: {len(agents)}")
    print(f"  Images downloaded: {total}")
    print(f"  Agent names: {agent_names}")

    # Save agent list
    with open(agent_dir / "agents.json", "w") as f:
        json.dump({"agents": [{"name": a["displayName"],
                                "role": a.get("role", {}).get("displayName", ""),
                                "uuid": a["uuid"]}
                               for a in agents]}, f, indent=2)

    return len(agents)


def download_weapons():
    """Download all weapon assets including skin variants."""
    print("\n=== WEAPONS ===")
    resp = requests.get(f"{BASE_URL}/weapons")
    weapons = resp.json()["data"]

    weapon_dir = ASSETS_DIR / "weapons"
    total = 0
    skin_count = 0

    for weapon in weapons:
        name = weapon["displayName"]
        slug = name.lower().replace(" ", "-")
        wdir = weapon_dir / slug
        cost = weapon.get("shopData", {}).get("cost", "N/A") if weapon.get("shopData") else "free"

        print(f"  {name} (cost: {cost})")

        # Base weapon icon
        for key in ["displayIcon", "killStreamIcon"]:
            url = weapon.get(key)
            if url:
                if download_image(url, wdir / f"{key}.png"):
                    total += 1

        # Weapon skins — each skin is still labeled by parent weapon
        skins = weapon.get("skins", [])
        skin_dir = wdir / "skins"

        for i, skin in enumerate(skins):
            skin_name = skin.get("displayName", f"skin_{i}")
            # Skip default/standard skins to save space
            if "Standard" in skin_name or "Random" in skin_name:
                continue

            skin_icon = skin.get("displayIcon")
            if skin_icon:
                safe_name = skin_name.replace("/", "-").replace("\\", "-")[:50]
                if download_image(skin_icon, skin_dir / f"{safe_name}_icon.png"):
                    total += 1
                    skin_count += 1

            # Download first chroma's full render (highest quality)
            chromas = skin.get("chromas", [])
            if chromas:
                render_url = chromas[0].get("fullRender")
                if render_url:
                    safe_name = skin_name.replace("/", "-").replace("\\", "-")[:50]
                    if download_image(render_url, skin_dir / f"{safe_name}_render.png"):
                        total += 1
                        skin_count += 1

        # Rate limit to avoid overwhelming the API
        time.sleep(0.2)

    print(f"\n  Total weapons: {len(weapons)}")
    print(f"  Base icons + skin images: {total}")
    print(f"  Skin variants: {skin_count}")

    # Save weapon list
    with open(weapon_dir / "weapons.json", "w") as f:
        json.dump({"weapons": [{"name": w["displayName"],
                                 "uuid": w["uuid"],
                                 "category": w.get("shopData", {}).get("categoryText", "") if w.get("shopData") else ""}
                                for w in weapons]}, f, indent=2)

    return len(weapons)


def download_maps():
    """Download all map assets."""
    print("\n=== MAPS ===")
    resp = requests.get(f"{BASE_URL}/maps")
    maps = resp.json()["data"]

    map_dir = ASSETS_DIR / "maps"
    total = 0

    for m in maps:
        name = m["displayName"]
        slug = name.lower().replace(" ", "-")
        mdir = map_dir / slug

        print(f"  {name}")

        for key in ["splash", "displayIcon", "listViewIcon", "listViewIconTall",
                     "stylizedBackgroundImage", "premierBackgroundImage"]:
            url = m.get(key)
            if url:
                if download_image(url, mdir / f"{key}.png"):
                    total += 1

        # Download callout coordinates (useful for minimap parsing)
        callouts = m.get("callouts")
        if callouts:
            with open(mdir / "callouts.json", "w") as f:
                json.dump(callouts, f, indent=2)

    print(f"\n  Total maps: {len(maps)}")
    print(f"  Images downloaded: {total}")

    with open(map_dir / "maps.json", "w") as f:
        json.dump({"maps": [{"name": m["displayName"],
                              "uuid": m["uuid"],
                              "mapUrl": m.get("mapUrl", "")}
                             for m in maps]}, f, indent=2)

    return len(maps)


def download_competitive_tiers():
    """Download rank tier icons."""
    print("\n=== COMPETITIVE TIERS ===")
    resp = requests.get(f"{BASE_URL}/competitivetiers")
    tiers_data = resp.json()["data"]

    tier_dir = ASSETS_DIR / "ranks"
    total = 0

    # Get the latest tier table
    latest = tiers_data[-1]
    for tier in latest.get("tiers", []):
        name = tier.get("tierName", "Unknown")
        if name == "Unused":
            continue

        for key in ["smallIcon", "largeIcon", "rankTriangleDownIcon",
                     "rankTriangleUpIcon"]:
            url = tier.get(key)
            if url:
                safe = name.lower().replace(" ", "-")
                if download_image(url, tier_dir / f"{safe}_{key}.png"):
                    total += 1

    print(f"  Rank icons downloaded: {total}")


def main():
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 60)
    print("DOWNLOADING VALORANT ASSETS FROM valorant-api.com")
    print("=" * 60)

    n_agents = download_agents()
    n_weapons = download_weapons()
    n_maps = download_maps()
    download_competitive_tiers()

    # Summary
    print("\n" + "=" * 60)
    print("DOWNLOAD COMPLETE")
    print("=" * 60)
    print(f"  Agents: {n_agents}")
    print(f"  Weapons: {n_weapons}")
    print(f"  Maps: {n_maps}")

    # Count total images
    total_imgs = sum(1 for _ in ASSETS_DIR.rglob("*.png"))
    print(f"  Total images: {total_imgs}")
    print(f"\n  Saved to: {ASSETS_DIR.absolute()}")
    print(f"\n  To update after a new agent/weapon release:")
    print(f"    python scripts/download_valorant_assets.py")
    print(f"    (only downloads new/missing images)")


if __name__ == "__main__":
    main()
