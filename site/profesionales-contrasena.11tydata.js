// Built only while the B2B area is on, like /profesionales itself
// (see profesionales.11tydata.js for why this is a data file).
export default {
  eleventyComputed: {
    permalink: (data) =>
      data.site?.b2b_enabled === "1" ? "/profesionales/contrasena/index.html" : false,
  },
};
