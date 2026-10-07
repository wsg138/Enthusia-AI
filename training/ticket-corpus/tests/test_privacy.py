import unittest

from enthusia_ticket_corpus.extract import Ticket, TicketMessage
from enthusia_ticket_corpus.pipeline import PipelineConfig, run_pipeline
from enthusia_ticket_corpus.privacy import severe_pii_exclusion_reason


def _ticket(content: str) -> Ticket:
    return Ticket(
        ticket_id="privacy-test",
        guild="Enthusia",
        messages=[
            TicketMessage(
                message_id="m1",
                author_id="PLAYER",
                author_name="PLAYER",
                role="player",
                content=content,
            )
        ],
    )


class SeverePiiTests(unittest.TestCase):
    def test_detects_high_confidence_real_world_pii(self) -> None:
        cases = {
            "social_security_number": "My SSN is 123-45-6789.",
            "explicit_home_address": "My home address is somewhere-private.example.",
            "street_address": "They live at 123 Main Street and posted it in chat.",
            "date_of_birth": "My date of birth is 04/12/2008.",
            "full_legal_name": "My full legal name is Jane Marie Example.",
        }
        for reason, content in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(severe_pii_exclusion_reason(_ticket(content)), reason)

    def test_does_not_treat_server_or_minecraft_location_as_severe_pii(self) -> None:
        safe = [
            "The server address is play.enthusia.info.",
            "I died at x -1200 y 64 z 3400.",
            "My Minecraft username is ExamplePlayer.",
            "Can staff help with a player report?",
        ]
        for content in safe:
            with self.subTest(content=content):
                self.assertIsNone(severe_pii_exclusion_reason(_ticket(content)))

    def test_pipeline_excludes_before_redaction_and_logs_no_content(self) -> None:
        raw = {
            "ticket_id": "pii-1",
            "channel_id": "ticket-pii-1",
            "guild": "Enthusia",
            "category": "support",
            "created_at": "2026-09-01T12:00:00Z",
            "closed_at": "2026-09-01T13:00:00Z",
            "flags": {},
            "messages": [
                {
                    "message_id": "m1",
                    "author_id": "PLAYER",
                    "author_name": "PLAYER",
                    "role": "player",
                    "content": "Their home address is 123 Main Street.",
                    "timestamp": "2026-09-01T12:00:00Z",
                },
                {
                    "message_id": "m2",
                    "author_id": "STAFF",
                    "author_name": "STAFF",
                    "role": "staff",
                    "content": "I will review this.",
                    "timestamp": "2026-09-01T13:00:00Z",
                },
            ],
        }
        result = run_pipeline(
            [raw],
            PipelineConfig(
                reference_date="2026-10-07T00:00:00Z",
                dataset_version="privacy-test-v1",
            ),
        )
        self.assertEqual(result.candidates, [])
        self.assertEqual(
            result.rejected,
            [
                {
                    "ticket_id": "pii-1",
                    "reason": "source_excluded",
                    "detail": "severe_pii:explicit_home_address",
                }
            ],
        )
        self.assertNotIn("123 Main Street", str(result.rejected))


if __name__ == "__main__":
    unittest.main()
