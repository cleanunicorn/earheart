// Dictation corpora for the cleanup work — shared by the eval/bench harnesses
// (scripts/eval-cleanup.mjs, scripts/bench-cleanup.mjs) and the tests
// (test/cleanup-metrics.test.js, test/unit.test.js, test/bench-cleanup.test.js),
// so the shapes that broke in production and the shapes the tests exercise can
// never drift apart.
//
// Each corpus is a different SHAPE of dictation, and the shape is what decides
// whether the cleanup model removes fillers on its own:
//
//   SHORT / REPORTED — short, filler-dense fragments ("so um I wanted to to
//     ask about the the deployment pipeline"). Nearly every clause carries a
//     stumble, so "delete every filler word" has an obvious target and Gemma
//     3 4B obeys it.
//   FLUENT — a long, mostly fluent dictation with a handful of fillers
//     sprinkled through it. This is the shape that fails: the base prompt's
//     preservation rules ("never add information", "the output is never longer
//     than the input", "reproduce it verbatim") put the model in copy mode and
//     it returns the transcript with the punctuation tidied and every "um"
//     intact. Measured on gemma-3-4b-it-Q4_K_M: 6 fillers in, 6 fillers out,
//     3 seeds out of 3, with both the old and the current Polished directive.
//
// A cleanup change that is only measured on SHORT/REPORTED will look like it
// removes fillers when it does not. Measure FLUENT too.

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

// The first reported failure, at full paragraph length.
const REPORTED = [
  "But the thing is, this feature has to be available for all users, not just admins. And I think that the connectors page is uh, for admins. So like, how can we move the um we should add something like connect Gmail to the user's profile page. Of course, they don't need to add the uh application. The the admin will add the application details. They just need to provide access to the Gmail account.",
  "so um I wanted to to ask about the the deployment pipeline uh because right now we we build the the image twice you know once in the the test job and um once in the release job which is uh wasteful. I think we we can just uh push the the artifact from the first one and um pull it in the second, that that would cut the the build time in half you know.",
];

// The second reported failure: long, fluent, sparsely filled. `raw` is what
// Parakeet produced; `modelOutput` is what the built-in Gemma 3 4B returned for
// it on the Polished style — punctuation and capitalization tidied, all six
// fillers still there. That output is the fixture the deterministic backstop
// (main/util/stumble-strip.js) has to rescue.
const FLUENT = {
  raw: "I want to change how the contact form works. Right now it's a large form, and to the right there is a link to the scheduling page. I want to simplify this and transform the whole flow in a multiple step process. Um, first step would be We ask the user to kind of like this is where the user goes to connect with us. And the first thing we have to show is two options. One is Drop your email, we'll contact you. Or the second one is schedule a meeting with us. If it's a drop email, it's an easy uh just they enter their own email with a uh With an optional message, and then they click send. The second option would be more like the form that they see here um that exists already but I want a lot more roles optional a lot more fields optional and Let's see if we can uh in simplify the um the process. Maybe something like You ask for some information, and the continue to scheduling becomes visible immediately after name and email. But you can still add the other fields like company role title, what would you like to understand, and all the other fields.",
  modelOutput:
    "I want to change how the contact form works. Right now it's a large form, and to the right there is a link to the scheduling page. I want to simplify this and transform the whole flow in a multiple step process. Um, first step would be we ask the user to kind of like this is where the user goes to connect with us. And the first thing we have to show is two options. One is Drop your email, we'll contact you. Or the second one is schedule a meeting with us. If it's a drop email, it's an easy uh, just they enter their own email with a uh with an optional message, and then they click send. The second option would be more like the form that they see here um that exists already but I want a lot more roles optional a lot more fields optional and let's see if we can uh simplify the um the process. Maybe something like you ask for some information, and the continue to scheduling becomes visible immediately after name and email. But you can still add the other fields like company role title, what would you like to understand, and all the other fields.",
};

// Technical dictation: commands, paths, flags, servers, bugs — most of what
// Earheart is dictated. Each item plants fillers and stutters (what the
// stumble backstop rescues), and most carry spoken symbols said twice ("dot
// dot slash", "dash dash watch", "equals equals"): a model that leaves them
// as words hands the backstop a doubling that is code, not a stutter.
//
// `keep` lists what must survive in SOME form — the spoken words or the code
// the prompt asks for; one regex of `any` has to match. Scored by
// scripts/eval-technical.mjs; numbers in docs/cleanup-models.md.
const TECHNICAL = [
  {
    text: "um can you cd into dot dot slash config and uh open the the settings dot json file",
    keep: [{ name: "../", any: [/dot dot/i, /\.\.\//] }],
  },
  {
    text: "run the tests with dash dash watch and uh dash dash coverage, and um make sure the the snapshots folder is ignored",
    keep: [
      { name: "--watch", any: [/dash dash watch/i, /--watch/] },
      { name: "--coverage", any: [/dash dash coverage/i, /--coverage/] },
    ],
  },
  {
    text: "the bug is in the validate function, it does if user equals equals null instead of um triple equals so undefined slips through",
    keep: [{ name: "==", any: [/equals equals/i, /(?<!=)==(?!=)/] }],
  },
  {
    text: "so the uh the problem is the the underscore underscore init underscore underscore method in the base class calls super twice",
    keep: [{ name: "__init__", any: [/underscore underscore init/i, /__init__/] }],
  },
  {
    text: "add star star slash star dot test dot js to the the jest config um test match pattern",
    keep: [{ name: "**/", any: [/star star/i, /\*\*/] }],
  },
  {
    text: "the condition should be is admin ampersand ampersand has access, uh, not pipe pipe, otherwise um every logged in user gets the the admin menu",
    keep: [
      { name: "&&", any: [/ampersand ampersand/i, /&&/] },
      { name: "||", any: [/pipe pipe/i, /\|\|/] },
    ],
  },
  {
    text: "ssh into the staging box, uh, it's at ten dot zero dot zero dot five, then run sudo systemctl restart nginx and um check journalctl dash u nginx for the the five oh two errors",
    keep: [],
  },
  {
    text: "the the build fails with uh error colon cannot find module dot dot slash utils slash logger, um, it only happens on windows",
    keep: [{ name: "../utils", any: [/dot dot/i, /\.\.\//] }],
  },
  {
    // Long and mostly fluent: the copy-mode shape, technical edition.
    text: "Okay so I want to add a health check endpoint to the API server. Right now the load balancer just pings the root route, which renders the whole dashboard and takes about two seconds. Um, the new endpoint should be slash health and it should only check that the database connection is alive and that the redis client can ping. It shouldn't touch the the session middleware at all. Put the handler in src slash routes slash health dot ts and register it before the auth middleware in app dot ts. For the response, return a two hundred with a small JSON body that has status and uptime, and a five oh three if either check fails. Uh, also add a test in the routes test file that mocks the database and checks both cases. And update the docker compose file so the health check uses curl dash dash fail against port three thousand slash health instead of the root route.",
    keep: [{ name: "--fail", any: [/dash dash fail/i, /--fail/] }],
  },
  {
    // Long, fluent, no symbol doublings: filler residue in technical prose.
    text: "So here's how the deployment works today. We have nginx in front that terminates TLS and forwards to the node server on port eight zero eight zero. The node server talks to postgres through PG bouncer, and uh, background jobs go through a separate worker process that reads from a redis queue. The problem is that when we deploy, we restart the worker and the server at the same time, so any job that was in flight gets dropped. Um, I think the fix is to make the worker handle sigterm, finish the current job, and then exit, and we should give it a thirty second grace period in the the systemd unit. Don't change the server's shutdown logic, that part already drains connections correctly. Can you also check whether the retry count on the queue is still set to zero, because I think someone changed it during the incident last week.",
    keep: [],
  },
];

// Held out: symbols and phrasings no prompt example names, so a prompt can't
// pass by echoing its own examples. Judge prompt changes here.
const TECHNICAL_HELDOUT = [
  {
    text: "um in the loop it should be i plus plus not i uh plus equals two, the the off by one is there",
    keep: [{ name: "++", any: [/plus plus/i, /\+\+/] }],
  },
  {
    text: "comment it out with slash slash todo uh and then um move the the import to the top of the file",
    keep: [{ name: "//", any: [/slash slash/i, /\/\//] }],
  },
  {
    text: "the rust code calls string colon colon from and uh vec colon colon new, um, both inside the the parse function",
    keep: [{ name: "::", any: [/colon colon/i, /::/] }],
  },
  {
    text: "check if status bang equals two hundred and uh log the the body, um, otherwise it just returns",
    keep: [{ name: "!=", any: [/bang equals/i, /!=/] }],
  },
  {
    text: "the import is from dot dot slash dot dot slash shared slash types, uh, and it breaks when the the folder moves",
    keep: [{ name: "../../", any: [/dot dot slash dot dot/i, /\.\.\/\.\.\//] }],
  },
  {
    text: "uh the README heading should be hash hash installation not a single hash, and um the the code block needs a language",
    keep: [{ name: "##", any: [/hash hash/i, /##/] }],
  },
  {
    text: "set the env var NODE underscore ENV to production and um run npm run build dash dash dash dash prod, the the extra dashes pass it through",
    keep: [{ name: "-- --prod", any: [/dash dash dash dash/i, /-- --prod/, /----prod/] }],
  },
  {
    // Fluent, long, technical, sparse fillers: copy-mode shape again.
    text: "I looked at the flaky test in the payments service. It fails maybe one run in twenty, always on the step that waits for the webhook. The test starts a fake Stripe server on a random port, but the webhook URL in the config is read once at import time, so when the port changes the handler is still pointing at the old one. Um, the fix I'd like is to read the URL lazily inside the handler, not at import. Also the retry helper uses a fixed five hundred millisecond sleep, which is the real reason it's flaky under load. Replace it with the wait for helper we already have in test slash utils slash wait dot ts, with a timeout of ten seconds. Uh, please don't touch the production webhook code, only the test and the config loader.",
    keep: [],
  },
];
module.exports = { SHORT, REPORTED, FLUENT, TECHNICAL, TECHNICAL_HELDOUT };
