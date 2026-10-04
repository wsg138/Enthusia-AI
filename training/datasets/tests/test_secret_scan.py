"""Secret scan tests.

Credential-shaped strings are built by concatenation so no literal
secret-looking value ever appears in this file (gitleaks-safe).
"""

import pytest

from enthusia_datasets import record_has_secrets, scan_record


def _rec_with(content: str):
    return {
        "id": "s-1",
        "source_type": "synthetic",
        "visibility": "public",
        "scenario": "support case",
        "messages": [{"role": "user", "content": content}],
        "expected_answer": "ok",
    }


def test_clean_record_has_no_findings():
    rec = _rec_with("my password is hunter2 but that's just a joke")
    # 'hunter2' alone is not a credential assignment; no findings expected.
    assert scan_record(rec) == []
    assert not record_has_secrets(rec)


def test_openai_key_detected():
    key = "sk-" + "A" * 32
    findings = scan_record(_rec_with(f"here is the key {key} please use it"))
    assert any(f.pattern == "openai_key" for f in findings)


def test_github_token_detected():
    tok = "ghp_" + "b" * 36
    findings = scan_record(_rec_with(f"token: {tok}"))
    assert any(f.pattern == "github_token" for f in findings)


def test_aws_access_key_detected():
    key = "AKIA" + "C" * 16
    findings = scan_record(_rec_with(f"aws key {key} in config"))
    assert any(f.pattern == "aws_access_key" for f in findings)


def test_private_key_detected():
    blob = "-----BEGIN RSA PRIVATE KEY-----"
    findings = scan_record(_rec_with(f"uploaded {blob} abc"))
    assert any(f.pattern == "private_key" for f in findings)


def test_password_assignment_detected():
    findings = scan_record(_rec_with("db password: s3cret-value-here"))
    assert any(f.pattern == "credential_assignment" for f in findings)


def test_bearer_token_detected():
    findings = scan_record(_rec_with("Authorization: Bearer " + "d" * 40))
    assert any(f.pattern == "bearer_token" for f in findings)


def test_secret_in_expected_answer_detected():
    key = "sk-" + "E" * 24
    rec = _rec_with("nothing here")
    rec["expected_answer"] = f"use key {key}"
    findings = scan_record(rec)
    assert any(f.field == "expected_answer" for f in findings)


def test_secret_in_fact_claim_detected():
    tok = "ghp_" + "f" * 30
    rec = _rec_with("nothing here")
    rec["facts"] = [{"claim": f"deploy with {tok}", "source": "s", "source_version": "v"}]
    findings = scan_record(rec)
    assert any(f.field.startswith("facts[0]") for f in findings)


def test_finding_never_contains_secret_value():
    key = "sk-" + "A" * 32
    findings = scan_record(_rec_with(f"key {key} end"))
    assert findings
    for f in findings:
        assert key not in f.excerpt
        assert "***REDACTED***" in f.excerpt


def test_findings_deterministically_ordered():
    key = "sk-" + "A" * 32
    tok = "ghp_" + "b" * 36
    rec = _rec_with(f"b {tok} a {key}")
    first = [f.pattern for f in scan_record(rec)]
    second = [f.pattern for f in scan_record(rec)]
    assert first == second == sorted(first) or first == second


def test_scans_tools_expected_actions_and_fact_versions():
    rec = _rec_with("nothing sensitive in the message")
    rec["tools"] = ["Authorization: " + "Bearer " + "t" * 32]
    rec["expected_actions"] = ["api" + "_key=" + "a1" * 12]
    rec["facts"] = [
        {
            "claim": "credential example",
            "source": "test",
            "source_version": "password=supersecretvalue",
        }
    ]
    findings = scan_record(rec)
    fields = {finding.field for finding in findings}
    assert "tools[0]" in fields
    assert "expected_actions[0]" in fields
    assert "facts[0].source_version" in fields
