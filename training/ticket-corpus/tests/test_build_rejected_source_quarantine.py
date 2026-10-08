"""Synthetic-only regression tests for freezing private source quarantine."""
from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from build_rejected_source_quarantine import freeze


def canonical(row):
    return json.dumps(row, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def setup_release(root):
    staging = root / "staged"
    staging.mkdir()
    source = "W01-0101"
    drafts, index, entries = [], [], []
    for n in (1, 2):
        cid = f"{source}-a{n:02d}"
        draft = {
            "candidate_id": cid, "id": cid,
            "source_candidate_id": source,
            "quality": "USABLE_WITH_EDIT",
            "expected_answer": "Please provide the fictional timestamp.",
        }
        drafts.append(draft)
        index.append({"draft_id": cid, "source_candidate_id": source})
        entries.append({
            "candidate_id": cid,
            "record_sha256": hashlib.sha256(canonical(draft)).hexdigest(),
            "source_candidate_sha256": "a" * 64,
            "source_file_sha256": "b" * 64,
            "source_revision": "imaginary-source-release",
            "review_status": "HOLD", "approved_uses": [], "split": "none",
            "rights_cleared": False, "privacy_cleared": False,
            "staff_visibility_reviewed": False,
        })
    rejections = [{
        "draft_id": source + "-a02",
        "source_candidate_id": source,
        "recommendation": "REJECT",
    }]
    def lines(path, rows):
        path.write_text("\n".join(json.dumps(x) for x in rows)+"\n", encoding="utf-8")
    lines(staging / "DRAFT-W16-NOT-TRAINABLE.private.jsonl", drafts)
    lines(staging / "REVIEW-SOURCE-INDEX.private.jsonl", index)
    manifest_path = staging / "REVIEW-MANIFEST-ALL-HOLD.private.json"
    manifest_path.write_text(json.dumps({
        "schema": "enthusia-ticket-review-admission/v1", "entries": entries,
    }), encoding="utf-8")
    rejection_path = root / "rejections.private.jsonl"
    lines(rejection_path, rejections)
    return staging, rejection_path, root / "new" / "quarantine.private.json"


class FreezeSourceQuarantineTests(unittest.TestCase):
    def test_both_slices_frozen_without_approving_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            result = freeze(staging=a, rejected=b, output=out, expected_rejections=1)
            self.assertEqual(result["source_count"], 1)
            self.assertEqual(result["draft_count"], 2)
            doc = json.loads(out.read_text())
            self.assertEqual(doc["entries"][0]["draft_ids"],
                             ["W01-0101-a01", "W01-0101-a02"])
            self.assertEqual(doc["entries"][0]["disposition"], "REJECT")
            with self.assertRaises(FileExistsError):
                freeze(staging=a, rejected=b, output=out, expected_rejections=1)

    def test_missing_sibling_fails_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            p = a / "REVIEW-SOURCE-INDEX.private.jsonl"
            rows = p.read_text().splitlines()
            p.write_text(rows[0]+"\n",encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "count mismatch"):
                freeze(staging=a, rejected=b, output=out, expected_rejections=1)
            self.assertFalse(out.exists())

    def test_tampered_target_hash_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            p = a / "DRAFT-W16-NOT-TRAINABLE.private.jsonl"
            text = p.read_text().replace("fictional timestamp", "other timestamp")
            p.write_text(text, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                freeze(staging=a, rejected=b, output=out, expected_rejections=1)

    def test_duplicate_rejection_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            b.write_text(b.read_text() * 2, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate"):
                freeze(staging=a, rejected=b, output=out, expected_rejections=2)

    def test_bad_source_release_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            p = a / "REVIEW-MANIFEST-ALL-HOLD.private.json"
            doc = json.loads(p.read_text())
            doc["entries"][0]["review_status"] = "APPROVED"
            p.write_text(json.dumps(doc), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "strictly HOLD"):
                freeze(staging=a, rejected=b, output=out, expected_rejections=1)

    def test_wrong_rejection_disposition_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            a, b, out = setup_release(Path(tmp))
            b.write_text(b.read_text().replace("REJECT", "PROPOSE_REWRITE"), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-rejection"):
                freeze(staging=a, rejected=b, output=out, expected_rejections=1)


if __name__ == "__main__":
    unittest.main()
