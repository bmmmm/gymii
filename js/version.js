// The version Settings shows: the DEPLOY DATE, bumped by hand.
//
// Nothing already in the repo can stand in for it. sw.js's CACHE name is
// bumped only when the SHELL list changes, so it sits still across most
// deploys and would name the wrong build. And sw.js cannot simply import the
// constant from here: a module service worker (`register(..., { type:
// 'module' })`) fails on Safari before 16.4, which would trade the whole
// offline app for one shared string.
//
// So it lives in the app's own module graph, and CI keeps it honest — a push
// to main that changes what ships without touching this file goes red.
export const APP_VERSION = '2026-09-02';
