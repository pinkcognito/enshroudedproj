#!/usr/bin/env python3
"""Prepare WP25's deliberately worst-case password shape; preview by default.

Preview needs only Python and prints tier lengths, never passwords. Apply needs
AWS CLI v2 (including configure export-credentials) and normal AWS credentials:
  python scripts/prepare-password-shape-test.py --apply --instance-id i-02718657e8fed78b0
An optional --profile selects an AWS shared-config profile.

Apply overwrites ONLY the four existing fixed password parameter paths, using
SecureString and the default SSM key. Passwords stay in Python memory: no secret
argv, temporary files, plaintext output, persistent hashes, or rollback.
Writes are not atomic; reconcile all four after any failure before starting.
No instance start/stop, config rendering, rotation enablement, or DM is performed.
After preparation an operator must still render/boot, join all four tiers, and
prove a truncated admin prefix fails (ARCHITECTURE 7.4.6). This is NOT a WP25 pass.
"""

import argparse
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.request


ACCOUNT = "334953720182"
REGION = "us-east-2"
INSTANCE_ID = "i-02718657e8fed78b0"
ROTATION_SWITCH = "/enshroudedproj/state/rotate-on-start"
FRESHNESS_BOUND_SECONDS = 5.0
WORD_COUNTS = {"admin": 4, "friend": 3, "guest": 3, "visitor": 3}
PASSWORD_PARAMS = {
    "admin": "/enshroudedproj/server/user-groups/admin-password",
    "friend": "/enshroudedproj/server/user-groups/friend-password",
    "guest": "/enshroudedproj/server/user-groups/guest-password",
    "visitor": "/enshroudedproj/server/user-groups/visitor-password",
}
WORDLIST = (Path(__file__).resolve().parents[1] / "infrastructure/lib/enshrouded"
            / "lambda/discord-bot/eff-large-wordlist.js")


class PreparationError(Exception):
    """Only fixed, nonsecret operator-facing messages belong here."""


class ParameterNotFound(Exception):
    pass


class Aws:
    """CLI reads/credential resolution; stdlib SigV4 writes without secret argv."""

    class exceptions:
        ParameterNotFound = ParameterNotFound

    region_name = REGION

    def __init__(self, profile=None):
        self.command = ["aws", "--region", REGION, "--no-cli-pager"]
        if profile:
            self.command += ["--profile", profile]
        self.credentials = None

    def call(self, arguments):
        environment = dict(os.environ, AWS_CLI_AUTO_PROMPT="off")
        result = subprocess.run(self.command + arguments, capture_output=True,
                                text=True, check=False, timeout=30, env=environment)
        if result.returncode:
            if arguments[:2] == ["ssm", "get-parameter"] and "(ParameterNotFound)" in result.stderr:
                raise ParameterNotFound from None
            raise PreparationError("AWS CLI read/credential request failed; details suppressed.")
        return json.loads(result.stdout)

    def client(self, service, **kwargs):
        return self

    def get_caller_identity(self):
        return self.call(["sts", "get-caller-identity", "--output", "json"])

    def describe_instances(self, InstanceIds):
        return self.call(["ec2", "describe-instances", "--instance-ids", *InstanceIds,
                          "--output", "json"])

    def get_parameter(self, Name, WithDecryption=False):
        if WithDecryption:
            raise PreparationError("Secret parameter reads are not supported.")
        return self.call(["ssm", "get-parameter", "--name", Name,
                          "--no-with-decryption", "--output", "json"])

    def export_credentials(self):
        self.credentials = self.call(["configure", "export-credentials", "--format", "process"])
        if not all(self.credentials.get(key) for key in ("AccessKeyId", "SecretAccessKey")):
            raise PreparationError("AWS CLI did not export usable credentials.")

    def describe_parameters(self, ParameterFilters):
        return self.call(["ssm", "describe-parameters", "--parameter-filters",
                          json.dumps(ParameterFilters), "--output", "json"])

    def put_parameter(self, **parameter):
        # This method is intentionally restricted even if called independently.
        if (parameter.get("Name") not in PASSWORD_PARAMS.values()
                or parameter.get("Type") != "SecureString"):
            raise PreparationError("Refusing a write outside the fixed password parameters.")
        body = json.dumps(parameter, separators=(",", ":")).encode("utf-8")
        date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        day = date[:8]
        host = "ssm.us-east-2.amazonaws.com"
        headers = {"content-type": "application/x-amz-json-1.1", "host": host,
                   "x-amz-date": date, "x-amz-target": "AmazonSSM.PutParameter"}
        credentials = self.credentials
        if credentials.get("SessionToken"):
            headers["x-amz-security-token"] = credentials["SessionToken"]
        signed_headers = ";".join(sorted(headers))
        canonical_headers = "".join(f"{key}:{headers[key]}\n" for key in sorted(headers))
        canonical = "\n".join(["POST", "/", "", canonical_headers, signed_headers,
                               hashlib.sha256(body).hexdigest()])
        scope = f"{day}/{REGION}/ssm/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", date, scope,
                             hashlib.sha256(canonical.encode()).hexdigest()])
        key = ("AWS4" + credentials["SecretAccessKey"]).encode()
        for part in (day, REGION, "ssm", "aws4_request"):
            key = hmac.new(key, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={credentials['AccessKeyId']}/{scope}, "
                                    f"SignedHeaders={signed_headers}, Signature={signature}")
        request = urllib.request.Request(f"https://{host}/", data=body, headers=headers, method="POST")
        # No redirect handler: a redirect must never forward credentials/passwords.
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(request, timeout=15) as response:
            response.read()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_nine_letter_words(path=WORDLIST):
    """Parse the literal array strictly, without evaluating JavaScript or copying it."""
    source = path.read_text(encoding="utf-8")
    # Only the existing leading // attribution/comments and exact literal export
    # syntax are accepted. Any executable expression or unexpected entry fails.
    literal = re.sub(r"(?m)^\s*//[^\n]*\n?", "", source).strip()
    match = re.fullmatch(r"module\.exports = Object\.freeze\(\[\s*(.*?)\s*\]\);", literal, re.S)
    if not match:
        raise PreparationError("Vendored wordlist export format is unexpected.")
    entries = match.group(1).splitlines()
    words = []
    for entry in entries:
        word = re.fullmatch(r"\s*'([a-z]+)',\s*", entry)
        if not word:
            raise PreparationError("Vendored wordlist entry format is unexpected.")
        words.append(word.group(1))
    if len(words) != len(set(words)) or not words or max(map(len, words)) != 9:
        raise PreparationError("Vendored wordlist uniqueness/maximum length changed.")
    candidates = tuple(word for word in words if len(word) == 9)
    if len(candidates) < 4:
        raise PreparationError("Not enough nine-letter words in the vendored list.")
    return candidates


def prepare_passwords(words):
    return {tier: "-".join(secrets.choice(words) for _ in range(count))
            for tier, count in WORD_COUNTS.items()}


def check_stopped_and_rotation_off(ec2, ssm):
    """Read switch first, then state; return EC2 call-start monotonic time."""
    try:
        parameter = ssm.get_parameter(Name=ROTATION_SWITCH, WithDecryption=False)["Parameter"]
    except ssm.exceptions.ParameterNotFound:
        pass
    else:
        # The switch is nonsecret; don't accidentally accept/read a SecureString as one.
        if parameter.get("Type") != "String":
            raise PreparationError("Rotation switch must be a nonsecret String or absent.")
        if parameter.get("Value") == "true":
            raise PreparationError("Rotation is enabled; refusing to overwrite test passwords.")
    # Include request/response transit and CLI overhead in the observation's age.
    # No further remote reads follow this state observation before a write.
    observed_at = time.monotonic()
    response = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
    instances = [instance for reservation in response.get("Reservations", [])
                 for instance in reservation.get("Instances", [])]
    if len(instances) != 1 or instances[0].get("InstanceId") != INSTANCE_ID:
        raise PreparationError("Expected exactly the pinned Enshrouded instance.")
    instance = instances[0]
    tags = {tag.get("Key"): tag.get("Value") for tag in instance.get("Tags", [])}
    if tags.get("project") != "enshroudedproj":
        raise PreparationError("Pinned instance lacks project=enshroudedproj.")
    if instance.get("State", {}).get("Name") != "stopped":
        raise PreparationError("Pinned instance must be fully stopped.")
    return observed_at


def apply_passwords(session, passwords):
    if session.region_name != REGION:
        raise PreparationError("AWS session must use us-east-2.")
    sts = session.client("sts", region_name=REGION)
    if sts.get_caller_identity().get("Account") != ACCOUNT:
        raise PreparationError("AWS account does not match the pinned account.")
    ec2 = session.client("ec2", region_name=REGION)
    ssm = session.client("ssm", region_name=REGION)
    check_stopped_and_rotation_off(ec2, ssm)
    # Metadata only: don't decrypt/read existing passwords or create new, untagged
    # parameters if seeding has not already populated the four intended paths.
    for parameter in PASSWORD_PARAMS.values():
        metadata = ssm.describe_parameters(ParameterFilters=[
            {"Key": "Name", "Option": "Equals", "Values": [parameter]}]).get("Parameters", [])
        if (len(metadata) != 1 or metadata[0].get("Name") != parameter
                or metadata[0].get("Type") != "SecureString"):
            raise PreparationError("All four password parameters must already exist as SecureString.")
    session.export_credentials()
    for tier, parameter in PASSWORD_PARAMS.items():
        # Fail closed on unreadable state/switch. Recheck immediately before every
        # write; this is an operator preflight, not an atomic lock against starts.
        observed_at = check_stopped_and_rotation_off(ec2, ssm)
        if time.monotonic() - observed_at > FRESHNESS_BOUND_SECONDS:
            raise PreparationError("Stopped-state observation exceeded five seconds; refusing further writes.")
        ssm.put_parameter(Name=parameter, Value=passwords[tier], Type="SecureString",
                          Tier="Standard", Overwrite=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--instance-id", choices=[INSTANCE_ID], help="Required with --apply")
    parser.add_argument("--region", choices=[REGION], default=REGION)
    parser.add_argument("--profile", help="Optional AWS shared-config profile")
    args = parser.parse_args(argv)
    if args.apply and args.instance_id != INSTANCE_ID:
        parser.error("--apply requires --instance-id " + INSTANCE_ID)
    try:
        passwords = prepare_passwords(load_nine_letter_words())
        for tier in WORD_COUNTS:
            print(f"{tier}: {len(passwords[tier])} characters")
        if args.apply:
            apply_passwords(Aws(args.profile), passwords)
            print("Prepared four SecureString parameters; WP25 live checks remain outstanding.")
        return 0
    except PreparationError as error:
        print(str(error), file=sys.stderr)
    except Exception:
        # Never format exceptions: they can contain a request/secret value.
        print("Preparation failed; request details suppressed.", file=sys.stderr)
    if args.apply:
        print("No further writes attempted. Partial writes may have occurred; reconcile before starting.",
              file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
