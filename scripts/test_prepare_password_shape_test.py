"""Offline safety checks; never use real AWS clients or write parameters."""

import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "prepare_shape", Path(__file__).with_name("prepare-password-shape-test.py"))
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)


def fake_aws():
    aws = Mock()
    aws.region_name = helper.REGION
    aws.client.return_value = aws
    aws.get_caller_identity.return_value = {"Account": helper.ACCOUNT}
    aws.describe_instances.return_value = {"Reservations": [{"Instances": [{
        "InstanceId": helper.INSTANCE_ID, "State": {"Name": "stopped"},
        "Tags": [{"Key": "project", "Value": "enshroudedproj"}],
    }]}]}
    aws.exceptions.ParameterNotFound = helper.ParameterNotFound
    aws.get_parameter.return_value = {"Parameter": {"Type": "String", "Value": "false"}}
    aws.describe_parameters.side_effect = lambda ParameterFilters: {"Parameters": [{
        "Name": ParameterFilters[0]["Values"][0], "Type": "SecureString"}]}
    return aws


class ShapePreparationTests(unittest.TestCase):
    def setUp(self):
        self.passwords = helper.prepare_passwords(helper.load_nine_letter_words())

    def test_real_vendored_words_and_exact_shapes(self):
        words = set(helper.load_nine_letter_words())
        for tier, count in helper.WORD_COUNTS.items():
            parts = self.passwords[tier].split("-")
            self.assertEqual(len(parts), count)
            self.assertEqual(len(self.passwords[tier]), 39 if tier == "admin" else 29)
            self.assertTrue(all(len(part) == 9 and part in words for part in parts))

    def test_preview_is_offline_and_only_lengths(self):
        output = io.StringIO()
        with patch.object(helper, "Aws", side_effect=AssertionError("AWS forbidden")), \
                patch.object(helper.subprocess, "run", side_effect=AssertionError("CLI forbidden")), \
                contextlib.redirect_stdout(output):
            self.assertEqual(helper.main([]), 0)
        self.assertEqual(output.getvalue(), "admin: 39 characters\nfriend: 29 characters\n"
                         "guest: 29 characters\nvisitor: 29 characters\n")

    def test_wordlist_parser_rejects_executable_entries(self):
        for source in ("module.exports = Object.freeze([\n  process.exit(),\n]);",
                       "module.exports = Object.freeze([\n  'abcdefghi',\n]);\nexecute();"):
            path = Mock()
            path.read_text.return_value = source
            with self.assertRaises(helper.PreparationError):
                helper.load_nine_letter_words(path)

    def test_apply_requires_explicit_pinned_id(self):
        for arguments in (["--apply"], ["--apply", "--instance-id", "i-other"],
                          ["--region", "us-west-2"]):
            with contextlib.redirect_stderr(io.StringIO()), \
                    patch.object(helper, "Aws") as aws, self.assertRaises(SystemExit):
                helper.main(arguments)
            aws.assert_not_called()

    def test_failed_account_or_region_does_not_read_instance_or_write(self):
        for mismatch in ("account", "region"):
            aws = fake_aws()
            if mismatch == "account":
                aws.get_caller_identity.return_value = {"Account": "000000000000"}
            else:
                aws.region_name = "us-west-2"
            with self.assertRaises(helper.PreparationError):
                helper.apply_passwords(aws, self.passwords)
            aws.describe_instances.assert_not_called()
            aws.put_parameter.assert_not_called()

    def test_all_instance_and_switch_gates_fail_closed(self):
        for gate in ("id", "missing", "tag", "pending", "running", "stopping", "switch", "unreadable", "secure"):
            with self.subTest(gate=gate):
                aws = fake_aws()
                instance = aws.describe_instances.return_value["Reservations"][0]["Instances"][0]
                if gate == "id":
                    instance["InstanceId"] = "i-other"
                elif gate == "missing":
                    aws.describe_instances.return_value = {"Reservations": []}
                elif gate == "tag":
                    instance["Tags"] = []
                elif gate in ("pending", "running", "stopping"):
                    instance["State"]["Name"] = gate
                elif gate == "switch":
                    aws.get_parameter.return_value["Parameter"]["Value"] = "true"
                elif gate == "secure":
                    aws.get_parameter.return_value["Parameter"]["Type"] = "SecureString"
                else:
                    aws.get_parameter.side_effect = RuntimeError("unreadable")
                with self.assertRaises(Exception):
                    helper.apply_passwords(aws, self.passwords)
                aws.put_parameter.assert_not_called()
                aws.export_credentials.assert_not_called()

    def test_exact_four_secure_writes_and_preflight_before_each(self):
        for absent in (False, True):
            aws = fake_aws()
            if absent:
                aws.get_parameter.side_effect = helper.ParameterNotFound
            helper.apply_passwords(aws, self.passwords)
            self.assertEqual(aws.put_parameter.call_count, 4)
            self.assertEqual(aws.describe_instances.call_count, 5)
            self.assertEqual(aws.get_parameter.call_count, 5)
            for call, (tier, parameter) in zip(aws.put_parameter.call_args_list, helper.PASSWORD_PARAMS.items()):
                self.assertEqual(call.kwargs, dict(Name=parameter, Value=self.passwords[tier],
                                                  Type="SecureString", Tier="Standard", Overwrite=True))
            aws.describe_instances.assert_called_with(InstanceIds=[helper.INSTANCE_ID])
            aws.get_parameter.assert_called_with(Name=helper.ROTATION_SWITCH, WithDecryption=False)

    def test_switch_change_aborts_remaining_writes(self):
        aws = fake_aws()
        off = {"Parameter": {"Type": "String", "Value": "false"}}
        on = {"Parameter": {"Type": "String", "Value": "true"}}
        aws.get_parameter.side_effect = [off, off, on]
        with self.assertRaises(helper.PreparationError):
            helper.apply_passwords(aws, self.passwords)
        self.assertEqual(aws.put_parameter.call_count, 1)

    def test_switch_is_read_before_ec2_and_call_start_time_is_returned(self):
        for absent in (False, True):
            aws = fake_aws()
            order = []
            clock = [100.0]

            def read_switch(**kwargs):
                order.append("switch")
                clock[0] += 30.0
                if absent:
                    raise helper.ParameterNotFound
                return {"Parameter": {"Type": "String", "Value": "false"}}

            response = aws.describe_instances.return_value

            def describe(**kwargs):
                order.append("ec2")
                clock[0] += 6.0
                return response

            aws.get_parameter.side_effect = read_switch
            aws.describe_instances.side_effect = describe
            with patch.object(helper.time, "monotonic", side_effect=lambda: clock[0]):
                observed_at = helper.check_stopped_and_rotation_off(aws, aws)
            self.assertEqual(order, ["switch", "ec2"])
            self.assertEqual(observed_at, 130.0)
            self.assertEqual(clock[0] - observed_at, 6.0)

    def test_delayed_state_observation_blocks_first_or_subsequent_writes(self):
        # Initial preflight consumes the first tick. Each write then needs a
        # call-start tick and a freshness tick; no real time/network delay occurs.
        for ticks, completed_writes in (([0, 1, 6.001], 0),
                                        ([0, 1, 1, 2, 7.001], 1)):
            with self.subTest(completed_writes=completed_writes):
                aws = fake_aws()
                with patch.object(helper.time, "monotonic", side_effect=ticks), \
                        self.assertRaisesRegex(helper.PreparationError, "exceeded five seconds"):
                    helper.apply_passwords(aws, self.passwords)
                self.assertEqual(aws.put_parameter.call_count, completed_writes)

    def test_observation_exactly_five_seconds_old_is_allowed(self):
        aws = fake_aws()
        with patch.object(helper.time, "monotonic", side_effect=[0, 10, 15, 20, 25, 30, 35, 40, 45]):
            helper.apply_passwords(aws, self.passwords)
        self.assertEqual(aws.put_parameter.call_count, 4)

    def test_missing_or_wrong_type_parameter_cannot_be_created_or_overwritten(self):
        for metadata in ([], [{"Name": helper.PASSWORD_PARAMS["admin"], "Type": "String"}]):
            aws = fake_aws()
            aws.describe_parameters.side_effect = None
            aws.describe_parameters.return_value = {"Parameters": metadata}
            with self.assertRaises(helper.PreparationError):
                helper.apply_passwords(aws, self.passwords)
            aws.export_credentials.assert_not_called()
            aws.put_parameter.assert_not_called()

    def test_partial_write_failure_stops_without_secret_output(self):
        aws = fake_aws()
        sentinel = "SECRET-MUST-NOT-APPEAR"
        aws.put_parameter.side_effect = [None, RuntimeError(sentinel)]
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(helper, "Aws", return_value=aws), contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(errors):
            self.assertEqual(helper.main(["--apply", "--instance-id", helper.INSTANCE_ID]), 1)
        self.assertEqual(aws.put_parameter.call_count, 2)
        self.assertNotIn(sentinel, output.getvalue() + errors.getvalue())
        self.assertIn("Partial writes", errors.getvalue())

    def test_cli_credentials_are_captured_and_never_in_argv(self):
        aws = helper.Aws("operator")
        credentials = {"AccessKeyId": "example-id", "SecretAccessKey": "example-secret"}
        with patch.object(helper.subprocess, "run", return_value=Mock(
                returncode=0, stdout=json.dumps(credentials))) as run:
            aws.export_credentials()
        arguments = run.call_args.args[0]
        self.assertEqual(arguments[-4:], ["configure", "export-credentials", "--format", "process"])
        self.assertNotIn("example-secret", " ".join(arguments))
        self.assertTrue(run.call_args.kwargs["capture_output"])

    def test_signed_write_uses_in_memory_body_and_blocks_redirect(self):
        aws = helper.Aws()
        aws.credentials = {"AccessKeyId": "example-id", "SecretAccessKey": "example-secret",
                           "SessionToken": "example-session"}
        opener = Mock()
        opener.open.return_value.__enter__ = Mock(return_value=Mock())
        opener.open.return_value.__exit__ = Mock(return_value=False)
        fixed_time = datetime.datetime(2026, 10, 20, 2, 0, 0, tzinfo=datetime.timezone.utc)
        with patch.object(helper.urllib.request, "build_opener", return_value=opener) as build, \
                patch.object(helper.datetime, "datetime") as clock:
            clock.now.return_value = fixed_time
            aws.put_parameter(Name=helper.PASSWORD_PARAMS["admin"], Value="test-value",
                              Type="SecureString", Tier="Standard", Overwrite=True)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://ssm.us-east-2.amazonaws.com/")
        self.assertEqual(json.loads(request.data)["Value"], "test-value")
        # Independently generated offline using botocore with fake credentials;
        # tests and the helper themselves require only Python's standard library.
        self.assertEqual(request.get_header("Authorization"),
                         "AWS4-HMAC-SHA256 Credential=example-id/20261020/us-east-2/ssm/aws4_request, "
                         "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, "
                         "Signature=0a66410e81edca23bae109c39e57d0cf33215b425abf9e023a6a8170b74142e4")
        self.assertEqual(request.get_header("X-amz-security-token"), "example-session")
        build.assert_called_once_with(helper.NoRedirect)
        self.assertIsNone(helper.NoRedirect().redirect_request(None, None, 307, None, None, "https://example.com"))
        with self.assertRaises(helper.PreparationError):
            aws.put_parameter(Name="/elsewhere", Value="test-value", Type="SecureString")


if __name__ == "__main__":
    unittest.main()
