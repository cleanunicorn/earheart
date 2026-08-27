// Dictation corpora for the cleanup work — shared by the GPU eval harness
// (scripts/eval-cleanup.mjs) and the unit tests, so the shapes that broke in
// production and the shapes the tests pin can never drift apart.
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

module.exports = { SHORT, REPORTED, FLUENT };
