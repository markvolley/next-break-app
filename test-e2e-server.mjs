// ---------------------------------------------------------------------
// SCRATCH TEST HARNESS — NOT PART OF THE APP.
//
// This file was used during development to test server.js against a fake
// local Travelpayouts server (since this dev sandbox has no real network
// access to api.travelpayouts.com). It monkey-patches global.fetch to
// redirect Travelpayouts calls to localhost, then boots the real server.
//
// It has no purpose once you're running on a machine with normal internet
// access — `npm start` / `node server.js` is all you need. Safe to delete.
// ---------------------------------------------------------------------
const realFetch = fetch;
global.fetch = (url, opts) => {
  const u = new URL(url);
  if (u.hostname === 'api.travelpayouts.com') {
    const redirected = 'http://localhost:4321' + u.pathname + u.search;
    return realFetch(redirected);
  }
  return realFetch(url, opts);
};
const { server } = await import('./server.js');
server.listen(process.env.PORT || 3061, () => console.log('test server up'));
