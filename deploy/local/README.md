# deploy/local

Local development deployment target — W01/W21.

SKELETON (W01). No deployment happens from this workstream.

Planned contents:

- docker-compose for local services (postgres, qdrant) used by tests/dev;
- mock inference server for local runs without model weights (§76);
- fake tools for offline development (§76).

Local dev must never require production credentials (§76).
