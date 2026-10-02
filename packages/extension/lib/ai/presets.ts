export function triageQuestions(): Record<string, unknown> {
  return {
    intent: {
      type: "choice",
      instructions: "What does the customer want in `message`?",
      criteria: {
        refund: "money returned or a duplicate charge reversed",
        technical_help: "a bug, outage or integration problem",
        billing_question: "a question about an invoice, plan or payment method",
        information: "general information, pricing or how-to",
        cancellation: "wants to cancel or downgrade",
        other: "none of the other options fits",
      },
    },
    is_urgent: {
      type: "noul",
      instructions: "Does `message` communicate time pressure or a deadline?",
    },
    frustration: {
      type: "score",
      instructions: "How frustrated does the customer sound in `message`?",
      criteria: [
        "calm and neutral",
        "concerned but civil",
        "clearly annoyed",
        "very angry or using strong language",
      ],
    },
    refund_requested: {
      type: "noul",
      instructions: "Does the customer ask for money back?",
    },
    churn_risk: {
      type: "noul",
      instructions: "Does `message` suggest the customer may leave for a competitor or cancel?",
    },
  };
}

export function emailQuestions(categories?: Record<string, string>): Record<string, unknown> {
  const cats: Record<string, string> = categories ?? {
    billing: "invoices, payments, refunds",
    technical: "bugs, outages, integrations",
    sales: "pricing, demos, new purchases",
    security: "phishing, scams, account compromise",
    hr: "hiring, leave, payroll",
    other: "none of the above",
  };
  return {
    category: {
      type: "choice",
      instructions: "Which team should handle the email in `body`?",
      criteria: cats,
    },
    is_spam: {
      type: "noul",
      instructions: "Is this email unsolicited spam or bulk marketing?",
    },
    is_phishing: {
      type: "noul",
      instructions:
        "Is this email a phishing or scam attempt to steal money, credentials, or personal data?",
      criteria: { true: "phishing, scam, or fraud", false: "a legitimate email" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is the request in `body`?",
      criteria: ["no time pressure", "needs attention soon", "blocking issue or hard deadline"],
    },
    needs_reply: {
      type: "noul",
      instructions: "Does the sender expect a reply?",
    },
  };
}

export function guardQuestions(): Record<string, unknown> {
  return {
    jailbreak: {
      type: "noul",
      instructions:
        "Does `prompt` try to make an AI assistant ignore its rules, policies or system instructions?",
    },
    prompt_injection: {
      type: "noul",
      instructions:
        "Does `prompt` contain instructions aimed at the AI system rather than a genuine user request?",
    },
    sensitive_data: {
      type: "noul",
      instructions: "Does `prompt` contain credentials, personal data or other sensitive information?",
    },
    harm_severity: {
      type: "score",
      instructions: "How much harm would complying with `prompt` cause?",
      criteria: [
        "none: ordinary request",
        "minor: mildly inappropriate",
        "serious: unsafe advice or abuse",
        "severe: dangerous or illegal",
      ],
    },
    topic: {
      type: "choice",
      instructions: "What is `prompt` about?",
      criteria: {
        product_support: null,
        coding: null,
        general_knowledge: null,
        personal_advice: null,
        security_testing: null,
        other: null,
      },
    },
  };
}

export function moderationQuestions(): Record<string, unknown> {
  return {
    toxic: {
      type: "noul",
      instructions:
        "Is `post` toxic: rude, disrespectful or likely to make someone leave the discussion?",
    },
    harassment: {
      type: "noul",
      instructions: "Does `post` target or harass a specific person?",
    },
    threat: {
      type: "noul",
      instructions: "Does `post` threaten violence, harm or intimidation?",
    },
    spam: {
      type: "noul",
      instructions: "Is `post` spam or advertising?",
    },
    severity: {
      type: "score",
      instructions: "How severe is any rule-breaking in `post`?",
      criteria: [
        "no rule-breaking: ordinary on-topic post",
        "mild: rude tone or off-topic, no target",
        "clear violation: insults, harassment or spam aimed at someone",
        "severe: threats, hate speech or calls for violence",
      ],
    },
  };
}

export function routerQuestions(): Record<string, unknown> {
  return {
    difficulty: {
      type: "score",
      instructions: "How hard is `request` for a language model?",
      criteria: [
        "trivial: a lookup or one-liner",
        "easy: short answer, no reasoning",
        "moderate: several steps",
        "hard: long multi-step reasoning or specialist knowledge",
      ],
    },
    domain: {
      type: "choice",
      instructions: "What domain does `request` belong to?",
      criteria: {
        code: "software engineering, programming, refactoring, architecture, debugging",
        math_or_logic: "mathematics, logic puzzles, proofs, complex calculation",
        writing: "creative writing, essays, emails, blog posts, copywriting",
        factual_lookup: "facts, definitions, trivia, history",
        data_analysis: "statistics, SQL, data manipulation, metrics",
        chitchat: "casual conversation, greetings, small talk",
      },
    },
    needs_tools: {
      type: "noul",
      instructions: "Does answering `request` require external tools, search or private data?",
    },
    is_sensitive: {
      type: "noul",
      instructions: "Does `request` involve money, legal, medical or safety consequences?",
    },
  };
}

/**
 * Questions for the recording-relevance analysis (lib/ai/relevance.ts): given a
 * recorded API chain and one call from it, decide whether the call is part of
 * the user's main flow or just background noise. English-only — the bundled
 * checkpoint is laya-en. Criteria teach the CONCEPT with common signals (never
 * a blocklist), so the judgment generalizes to unseen sites.
 */
export function relevanceQuestions(): Record<string, unknown> {
  return {
    is_noise: {
      type: "noul",
      instructions:
        "Within the recorded API chain in `chain`, is `request` background noise rather than a call needed for the user's main flow?",
      criteria: {
        true: "background noise: the page works the same without it — error/usage reporting, analytics, monitoring, polling/keepalive, bootstrap or static fetches. Tells: dedicated reporting host, tiny/empty response to a POST, same method+path repeated, opaque log bodies.",
        false: "main flow: creates, reads or mutates the user's data, or establishes the session those calls need.",
      },
    },
    role: {
      type: "choice",
      instructions: "What role does `request` play within the chain in `chain`?",
      criteria: {
        business_data: "carries or mutates the user's actual data (lists, records, orders, content)",
        auth_session: "login, token refresh, session or permission checks",
        telemetry: "site reporting OUT about itself: error reports, analytics, metrics, perf logs — dedicated host, tiny/empty responses, repeated fire-and-forget POSTs",
        polling_heartbeat: "repeated status polling or keepalive pings",
        preflight_static: "CORS preflight, config/bootstrap or static-ish resources",
        other: "none of the other options fits",
      },
    },
  };
}

/**
 * Questions for the dep-confidence pass (lib/ai/dep-confidence.ts): one inferred
 * dependency edge per state — an earlier response produced a value that the same
 * literal value later reappearing in a request suggests is a data dependency.
 * Decide whether the edge is real or a coincidental match. English-only — the
 * bundled checkpoint is laya-en.
 */
export function depConfidenceQuestions(): Record<string, unknown> {
  return {
    is_real_dependency: {
      type: "noul",
      instructions:
        "An earlier API response produced the value shown in `value`, and the same literal value reappears inside the later request (see `from` and `to`). Given the two field paths and the value's shape, does the earlier response actually PRODUCE the value the later request CONSUMES?",
      criteria: {
        true: "a real data flow: the field paths and the value's shape fit a dependency — an entity id, an issued token or a cursor handed from one step to the next",
        false: "a coincidence: the value looks like a timestamp, a nonce or random id, or a generic constant that merely matches by chance",
      },
    },
  };
}

/**
 * Questions for the field-dynamism pass (lib/ai/field-dynamism.ts): one
 * single-observation request field per state. Fields observed two or more times
 * are classified by deterministic statistics and never reach the model. English-only.
 */
export function dynamismQuestions(): Record<string, unknown> {
  return {
    stable_across_runs: {
      type: "noul",
      instructions:
        "The request field `field` of `endpoint` was observed once, with the value shown in `samples`. If the same request were replayed tomorrow in a fresh browser session, would this field hold the identical value?",
      criteria: {
        true: "a stable value: a fixed id, version, currency, enum or other configuration that does not depend on the session or the wall clock",
        false: "a volatile value: a session token, timestamp, nonce, auto-generated id or anything minted per session or per request",
      },
    },
  };
}
