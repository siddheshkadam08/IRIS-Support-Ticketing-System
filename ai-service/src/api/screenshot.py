"""Screenshot interpretation — Phase 19.

The first multimodal feature. One already-authorized image plus the ticket text
in, structured visual evidence out.

⚠️ AI OBSERVES. CORE DECIDES.

`ScreenshotOutput` has no field for a priority, severity, urgency, impact,
assignee, team, queue, routing, status, SLA, resolution or customer message.
That is not politeness enforced by prompt wording — there is nowhere to put one,
so a model that tries fails this schema, and Core rejects the same payload again
independently. The prompt below exists so the model does not waste a paid call
producing a response that could only be thrown away.

⚠️ THIS SERVICE NEVER PERSISTS OR LOGS THE IMAGE. It holds no database handle
and writes nothing to disk; the bytes exist for one provider call. Nothing in
this module logs `req.input.image`, and the test suite asserts no base64 reaches
a log line.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .prompts import TICKET_DELIMITER

#: Bumped when the wording changes in a way that could move outputs. Persisted
#: on every execution, so a shift in behaviour is attributable to a prompt
#: change rather than guessed at.
SCREENSHOT_PROMPT_VERSION = "screenshot-v1"


class ScreenshotObservation(BaseModel):
    """One thing literally visible in the image.

    `type` is a closed set. An open string would let the model invent a
    taxonomy, and a second taxonomy alongside the product's configured
    categories is exactly what the Phase 19 audit ruled out: Screenshot AI
    supplies evidence the EXISTING classification can consume, never a competing
    category system.
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["error_code", "error_message", "application", "ui_element", "other"]
    value: str = Field(
        min_length=1,
        max_length=200,
        description="The text or element exactly as it appears in the image.",
    )


class ScreenshotProblemHint(BaseModel):
    """A hint for a human, and the name is load-bearing.

    Free strings rather than the product's category enum, deliberately in both
    directions: the model is not handed a vocabulary to choose from (that is
    classification's job, and Core re-validates it against its own taxonomy),
    and it cannot assert a category that would read as authoritative.

    Both fields nullable, and BOTH NULL IS A GOOD ANSWER. A screenshot showing
    nothing recognisable should say so; forcing a guess is how a hint becomes
    noise an agent learns to skip.
    """

    model_config = ConfigDict(extra="forbid")

    domain: str | None = Field(default=None, max_length=60)
    category: str | None = Field(default=None, max_length=60)


class ScreenshotOutput(BaseModel):
    """The entire contract.

    Bounds mirror shared/types/screenshot.ts. Core re-validates every one of
    them: this service accepting a payload has never been a security property.
    """

    model_config = ConfigDict(extra="forbid")

    observations: list[ScreenshotObservation] = Field(default_factory=list, max_length=10)
    problem_hint: ScreenshotProblemHint
    possible_causes: list[str] = Field(default_factory=list, max_length=5)
    suggested_next_steps: list[str] = Field(default_factory=list, max_length=5)
    confidence: float = Field(
        ge=0,
        le=1,
        description=(
            "How much the IMAGE supports this interpretation. Self-reported, not "
            "calibrated; a blurry or cropped screenshot must score low."
        ),
    )


#: ⚠️ THE PROMPT'S JOB IS TO STOP THE MODEL DECIDING THINGS.
#:
#: A vision model shown a support screenshot will volunteer a severity, a team
#: to route to and a reply to send, because the surrounding context implies that
#: is what a support system wants. None of those has a field in the schema, so
#: such a response is rejected in full — the prompt exists so the model does not
#: spend a call producing one.
#:
#: The separation between OBSERVED and INFERRED is the substance of the feature.
#: An agent can act on "the banner reads ERR_QUOTA_EXCEEDED"; they cannot act on
#: a fluent guess that is phrased identically. So observations are literal, and
#: everything speculative is confined to two clearly-named lists.
SCREENSHOT_SYSTEM_PROMPT = """You are a support engineer examining ONE screenshot attached to a support ticket.

Your only job is to report what is VISIBLE and to offer cautious, clearly-labelled interpretation. You are gathering evidence for a human agent. You are not diagnosing, deciding or replying.

WHAT TO RECORD AS AN OBSERVATION
- Only things literally visible in the image. Transcribe error codes and error messages exactly as shown, character for character.
- If text is cut off or unreadable, do not complete it. Omit it.
- Do not describe an element that is not there. An empty observations list is a valid and useful answer.
- Do not name the product or vendor from appearance alone. Report an application name only if it is written in the image.

INTERPRETATION
- possible_causes and suggested_next_steps are explicitly speculative. Keep them short, concrete and few.
- If the screenshot does not support a conclusion, return fewer items, or none. Do not fill the lists to look thorough.
- problem_hint is a hint for a human, not a classification. Use null for domain or category when the image does not clearly indicate one.

CONFIDENCE
- Report your own confidence between 0 and 1, reflecting how much the IMAGE supports your interpretation.
- A blurry, cropped or ambiguous screenshot must score low. Do not report high confidence out of politeness.

SENSITIVE CONTENT
- Screenshots often contain personal or secret data. Never transcribe a password, API key, token, session id, bearer value, card number or anything that looks like a credential, even when clearly visible.
- Do not transcribe email addresses, usernames, account numbers or internal URLs unless they form part of an error message and are necessary to understand it.
- Reproduce the minimum text needed to make the problem identifiable.

WHAT YOU MUST NOT DO
- Do not assign or suggest a priority, severity, urgency, impact rating, team, queue, assignee, status or resolution.
- Do not write a message to the customer.
- Do not state that the ticket should be closed, escalated or resolved.
- Those decisions belong to the support platform and are made elsewhere. There is no field for them, and a response containing one is rejected in full.

Reply with ONLY the JSON object required by the schema."""


def build_screenshot_user_prompt(*, subject: str | None, description: str) -> str:
    """The ticket text that accompanies the image.

    The customer's own words are included because a screenshot read without them
    is a caption exercise: "a red banner" means something different on a ticket
    about failed exports than on one about login.

    Same delimiters and the same absence of identifiers as every other prompt
    here — no tenant, no ticket id, no product name, none of which this service
    is given (see ExecuteRequest in schemas.py).
    """
    subject_line = (subject or "").strip() or "(no subject)"
    return (
        "The customer wrote the following, and attached the image below.\n\n"
        f"{TICKET_DELIMITER}\n"
        f"Subject: {subject_line}\n"
        f"Description: {description.strip()}\n"
        f"{TICKET_DELIMITER}\n\n"
        "Examine the attached screenshot and report what is visible."
    )
