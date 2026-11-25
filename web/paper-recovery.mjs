import { scopedKey } from './account-scope.mjs';
import { validatePaperInk } from './core.mjs';

const draftKey = scopedKey('english30-paper-tab-v1');
const exposurePrefix = scopedKey('english30-seen:');

export function readPaperDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (
      !draft ||
      !draft.session ||
      !Array.isArray(draft.session.attempts) ||
      !['first', 'retest', 'review'].includes(draft.session.phase) ||
      (draft.session.phase !== 'first' && !draft.session.attempts.length)
    )
      return null;
    validatePaperInk(draft.inkPages);
    for (const attempt of draft.session.attempts) {
      if (attempt.reviewInk !== undefined) validatePaperInk(attempt.reviewInk);
    }
    return draft;
  } catch {
    return null;
  }
}

export function checkpointPaper(value) {
  try {
    if (value) sessionStorage.setItem(draftKey, JSON.stringify(value));
    else sessionStorage.removeItem(draftKey);
    return true;
  } catch {
    return false;
  }
}

// Separate per-material keys let two tabs mark different papers concurrently.
// Only an ID is retained here; attempts and answers still require explicit saving.
export function seenMaterials() {
  try {
    return new Set(
      Object.keys(localStorage)
        .filter((k) => k.startsWith(exposurePrefix))
        .map((k) => k.slice(exposurePrefix.length)),
    );
  } catch {
    return new Set();
  }
}

export function markSeen(set, id) {
  set.add(id);
  try {
    localStorage.setItem(exposurePrefix + id, '1');
  } catch {
    /* Retain in memory. */
  }
}
