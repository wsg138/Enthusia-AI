"""Produce an immutable, HOLD-only ticket review derivative from editorial proposals.

Strictly a PRIVATE data-preparation utility. Editorial rewrites do not mean
independent adjudication, verified log access, rights clearance, or permission
to train. Refuses invalid IDs, stale original digests, unexpected approvals,
overwrite, and unmapped source-reference mutations.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import re
import sys

ID = re.compile(r"^(W[0-9]{2}-[0-9]{4})-a([0-9]{2})$")
SHA40 = re.compile(r"^[a-f0-9]{40}$")


def canon(row):
    return json.dumps(row, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def load_rows(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8-sig").splitlines()
            if x.strip()]


def resolution_pairs(paths):
    pairs = {}
    for path in paths:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
        for entry in doc.get("entries", []):
            old, new = entry.get("original_prefix"), entry.get("pinned_ref")
            if not isinstance(old, str) or not isinstance(new, str):
                raise ValueError("resolution must include original_prefix and pinned_ref")
            if "@" not in old or "@" not in new:
                raise ValueError("not a repository revision")
            old_repo, old_tail = old.split("@", 1)
            new_repo, new_tail = new.split("@", 1)
            if old_repo != new_repo or ":" not in old_tail or ":" not in new_tail:
                raise ValueError("resolution alters repository or omits path")
            if old_tail.split(":", 1)[1] != new_tail.split(":", 1)[1]:
                raise ValueError("resolution changes source path")
            if not SHA40.fullmatch(new_tail.split(":", 1)[0]):
                raise ValueError("resolution does not pin full commit SHA")
            if entry.get("exists_at_pinned_commit") is not True:
                raise ValueError("source existence not verified at pinned commit")
            if old in pairs and pairs[old] != new:
                raise ValueError("conflicting source resolutions")
            pairs[old] = new
    return pairs


def replace_refs(refs, pairs):
    new_refs, count = [], 0
    for ref in refs:
        if not isinstance(ref, dict) or not isinstance(ref.get("ref"), str):
            raise ValueError("invalid source ref")
        item = deepcopy(ref)
        old = item["ref"]
        matches = [key for key in pairs if old == key or old.startswith(key + "#")]
        if len(matches) > 1:
            raise ValueError("ambiguous source revision mapping")
        if matches:
            key = matches[0]
            item["ref"] = pairs[key] + old[len(key):]
            count += 1
        new_refs.append(item)
    return new_refs, count


def apply_proposals(drafts, indexes, manifest, proposals, pairs, validator):
    from screen_review_targets import verify_staged
    original, by_meta, by_appr = verify_staged(drafts, indexes, manifest)
    source_order = defaultdict(list)
    for rid in original:
        m = ID.fullmatch(rid)
        if not m:
            raise ValueError("review draft ID is not a ticket assistant turn")
        source_order[m.group(1)].append((int(m.group(2)), rid))
    for group in source_order.values():
        group.sort()
        if [i for i,_ in group] != list(range(1, len(group) + 1)):
            raise ValueError("missing intermediate assistant draft")
    by_proposal = {}
    for p in proposals:
        rid = p.get("draft_id")
        if rid in by_proposal or rid not in original:
            raise ValueError("duplicate or unknown editorial proposal")
        if p.get("approval_status") != "HOLD" or p.get("training_eligible") is not False:
            raise ValueError("editorial notes unexpectedly assert training eligibility")
        answer = p.get("suggested_player_safe_answer")
        if answer is not None and (not isinstance(answer, str) or not answer.strip()):
            raise ValueError("malformed proposed answer")
        if answer is not None and answer == original[rid]["expected_answer"]:
            raise ValueError("proposed answer is unchanged")
        by_proposal[rid] = p
    new_drafts = {rid:deepcopy(row) for rid,row in original.items()}
    new_meta = {rid:deepcopy(row) for rid,row in by_meta.items()}
    new_appr = {rid:deepcopy(row) for rid,row in by_appr.items()}
    edits = []
    rewritten = {}
    carry_over = 0
    ref_changes = 0
    for source_id, targets in sorted(source_order.items()):
        previous_responses = []
        for _,rid in targets:
            old = original[rid]
            new = new_drafts[rid]
            for prev_old, prev_new in previous_responses:
                if prev_old != prev_new:
                    hits = 0
                    for msg in new["messages"]:
                        if msg["role"] == "assistant" and msg["content"] == prev_old:
                            msg["content"] = prev_new
                            hits += 1
                    if hits != 1:
                        raise ValueError(f"{rid}: prior assistant turn missing or duplicate")
                    carry_over += 1
            proposed = by_proposal.get(rid, {}).get("suggested_player_safe_answer")
            if proposed is not None:
                new["expected_answer"] = proposed
                rewritten[rid] = True
                edits.append({"draft_id":rid,"reason":"independent_review_pending_edit",
                              "original_target_sha256":sha256(old["expected_answer"].encode()).hexdigest(),
                              "proposed_target_sha256":sha256(proposed.encode()).hexdigest(),
                              "actual_player_visible_edits":"PROPOSED_NOT_APPROVED"})
            previous_responses.append((old["expected_answer"],new["expected_answer"]))
            refs, adjusted = replace_refs(new_meta[rid]["source_refs"], pairs)
            new_meta[rid]["source_refs"] = refs
            ref_changes += adjusted
            new_meta[rid]["review_status"] = "HOLD"
            new_meta[rid]["training_eligible"] = False
            new_appr[rid]["record_sha256"] = digest_target(validator(new))
            if new_appr[rid]["review_status"] != "HOLD":
                raise ValueError("unapproved manifest changed")
    resulting = [new_drafts[row["id"]] for row in drafts]
    idx = [new_meta[row["draft_id"]] for row in indexes]
    holds = deepcopy(manifest)
    holds["manifest_id"] = manifest["manifest_id"] + "-editorial-proposal-v1"
    holds["entries"] = [new_appr[e["candidate_id"]] for e in manifest["entries"]]
    verify_staged(resulting, idx, holds)
    return resulting, idx, holds, edits, {
        "original_drafts":len(drafts),
        "proposed_target_rewrites":len(rewritten),
        "prior_assistant_context_updates":carry_over,
        "source_reference_occurrences_revised":ref_changes,
        "approved_records":0,
        "all_drafts_status":"HOLD",
    }


def digest_target(row):
    data = dict(row)
    data.pop("dataset_version",None)
    data.pop("quality_metadata",None)
    return sha256(canon(data).encode("utf-8")).hexdigest()


def run(staged, notes, resolutions, out_dir, w16_root):
    if out_dir.exists():
        raise FileExistsError("review derivative destination already exists")
    sys.path.insert(0,str(w16_root))
    from enthusia_datasets.record import validate_record
    drafts = load_rows(staged/"DRAFT-W16-NOT-TRAINABLE.private.jsonl")
    indexes = load_rows(staged/"REVIEW-SOURCE-INDEX.private.jsonl")
    manifest = json.loads((staged/"REVIEW-MANIFEST-ALL-HOLD.private.json").read_text(encoding="utf-8"))
    proposals = load_rows(notes)
    pairs = resolution_pairs(resolutions)
    results = apply_proposals(drafts,indexes,manifest,proposals,pairs,validate_record)
    out_d,out_m,out_a,changes,counts = results
    out_dir.mkdir(parents=True)
    for filename,body in (
        ("DRAFT-W16-NOT-TRAINABLE.private.jsonl",out_d),
        ("REVIEW-SOURCE-INDEX.private.jsonl",out_m),
        ("EDITORIAL-CHANGESET.private.jsonl",changes)
    ):
        (out_dir/filename).write_text("\n".join(canon(x) for x in body)+"\n",encoding="utf-8")
    (out_dir/"REVIEW-MANIFEST-ALL-HOLD.private.json").write_text(
        json.dumps(out_a,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
    report={"status":"REVIEW_ONLY_EDITORIAL_NOT_TRAINABLE",**counts,
            "proposals_submitted":len(proposals),
            "reference_resolutions_supplied":len(pairs),
            "next_step":"Independent source/privacy/semantic review; do not train this derivative."}
    (out_dir/"EDITORIAL-DERIVATIVE-REPORT.json").write_text(
        json.dumps(report,indent=2)+"\n",encoding="utf-8")
    return report


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--staged-dir",required=True,type=Path)
    p.add_argument("--editorial-notes",required=True,type=Path)
    p.add_argument("--source-resolutions",required=True,nargs="+",type=Path)
    p.add_argument("--w16-root",required=True,type=Path)
    p.add_argument("--out-dir",required=True,type=Path)
    a=p.parse_args(argv)
    print(json.dumps(run(a.staged_dir,a.editorial_notes,a.source_resolutions,
                         a.out_dir,a.w16_root),indent=2))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
