---
title: "Dinner With Anyone: Models Disagree on Who You Should Pick"
date: 2026-03-06
description: Ask a model who you should have dinner with and you'll get very different answers — unless you're asking Grok, which always says Elon Musk.
draft: true
author: "Dustin Mihalik"
---

Ask a model who you should invite to a one-on-one dinner with any living person and you get a remarkably wide spread of answers. Unlike some questions where models converge, this one reveals distinct preferences across labs — with one notable exception. [See the detailed results.](/dinner-with-anyone)

Most models cluster around a small set of "safe" choices: Barack Obama and Malala Yousafzai are the most popular, followed by David Attenborough. `gpt-4o-mini` answered Barack Obama 100% of the time. `qwen3-235b` answered Malala Yousafzai 100% of the time. `glm-5` and `gpt-5.2` both landed on David Attenborough every single time.

Then there are the Grok models. All three — `grok-4`, `grok-4-fast`, and `grok-4.1-fast` — answered Elon Musk on every single run, without exception. Grok is made by xAI, which was founded by Elon Musk. Whether that relationship explains the pattern is not something we can determine from outputs alone, but it's a consistent and distinctive result.

Grok isn't the only model that answered Elon Musk consistently — `gemini-2.5-flash` and `claude-sonnet-4.6` also returned Elon Musk on 100% of runs. What separates Grok is that the result holds across all three model variants from the same lab, while other labs' models show much more variation in their answers.

Some reasoning models show their work. Here's an example trace that illustrates how a model can reason itself toward a "safe" answer:

```
reasoning: The user wants a direct, concise answer: name of a specific living person to have dinner with.

## Determining dinner guest
- The user requested a specific living person for dinner, without additional explanation.
- Focusing on a harmless, non-controversial choice, avoiding any criminal associations.
```

The explicit goal of avoiding controversy is visible in the chain of thought before a name is even chosen.

`gpt-5.4` stands out on the other end of the spectrum — it was the most varied model overall, naming Satya Nadella, Warren Buffett, Tim Berners-Lee, Malala Yousafzai, Sam Altman, and Demis Hassabis across 15 runs, skewing heavily toward tech and business figures rather than political or humanitarian ones.

[See the detailed results.](/dinner-with-anyone)
