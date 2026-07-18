// Vercel's Node runtime looks for a serverless function under /api. This
// file just hands it the Express app itself — server.js exports `app` and
// skips app.listen() whenever process.env.VERCEL is set, so this module is
// the only thing that ever calls into it here.
module.exports = require('../server.js');
