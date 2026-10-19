#!/usr/bin/env python3
"""Resolve this server's Enshrouded roles and configure password access in SSM.

Defaults to preview only. Requires the three roles enshroudedadmin,
enshroudedfriend, and enshroudedguest; enshroudedvisitor is optional.
Uses the operator's AWS CLI credentials. Never prints the bot token.
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request


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

    mapping = {}
    for tier in ("admin", "friend", "guest", "visitor"):
        name = "enshrouded" + tier
        matches = [role for role in roles if isinstance(role, dict) and role.get("name") == name]
        if not matches and tier == "visitor":
            continue
        if len(matches) != 1:
            raise RuntimeError("Create exactly one role named %s in the trusted server, then retry" % name)
        role = matches[0]
        role_id = role.get("id", "")
        if (not isinstance(role_id, str) or not re.fullmatch(r"[0-9]{17,20}", role_id)
                or role_id == args.guild_id or role.get("managed")):
            raise RuntimeError("Role %s must be an ordinary, assignable Discord role" % name)
        mapping[tier] = role_id
    if len(set(mapping.values())) != len(mapping):
        raise RuntimeError("Each authorization level must use a different role")

    value = json.dumps({"guildId": args.guild_id, "roles": mapping}, separators=(",", ":"))
    parameter = "/enshroudedproj/discord/password-access/" + args.guild_id
    print("Trusted password-access mapping (role IDs only):")
    print(json.dumps(json.loads(value), indent=2))
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
