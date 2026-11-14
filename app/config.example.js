// Template for app/config.js — that file is gitignored, because it carries this session's token.
// scripts/stamp.mjs writes the real one: from ../session.txt on your machine, or from the
// BOARD_SESSION deploy secret on a build runner. The board sends SESSION to the API as ?t=.
export const API = 'https://hq.mega.dev/challenges/show-me-when/api';
export const SESSION = '';
