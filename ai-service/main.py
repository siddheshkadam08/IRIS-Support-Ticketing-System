"""Entry point for the IRIS AI service.

    python ai-service/main.py
    uvicorn src.api.app:app --host 0.0.0.0 --port 5000   (from ai-service/)

Bound to 5000 and INTERNAL ONLY — see docs/port-mapping.md. It is called by
`worker`, never by a browser or an integrating product.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import uvicorn  # noqa: E402

from src.config import config  # noqa: E402

if __name__ == "__main__":
    uvicorn.run(
        "src.api.app:app",
        host="0.0.0.0",
        port=config.port,
        log_level=config.log_level,
    )
