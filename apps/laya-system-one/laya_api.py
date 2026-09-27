"""Pinned local Laya multilingual Provider for LARM."""

from __future__ import annotations

import os
from typing import Any

import laya
from laya.serve import create_app


class LocalMultilingualRouter:
    def __init__(self) -> None:
        model_root = os.environ.get("LAYA_MODEL_ROOT", "/srv/ai/models/laya-multilingual")
        device = os.environ.get("LAYA_DEVICE", "cpu")
        self._agent = laya.load(model_root, device=device)
        self.loaded = ["multilingual"]
        self.loaded_revisions = {
            "multilingual": os.environ.get(
                "LAYA_MODEL_REVISION",
                "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851",
            )
        }

    def predict(self, state: Any, questions: dict[str, Any], model: str | None = None) -> dict[str, Any]:
        del model
        result = self._agent.predict(state, questions)
        result["model"] = os.environ.get("LAYA_PUBLIC_MODEL", "laya-multilingual")
        result["routing"] = {
            "model": "multilingual",
            "reason": "profile-pinned multilingual checkpoint",
            "revision": self.loaded_revisions["multilingual"],
        }
        return result


app = create_app(LocalMultilingualRouter())
