"""Official OpenAI Python SDK smoke client for the local Omnicross Images harness."""

import base64
import hashlib
import json
import os

import openai
from openai import OpenAI


def require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required contract setting: {name}")
    return value


client = OpenAI(
    api_key=require("OMNICROSS_IMAGES_TOKEN"),
    base_url=require("OMNICROSS_IMAGES_BASE_URL"),
    max_retries=0,
    timeout=10.0,
)
expected_sha256 = require("OMNICROSS_IMAGES_OUTPUT_SHA256")

generated = client.images.generate(
    model="gpt-image-1",
    prompt="python sdk generation contract",
    n=1,
    output_format="png",
)
generated_bytes = base64.b64decode(generated.data[0].b64_json, validate=True)
assert hashlib.sha256(generated_bytes).hexdigest() == expected_sha256

with (
    open(require("OMNICROSS_IMAGES_PRIMARY"), "rb") as primary,
    open(require("OMNICROSS_IMAGES_REFERENCE"), "rb") as reference,
    open(require("OMNICROSS_IMAGES_MASK"), "rb") as mask,
):
    edited = client.images.edit(
        model="gpt-image-1",
        prompt="python sdk multipart edit contract",
        image=[primary, reference],
        mask=mask,
        output_format="png",
    )

edited_bytes = base64.b64decode(edited.data[0].b64_json, validate=True)
assert hashlib.sha256(edited_bytes).hexdigest() == expected_sha256
print(json.dumps({"sdk": openai.__version__, "generate": True, "edit": True}))
