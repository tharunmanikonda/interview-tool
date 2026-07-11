# Coding Interview Mode Strategy

This document captures the planned behavior for a future Coding Interview mode. It is intentionally a product/architecture note, not an implementation plan for the current bug-fix pass.

## Goal

Coding Interview mode should help during coding interview conversations without assuming every question requires code. The assistant should support screenshots, verbal requirements, follow-ups, approach discussion, debugging, complexity questions, and general technical questions that happen during the same coding interview.

## Core Principle

Keep the system simple for now. Do not add a separate classifier or keyword-matching decision engine yet.

Instead, use a small set of strong prompt templates that instruct ChatGPT to choose the right response shape naturally based on the current interview moment.

## Inputs

Coding mode should support:

- Verbal interviewer requirement from Dictara realtime transcription.
- Screenshot from clipboard, when the problem is shown on screen.
- Both screenshot and verbal notes together.
- Optional candidate spoken response, if captured later.
- Current coding session context, such as selected language, assumptions, approach, and existing code.

When screenshot text and spoken text conflict, treat the screenshot/problem statement as the source of truth unless the spoken text clearly updates the requirement.

## Prompt Types

### 1. Coding Starter Prompt

Used when the user asks for a starter/bridge while the interviewer is still explaining.

Behavior:

- Return one short natural sentence.
- Do not solve fully.
- Do not write code.
- Mention clarifying inputs, constraints, examples, or approach at a high level.

Example output:

```text
I’d first clarify the input format, constraints, and edge cases before choosing the right pattern.
```

### 2. Coding Final Prompt

Used when the full question is ready.

This prompt should handle all normal coding-interview moments, including:

- Full coding problem.
- Clarifying question.
- Approach explanation.
- Request to write code.
- Debugging an existing solution.
- Optimization request.
- Complexity analysis.
- Edge-case discussion.
- General technical question during coding.

Important instruction:

```text
Do not always produce code. Answer only what the interviewer is asking right now.
If the problem is incomplete, ask 1-3 clarifying questions.
If they ask for approach, explain the approach only.
If they ask to code, write code.
If they ask complexity, answer complexity only.
If they ask a general technical question, answer directly.
```

### 3. Coding Follow-Up Prompt

Used after the first coding answer when the interviewer asks a related follow-up.

Behavior:

- Reference the current problem/solution context.
- Answer only the follow-up.
- Do not restart the full solution unless explicitly asked.
- If code changes are needed, show only the relevant changed code or the updated complete function, depending on what is clearer.

## Desired Coding Answer Shape

When the interviewer is clearly asking for a full solution, use this structure:

```text
Clarifying questions:
- ...

Assumptions:
- ...

Approach:
- ...

Pattern:
- Hash map / two pointers / sliding window / BFS / DFS / DP / sorting / etc.

Code:
```language
// meaningful comments for important lines
```

Dry run:
- ...

Complexity:
- Time: O(...)
- Space: O(...)

Edge cases:
- ...

Candidate spoken summary:
- ...
```

For code, comments should explain meaningful logic and decision points. Avoid noisy comments on obvious syntax.

## UI Requirements

Future UI should include:

- Mode selector: General, Coding, System Design, Behavioral.
- Language selector: Python, Java, JavaScript, TypeScript, C++, SQL.
- Screenshot paste/attach action.
- Visible attached screenshot preview or file chip.
- Coding prompt settings:
  - Starter prompt.
  - Final prompt.
  - Follow-up prompt.
- Optional toggles:
  - Ask clarifying questions first.
  - Generate code now.
  - Include dry run.
  - Include test cases.

## Screenshot Handling

Preferred path:

1. User copies screenshot.
2. Extension reads clipboard image.
3. Image is attached to the current turn.
4. Prompt includes the image and verbal transcript.

Fallback path:

1. OCR the screenshot.
2. Send OCR text plus metadata.
3. Keep image preview in the UI if possible.

If screenshot upload into ChatGPT browser automation is unreliable, OCR-first is acceptable for V1.

## General Questions During Coding

Coding mode must be ready for non-coding questions, such as:

- Why did you choose this data structure?
- What happens with duplicate values?
- What is the time complexity?
- Can this handle null or empty input?
- What if the input is very large?
- How would you test this?
- Why not use recursion?
- Can you explain this line?
- How would you debug this bug?
- Have you solved a similar problem before?

The answer should stay scoped to the question. A complexity question should not regenerate the whole solution. A clarification question should not produce code.

## Open Decisions

- Whether screenshot OCR should run locally, in the browser, or through an API.
- Whether the extension should attach images directly into ChatGPT or convert them to text first.
- Whether coding follow-ups should store the current code separately from the final answer text.
- Whether to add a dedicated coding terminal-style renderer in the Docs UI.

## Non-Goals For Now

- No separate intent classifier.
- No keyword-based routing.
- No automatic coding-mode detection.
- No automatic code execution.
- No hidden complex planning layer before every answer.
