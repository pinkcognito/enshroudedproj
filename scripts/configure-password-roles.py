#!/usr/bin/env python3
"""Resolve this server's Enshrouded roles and configure password access in SSM.

Defaults to preview only. Requires the three roles enshroudedadmin,
enshroudedfriend, and enshroudedguest; enshroudedvisitor is optional.
The action roles enshroudedstart, enshroudedstop, enshroudedupdate and enshroudedbackup are
all optional, and an absent one means that command is DENIED to everyone (ARCHITECTURE 7.5.2).
Action roles are fully independent of the password tiers: no role implies another.
Uses the operator's AWS CLI credentials. Never prints the bot token.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request


TIERS = ("admin", "friend", "guest", "visitor")
ACTIONS = ("start", "stop", "update", "backup")
SNOWFLAKE = re.compile(r"[0-9]{17,20}")


def find_role(roles, name, guild_id, required):
    """Return the role id for an exactly-named role, or None when optional and absent."""
    matches = [role for role in roles if isinstance(role, dict) and role.get("name") == name]
    if not matches and not required:
        return None
    if len(matches) != 1:
        raise RuntimeError("Create exactly one role named %s in the trusted server, then retry" % name
                           if required else "More than one role is named %s; keep exactly one, then retry" % name)
    role = matches[0]
    role_id = role.get("id", "")
    if (not isinstance(role_id, str) or not SNOWFLAKE.fullmatch(role_id)
            or role_id == guild_id or role.get("managed")):
        raise RuntimeError("Role %s must be an ordinary, assignable Discord role" % name)
    return role_id


def resolve_roles(roles, guild_id):
    """Resolve tier roles and (optional) action roles. Uniqueness applies to tiers only."""
    mapping = {}
    for tier in TIERS:
        role_id = find_role(roles, "enshrouded" + tier, guild_id, tier != "visitor")
        if role_id:
            mapping[tier] = role_id
    if len(set(mapping.values())) != len(mapping):
        raise RuntimeError("Each authorization level must use a different role")
    command_roles = {}
    for action in ACTIONS:
        role_id = find_role(roles, "enshrouded" + action, guild_id, False)
        if role_id:
            command_roles[action] = role_id
    return mapping, command_roles


def preview_lines(mapping, command_roles):
    """What the bot will actually do per command. Never blank: blank reads as "open to all"."""
    lines = []
    for action in ACTIONS:
        if action in command_roles:
            lines.append("%s: allowed only to holders of enshrouded%s (nothing else grants it, not even enshroudedadmin)"
                         % (action, action))
        else:
            lines.append("%s: DENIED to everyone (enshrouded%s not found)" % (action, action))
    tiers = [tier for tier in TIERS if tier in mapping]
    lines.append("pw: holders of any of: %s (each sees their own tier and below)" % ", ".join("enshrouded" + t for t in tiers))
    lines.append("channel: Discord Manage Server / Administrator permission (not role based)")
    lines.append("status, help: open to everyone")
    shared = sorted({"%s shares its role with tier %s" % (action, tier)
                     for action, action_id in command_roles.items() for tier, tier_id in mapping.items()
                     if action_id == tier_id})
    for note in shared:
        lines.append("note: " + note)
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--guild-id", required=True, help="Trusted Discord server ID")
    parser.add_argument("--region", default="us-east-2")
    parser.add_argument("--profile", help="Optional AWS CLI profile")
    parser.add_argument("--apply", action="store_true", help="Write the previewed role mapping to SSM")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]{17,20}", args.guild_id):
        parser.error("--guild-id must be a Discord server ID")

    aws = ["aws", "--region", args.region]
    if args.profile:
        aws.extend(["--profile", args.profile])

    def call_aws(arguments):
        result = subprocess.run(aws + arguments, capture_output=True, text=True, check=False)
        if result.returncode:
            raise RuntimeError("AWS CLI request failed; check your credentials and permissions")
        return result.stdout.strip()

    token = call_aws([
        "ssm", "get-parameter", "--name", "/enshroudedproj/discord/bot-token",
        "--with-decryption", "--query", "Parameter.Value", "--output", "text",
    ])
    if not token or token == "None":
        raise RuntimeError("Bot token is unavailable")
    request = urllib.request.Request(
        "https://discord.com/api/v10/guilds/" + args.guild_id + "/roles",
        headers={"Authorization": "Bot " + token,
                 "User-Agent": "DiscordBot (https://github.com/pinkcognito/enshroudedproj, 1.0)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            roles = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError("Discord role lookup failed (HTTP %s)" % error.code) from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError("Discord role lookup failed") from None
    if not isinstance(roles, list):
        raise RuntimeError("Discord returned an invalid role list")

    mapping, command_roles = resolve_roles(roles, args.guild_id)
    document = {"guildId": args.guild_id, "roles": mapping}
    if command_roles:
        document["commandRoles"] = command_roles
    value = json.dumps(document, separators=(",", ":"))
    parameter = "/enshroudedproj/discord/password-access/" + args.guild_id
    print("Trusted password-access mapping (role IDs only):")
    print(json.dumps(json.loads(value), indent=2))
    print()
    print("Effective authorization per command:")
    for line in preview_lines(mapping, command_roles):
        print("  " + line)
    print()
    if not args.apply:
        print("Preview only. Add --apply to write " + parameter)
        return
    call_aws([
        "ssm", "put-parameter", "--name", parameter, "--type", "String",
        "--tier", "Standard", "--value", value, "--overwrite", "--output", "json",
    ])
    print("Configured " + parameter)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        # Exception messages above are deliberately independent of request bodies,
        # response bodies, and credentials. OSError can include a file path only.
        print("error: " + (str(error) if isinstance(error, RuntimeError) else "Could not run the AWS CLI"), file=sys.stderr)
        sys.exit(1)
