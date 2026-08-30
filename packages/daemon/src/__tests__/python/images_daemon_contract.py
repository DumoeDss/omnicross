"""Pinned OpenAI Python SDK client for the daemon Images Tier-A harness."""

import base64
import hashlib
import json
import os

import openai
from openai import OpenAI


PINNED_SDK_VERSION = "3.5.0"


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required contract setting: {name}")
    return value


def emit(value: dict[str, object]) -> None:
    print(json.dumps(value, separators=(",", ":"), sort_keys=True))


if openai.__version__ != PINNED_SDK_VERSION:
    raise RuntimeError(
        f"expected openai {PINNED_SDK_VERSION}, received {openai.__version__}"
    )

mode = require("OMNICROSS_IMAGES_MODE")
timeout = float(os.environ.get("OMNICROSS_IMAGES_TIMEOUT_SECONDS", "10"))
client = OpenAI(
    api_key=require("OMNICROSS_IMAGES_TOKEN"),
    base_url=require("OMNICROSS_IMAGES_BASE_URL"),
    max_retries=0,
    timeout=timeout,
)

if mode == "success":
    expected_sha256 = require("OMNICROSS_IMAGES_OUTPUT_SHA256")
    generated = client.images.generate(
        model="gpt-image-2",
        prompt="python daemon generation contract",
        n=1,
        output_format="png",
        size="1024x1024",
    )
    if len(generated.data) != 1 or generated.data[0].b64_json is None:
        raise AssertionError("unexpected generation response shape")
    generated_bytes = base64.b64decode(generated.data[0].b64_json, validate=True)
    generated_sha256 = hashlib.sha256(generated_bytes).hexdigest()
    if generated_sha256 != expected_sha256:
        raise AssertionError("generation output digest mismatch")

    with (
        open(require("OMNICROSS_IMAGES_PRIMARY"), "rb") as primary,
        open(require("OMNICROSS_IMAGES_MASK"), "rb") as mask,
    ):
        edited = client.images.edit(
            model="gpt-image-2",
            prompt="python daemon multipart edit contract",
            image=primary,
            mask=mask,
            output_format="png",
        )
    if len(edited.data) != 1 or edited.data[0].b64_json is None:
        raise AssertionError("unexpected edit response shape")
    edited_bytes = base64.b64decode(edited.data[0].b64_json, validate=True)
    edited_sha256 = hashlib.sha256(edited_bytes).hexdigest()
    if edited_sha256 != expected_sha256:
        raise AssertionError("edit output digest mismatch")
    emit(
        {
            "sdk": openai.__version__,
            "mode": mode,
            "generate": {"count": len(generated.data), "sha256": generated_sha256},
            "edit": {"count": len(edited.data), "sha256": edited_sha256},
        }
    )
elif mode == "failure":
    try:
        client.images.generate(
            model="gpt-image-2",
            prompt="python daemon failure contract",
            output_format="png",
        )
    except openai.APIStatusError as error:
        payload = error.response.json()
        expected = {
            "error": {
                "message": "The upstream image generation failed.",
                "type": "image_generation_error",
                "code": "image_generation_failed",
            }
        }
        if error.status_code != 502 or payload != expected:
            raise AssertionError("unexpected provider failure response") from error
        emit(
            {
                "sdk": openai.__version__,
                "mode": mode,
                "status": error.status_code,
                "code": error.code,
            }
        )
    else:
        raise AssertionError("provider failure unexpectedly succeeded")
elif mode == "cancel":
    client.images.generate(
        model="gpt-image-2",
        prompt="python daemon cancellation contract",
        output_format="png",
    )
    raise AssertionError("cancellation contract unexpectedly completed")
else:
    raise RuntimeError(f"unsupported contract mode: {mode}")
