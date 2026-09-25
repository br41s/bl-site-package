// /profesionales only exists while the B2B area is switched on (panel →
// Productos → Profesionales). Off, the page is not built at all: a client with
// no trade customers should not publish a login form nobody can use.
//
// A template data file rather than front matter because a Nunjucks permalink
// renders to a string, and the string "false" is a URL, not "don't write".
export default {
  eleventyComputed: {
    permalink: (data) => (data.site?.b2b_enabled === "1" ? "/profesionales/index.html" : false),
  },
};
