# Analytics & metrics

How to read product data honestly and turn it into a decision. Quantify, and be
explicit about what the numbers do **not** say. Never invent a figure.

## Frame the metric before reading it
- **North Star** — the one measure of delivered value the team steers by; most metrics should ladder up to it.
- **Inputs vs. outputs** — outputs (signups, revenue) lag; you move them through inputs (activation rate, time-to-value) you can act on this week. Recommend the input.
- **Rate over count** — a raw count (1,200 signups) is usually less useful than a rate (signup→activation %). Counts grow with traffic; rates reveal the product.
- **Counter-metric** — for any target, name the guardrail it could harm (e.g. push notifications ↑ engagement but ↑ churn). Always report the pair.

## Interpreting a number
- **Compared to what?** A number alone is meaningless — give a baseline, a trend, or a benchmark.
- **Segment before concluding** — an aggregate often hides opposite movements (new vs. returning, plan, platform, geo, cohort). Simpson's paradox is real.
- **Cohorts for retention** — measure retention by signup cohort over time, not a single blended %; blended numbers drift with mix.
- **Distribution, not just the mean** — averages hide skew. Look at medians/percentiles; a few whales or outliers can move a mean.
- **Window & seasonality** — day-of-week, paydays, launches, holidays. Compare like-for-like periods.

## Causation & experiments
- **Correlation ≠ causation.** Before claiming a change caused a result, ask what else changed (releases, marketing, seasonality, mix).
- **A/B tests:** check the result is **statistically significant** AND **practically significant** (big enough to matter); confirm sample size / run length were adequate; watch for peeking (stopping early when it looks good).
- Beware **novelty** and **primacy** effects — early lifts can fade.

## Traps to flag out loud
- **Vanity metrics** — big, flattering, un-actionable (page views, total registered users). Prefer metrics tied to value and decisions.
- **Survivorship bias** — analysing only those who stayed/succeeded; the churned/failed cases hold the lesson.
- **Selection bias** — your sample isn't representative (e.g. only power users answered the survey).
- **Goodhart's law** — when a metric becomes a target it stops being a good metric (people game it).

## Output you return to the coordinator
1. **The insight** in 1–2 lines — what the data actually says, with the number and its comparison.
2. **Caveats** — segments, confounders, weak evidence, or what's missing.
3. **Action / next metric** — the decision it supports, or exactly what to measure or pull to decide.
If a needed number isn't in what you were given, say precisely what to collect — don't guess it.
