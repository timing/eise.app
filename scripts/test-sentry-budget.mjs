#!/usr/bin/env node
// Verifies the Sentry error budget that bounds how many events one visitor can
// send. The numbers here are the quota's last line of defence, so a change that
// lets a single session emit hundreds of events again fails this.
//
//   node scripts/test-sentry-budget.mjs

import {
    claimErrorBudget,
    resetErrorBudget,
    _resetErrorBudgetForTests,
    MAX_ERRORS_PER_ATTEMPT,
    MAX_ERRORS_PER_PAGELOAD,
} from '../composables/sentryErrorBudget.js';

let failures = 0;
function check(label, actual, expected) {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${label}: got ${actual}, want ${expected}`);
}

// Sends n events, returns how many the budget allowed.
function burst(n) {
    let sent = 0;
    for (let i = 0; i < n; i++) if (claimErrorBudget().send) sent++;
    return sent;
}

// --- one attempt is capped ---
_resetErrorBudgetForTests();
check('a 500-event cascade in one attempt', burst(500), MAX_ERRORS_PER_ATTEMPT);

// --- a new file refills it ---
resetErrorBudget();
check('next file gets a fresh budget', burst(500), MAX_ERRORS_PER_ATTEMPT);

// --- the pageload ceiling still bites a retry loop ---
_resetErrorBudgetForTests();
let total = 0;
for (let attempt = 0; attempt < 50; attempt++) {
    resetErrorBudget();
    total += burst(500);
}
check('50 retries of 500 events each', total, MAX_ERRORS_PER_PAGELOAD);

// --- and stays closed once exhausted ---
resetErrorBudget();
check('a fresh attempt past the ceiling', burst(500), 0);

// --- the last allowed event is marked ---
_resetErrorBudgetForTests();
const flags = [];
for (let i = 0; i < MAX_ERRORS_PER_ATTEMPT; i++) flags.push(claimErrorBudget().last);
check('only the final event is tagged', flags.filter(Boolean).length, 1);
check('and it is the last one', flags[MAX_ERRORS_PER_ATTEMPT - 1], true);

// --- the realistic case this exists for: the Sep 14 session ---
_resetErrorBudgetForTests();
check('Sep 14 (568 events, one session)', burst(568), MAX_ERRORS_PER_ATTEMPT);

console.log(failures === 0 ? '\nall pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
