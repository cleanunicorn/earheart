// The catalogs main and tests load (CommonJS). Pages load each catalog file as
// a classic script instead; test/i18n.test.js keeps both lists in step.
// Adding a language: docs/localization.md.
module.exports = {
  en: require("./en.js"),
  // ro: require("./ro.js"), // draft, enabled only after the owner reviews it
};
