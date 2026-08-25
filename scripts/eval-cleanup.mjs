// A/B the cleanup style directives against the real model — the harness that
// settled "can Gemma remove the fillers on its own, or does it need code?".
//
//   node scripts/eval-cleanup.mjs <model.gguf> [seeds]
//   REPORTED=1 ARMS=polished/old,polished/new node scripts/eval-cleanup.mjs …
//
// Finding (gemma-3-4b-it-Q4_K_M, 2 full-length transcripts x 5 seeds): the
// wording is the whole lever. The old Polished directive left 20 fillers and
// 5 repeats and produced 0/10 clean runs; sharpening the directive alone —
// same sampling — produced 10/10 clean runs. Changing sampling alone did
// nothing. Not in the test suite: it needs a multi-GB model.
//
// Each arm reproduces production exactly: the prompt assembly from
// main/cleanup-styles.js (base prompt + style directive) and the single-user-
// turn shape from main/engines/engine-worker.js. Only the directive text and
// the sampling profile differ between arms.

import { createRequire } from "node:module";
import { getLlama, LlamaChatSession } from "node-llama-cpp";

const require = createRequire(import.meta.url);
const { DEFAULTS } = require("../main/settings");

const BASE = DEFAULTS.cleanup.systemPrompt;

// The directives as they were before the fix, kept so the comparison can be
// re-run; the NEW_* pair must stay in sync with main/cleanup-styles.js.
const OLD_CLEAN =
  "Remove filler words (um, uh, you know, like) and false starts. " +
  "Collapse repeated words, restarted phrases and stutters into one clean " +
  "version. Keep the speaker's wording and tone — do not summarize, expand " +
  "or add anything.";
const NEW_CLEAN =
  "Delete every filler word (um, uh, er, mm, you know, like) and every " +
  "false start — none may appear in your output. " +
  "Collapse repeated words, restarted phrases and stutters into one clean " +
  "version. Keep the speaker's wording and tone — do not summarize, expand " +
  "or add anything.";
const OLD_POLISHED =
  "Produce clean, readable prose: remove fillers and false starts, fix " +
  "grammar, and lightly rephrase awkward phrasing for clarity. Preserve " +
  "the speaker's meaning, intent and approximate length — do not " +
  "summarize, expand or invent details.";
const NEW_POLISHED =
  "Delete every filler word (um, uh, er, mm, you know, like, I mean) and " +
  "every false start — none may appear in your output. Collapse repeated " +
  "words and restarted phrases into one clean version. Then produce " +
  "readable prose: fix grammar and lightly rephrase awkward phrasing for " +
  "clarity. Preserve the speaker's meaning, intent and approximate " +
  "length — do not summarize, expand or invent details.";

const OLD_CLEAN_S = { temperature: 0.2, topP: 0.95, topK: 40, minP: 0.05 };
const OLD_POLISHED_S = { temperature: 0.4, topP: 1.0, topK: 0, minP: 0.02 };
const NEW_POLISHED_S = { temperature: 0.3, topP: 0.95, topK: 40, minP: 0.02 };

const ALL_ARMS = [
  { id: "clean/old", directive: OLD_CLEAN, sampling: OLD_CLEAN_S },
  { id: "clean/new", directive: NEW_CLEAN, sampling: OLD_CLEAN_S },
  { id: "polished/old", directive: OLD_POLISHED, sampling: OLD_POLISHED_S },
  { id: "polished/new", directive: NEW_POLISHED, sampling: NEW_POLISHED_S },
  // Which lever did the work?
  { id: "polished/prompt-only", directive: NEW_POLISHED, sampling: OLD_POLISHED_S },
  { id: "polished/sampling-only", directive: OLD_POLISHED, sampling: NEW_POLISHED_S },
];
const ARMS = process.env.ARMS
  ? ALL_ARMS.filter((a) => process.env.ARMS.split(",").includes(a.id))
  : ALL_ARMS;

// The reported failure, at full paragraph length — the shape that broke.
const REPORTED = [
  "But the thing is, this feature has to be available for all users, not just admins. And I think that the connectors page is uh, for admins. So like, how can we move the um we should add something like connect Gmail to the user's profile page. Of course, they don't need to add the uh application. The the admin will add the application details. They just need to provide access to the Gmail account.",
  "so um I wanted to to ask about the the deployment pipeline uh because right now we we build the the image twice you know once in the the test job and um once in the release job which is uh wasteful. I think we we can just uh push the the artifact from the first one and um pull it in the second, that that would cut the the build time in half you know.",
];

// Dictation to a coding agent, as STT writes it: fillers, restarts, stutters.
const SHORT = [
  "But the thing is, this feature has to be available for all users, not just admins. And I think that the connectors page is uh, for admins. So like, how can we move the um we should add something like connect Gmail to the user's profile page.",
  "Of course, they don't need to add the uh application. The the admin will add the application details. They just need to provide access to the Gmail account.",
  "um so I was thinking we could uh refactor the the parser first and then you know move on to the renderer",
  "can you uh check why the the tests are failing on windows um I think it's the path separator",
  "so um the the problem is that we we call the API twice uh once on mount and once on focus",
  "I want to um add a a retry to the upload uh with exponential backoff you know",
  "let's uh rename the the variable to user profile and um update all the call sites",
  "the uh the thing about the cache is that it it never expires um which is a problem in production",
  "um can you write a a test for the the empty state uh the one where there are no connectors",
  "so like the the migration should uh run before the the server starts um otherwise it crashes",
  "uh I think we we should just um delete the the whole legacy folder you know it's it's dead code",
  "um so the the user clicks connect and then uh we redirect them to to google and um they come back with a token",
];

const INPUTS = process.env.REPORTED ? REPORTED : SHORT;

const FILLER = /(?<![\w-])(?:u[mh]+|erm+)(?![\w-])/gi;
const REPEAT =
  /(?<![\p{L}\p{N}'’-])([\p{L}\p{N}][\p{L}\p{N}'’-]*)((?:[^\S\n]+\1)+)(?![\p{L}\p{N}'’-])/giu;
const KEEP_DOUBLED = new Set(["had", "that", "very", "really", "so", "no", "yes"]);

function countFillers(text) {
  return (text.match(FILLER) || []).length;
}
function countRepeats(text) {
  let n = 0;
  text.replace(REPEAT, (m, word, rest) => {
    if (KEEP_DOUBLED.has(word.toLowerCase()) || /\p{N}/u.test(word)) return m;
    const echoes = rest.trim().split(/\s+/);
    if (echoes.every((e) => e === e.toLowerCase() || word === "I")) n++;
    return m;
  });
  return n;
}

function samplingOptions(s) {
  const o = { temperature: s.temperature };
  if (s.topP != null) o.topP = s.topP;
  if (s.topK != null && s.topK > 0) o.topK = s.topK;
  if (s.minP != null && s.minP > 0) o.minP = s.minP;
  return o;
}

const modelPath = process.argv[2];
const seeds = (process.argv[3] || "1").split(",").map(Number);

const llama = await getLlama();
const model = await llama.loadModel({ modelPath });
const context = await model.createContext({ contextSize: 4096 });
// One sequence, one session, reset between turns — exactly what the worker's
// freshSession() does in production.
const session = new LlamaChatSession({ contextSequence: context.getSequence() });
const results = [];

for (const arm of ARMS) {
  const systemPrompt = `${BASE}\n\nEditing style: ${arm.directive}`;
  for (const [i, transcript] of INPUTS.entries()) {
    for (const seed of seeds) {
      session.resetChatHistory();
      const userTurn = `${systemPrompt}\n\nTranscript:\n${transcript}\n\nCleaned transcript:`;
      const out = (
        await session.prompt(userTurn, {
          ...samplingOptions(arm.sampling),
          seed,
          maxTokens: 512,
        })
      ).trim();
      results.push({
        arm: arm.id,
        input: i,
        seed,
        fillers: countFillers(out),
        repeats: countRepeats(out),
        inFillers: countFillers(transcript),
        inRepeats: countRepeats(transcript),
        ratio: out.length / transcript.length,
        out,
      });
      process.stderr.write(".");
    }
  }
  process.stderr.write(`\n${arm.id} done\n`);
}

console.log(JSON.stringify(results, null, 1));
