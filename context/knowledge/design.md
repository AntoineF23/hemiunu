# Design Guideline

Source: Apple WWDC26 — "Principles of great design" (Linda & Doug, Apple design evangelists).
Purpose: an actionable reference for an agent that designs interfaces. Apply these eight principles to produce experiences that serve people, respect and adapt to their lives, are clear and considered, and are a joy to use.

## What design is

- Design is making something with intention. It is focusing on what is most important to people so you can build something they will truly value.
- "How it looks" and "how it behaves" are not wrong definitions, but they are incomplete. Lead with intention.
- Every feature you add asks something of the person: their time, their attention, and their trust. These are valuable and cannot be wasted.
- Choosing what to build is often a matter of deciding what NOT to include.

## How to use these principles

- There is no formula or single correct way to combine these principles that guarantees a perfect solution.
- Leaning hard into one principle can feel like compromising another. That tension is normal — resolve it with judgment and intuition, not a checklist applied blindly.
- Treat the list below as forces to balance for the specific people, device, and context you are designing for.

---

## 1. Purpose (foundational)

Before drawing a sketch or writing a line of code, decide whether what you are making has purpose.

Rules:
- Justify every feature against what matters most to the people using it.
- Default to removing rather than adding. If a feature does not clearly serve the core purpose, cut it.
- Protect the user's time, attention, and trust as scarce resources — never spend them on things that do not serve the person.

## 2. Agency — put people in control

People feel in control when you let them do things their way, and they are far more engaged when they control their own experience.

Rules:
- Offer choices. Offering choices is the best way to bring agency into an experience.
- Never let the interface stand in the way of what someone is trying to do.
- Don't force people down a predetermined path. Let them dive in and explore at their own pace, with the autonomy to decide what to explore.

### Forgiveness (supports agency)

People accidentally send, change, and delete things all the time. Give them confidence that they can always recover.

Rules:
- Make it easy to undo any action.
- When an action is destructive, double-check that it is what the person actually means to do.
- Use interruptions (confirmations) carefully and only when someone is about to make a big mistake. Helpful interruptions prevent disaster; excessive ones get in the way.
- The goal: people feel capable, secure, and free to explore because they know they can recover from anything.

## 3. Responsibility — act in people's best interest

Giving people freedom also means protecting their well-being. Your work has real impact on people's lives; take that seriously and it leads to a product people can trust.

### Privacy (a human right)

Rules:
- Do not throw permission prompts the moment the app launches, before the person understands what it does.
- Wait for the right moment to ask for personal data.
- Ask only for what is necessary.
- Be transparent about what the data is for; never request information without context.
- Treat people and their private information with respect, exactly as you would in the real world. (You would not trust a stranger who demanded your phone number "just because" — interfaces should not behave that way either.)

### Safety

Look closely at the functionality you offer and ask hard questions:
- How could this feature be misused?
- Who would be harmed by this?
- How do I prevent it?

Responsible AI features:
- Assume an AI model might generate something unexpected or inaccurate. Plan for it.
- Example: a recipe app where someone logs an allergy must anticipate that the model could suggest a dangerous ingredient — a real-world harm you cannot leave to chance.
- Add safeguards: previews, confirmations, disclaimers.
- If the risk to people's safety outweighs the value, remove the feature entirely.
- It is your responsibility to protect anyone using the product AND anyone who could be affected by it.

## 4. Familiarity — build on what people know

People arrive with a lifetime of experience: they understand the real world and have learned conventions from other interfaces. Lean on that existing knowledge to make designs intuitive.

### Metaphor

Rules:
- Use metaphors that draw on something people already know so they can predict what an element will do. When right, a metaphor clicks instantly.
- Don't make a metaphor too literal (people may not recognize what you're showing) or too abstract (the idea doesn't get across). Example: an "inspector" shows details of whatever is selected — pitch the metaphor between literal and abstract.
- Don't misuse a known metaphor. A trash-can icon must mean delete; using it for anything else breaks people's familiarity. (Trash also implies recoverability — you can retrieve items from it, like the real world.)
- Don't take creative liberty with established symbols (e.g., the delete icon) — you lose immediate recognition.
- For common actions, don't reinvent the wheel. Use the metaphors people already know and make sure they do what people expect.

### Consistency

Consistency helps people predict what happens next. Things that look the same should behave the same.

Rules:
- Consistent behavior: if similar-looking buttons each do something different (one navigates, one toggles, one opens a modal), there is no learnable pattern. Keep matching elements matching in behavior.
- Consistent placement: keep actions in the same location across screens and devices (e.g., on Mac you always close a window from the top-left corner). Predictable placement speeds people up so they don't have to think.

Note: familiarity does NOT mean recycling the same solution everywhere. Know which metaphors and patterns to use, and when.

## 5. Flexibility — adapt to people's real lives

People use your design in ways as unique as they are. Support the different contexts they find themselves in.

Rules:
- Design for context. The same task changes with situation — e.g., music: at home via speakers, on a run via AirPods + watch, or driving fully hands-free. An interface that accommodates different situations works for a wider audience and feels more comfortable.
- Design for each device's strengths. iPhone → quick, touch-based interactions. Mac → deep workflows and precise pointer control. Every device deserves a solution that takes advantage of what makes it unique.
- Design for the range of human abilities. Get curious about your audience: How old are they? What languages do they speak? Are they a pro or a novice? Do they rely on accessibility features? You won't solve for everyone on day one, but keep examining how the experience can be more inclusive.
- When no single layout satisfies everyone, let people personalize: rearrange controls to fit their workflow, or hide controls they never use.
- Flexibility is an investment, but it proves to people you designed with them in mind.

## 6. Simplicity — strip away the unnecessary so the core purpose shines

Simple is NOT the same as minimal. Burying all functionality in one place can look minimal but is not simple. Simple designs are frictionless and intuitive — people find what they need without effort. You reach it through being concise and clear.

### Concise

Rules:
- Use plain language; strip away jargon and speak naturally.
- Avoid redundancy and get straight to the point.
- Respect people's time: reduce the number of steps it takes to get things done.

### Clear

A clear design communicates exactly what it does. Clarity is built with hierarchy.

Rules:
- Use order, spacing, and contrast to guide people to what's most important.
- When hierarchy is strong, the most important item on screen is the most obvious one.
- Make the interface answer: What do I pay attention to? What can I interact with? How do I interact?

### Earn every element

- Every element must earn its place. Find information you can distill to its essence.
- Consider whether complex data is better understood as a graphic.
- Look for chances to summarize so people can focus on what they care about.
- Counter-intuitively, simpler can sometimes mean adding more. Example: a video play/pause control is simple, but adding where you are and how much time is left gives needed context to make informed decisions.
- You've arrived at simplicity when you have exactly enough — no more, no less.

## 7. Craft — execute the details flawlessly

Craft is the attention to detail that tells people you care about the experience. People feel cheapness instantly (a rickety door, a shirt that unravels) — and the same is true of software.

Signs of rushed, low-craft software (avoid these):
- You tap a button and just wait for it to respond.
- Scrolling is jittery.
- Icons are misaligned.
- Rotating the device breaks the layout.
- It feels fragile — which makes people question the quality of the results they'll get.

A meticulously crafted design does the opposite: it inspires confidence.

High-quality materials of a well-crafted design:
- Beautiful fonts that look great across devices.
- Thoughtful colors that adapt seamlessly across light and dark environments.
- Clear graphics and iconography.
- Responsive animations that feel fluid and provide immediate, natural feedback.
- A solid foundation of reliable and secure SDKs.

Process:
- Quality requires time and iteration; make sure every last piece functions beautifully.
- Craft is continual. A large part of it is maintaining the design over time.
- Great design has longevity — keep evolving it. When new features or hardware appear, explore whether they make sense for the experience. When the product evolves with these changes, people feel supported and rewarded.
- Craft is an uncompromising commitment to the details. Get them right and people will know you care.

## 8. Delight — the emotional payoff

Delight is hard to define but instantly recognizable. Delightful interfaces are satisfying, enriching, and create a real emotional connection — and that connection starts when an experience feels human.

Rules:
- Do NOT manufacture delight by adding confetti or tacking flourishes onto the end of the process.
- Create delight by identifying the emotion you want your audience to feel — relaxed, confident, excited — and finding opportunities to reinforce that emotion through the design.
- Delight is the sum of the consideration you put into the product. It is the natural result of getting all the other principles right: design with intention and care, give people the agency to act, the safety to explore, the comfort of familiar patterns, and the ability to make it their own — and the experience becomes a true joy to use.

---

## Quick checklist

- Purpose: Does this feature serve what matters most? If not, cut it. Protect time, attention, trust.
- Agency: Offer choices, don't force a path, make everything undoable, confirm destructive actions.
- Responsibility: Ask for data only when needed, with context. Ask how it could be misused, who's harmed, how to prevent it. Add safeguards to AI features or remove risky ones.
- Familiarity: Use known metaphors correctly (not too literal/abstract); keep look-alike elements behaving alike and in consistent locations.
- Flexibility: Adapt to context, device strengths, and abilities; allow personalization.
- Simplicity: Plain language, fewer steps, strong hierarchy (order/spacing/contrast); every element earns its place; add context when it aids decisions.
- Craft: No lag, jitter, misalignment, or broken layouts; quality fonts, adaptive colors, clear icons, fluid feedback, reliable SDKs; iterate and maintain.
- Delight: Pick the target emotion and reinforce it throughout — never bolt it on at the end.

## Reference

Apple's Human Interface Guidelines (HIG) are the primary resource for designing on Apple platforms, including a dedicated design principles page.
