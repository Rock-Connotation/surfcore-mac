const issue = (code, error, selectionState = 'rejected') => ({ ok: false, selectionState, code, error, hint: 'Keep the original sources. Review the cited actor, dates, counter-evidence and current version before submitting a new proposal.' });
const kinds = new Set(['episode', 'fact', 'relation', 'commitment', 'open_topic', 'reflection', 'preference', 'self_view']);
const fields = new Set(['operationId', 'memoryId', 'expectedRevision', 'propositionKey', 'kind', 'subject', 'content', 'certainty', 'attribution', 'validFrom', 'validTo', 'evidenceRefs', 'links', 'jobId', 'commitment']);
const commitmentFields = new Set(['promiserAccountKey', 'beneficiaryAccountKey', 'dueAt', 'status', 'transitionEvidenceId']);
const states = new Set(['open', 'completed', 'cancelled', 'overdue', 'disputed']);
const account = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9:._@/-]*$/.test(value);
const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
const rootId = (event) => event.rootEventId || event.eventId || event.id;
function originalRoots(events, subject) {
  const roots = new Map();
  for (const event of events) {
    if (!event || event.type === 'memory' || event.memoryId || event.derived === true || event.kind === 'summary' || event.subject !== subject) continue;
    const id = rootId(event);
    if (typeof id === 'string' && id && !roots.has(id)) roots.set(id, event);
  }
  return [...roots.values()];
}
const usable = (event) => ['observed', 'reported', 'inferred'].includes(event.certainty) && ['statement', 'action', 'reflection'].includes(event.attribution);

function validateCommitment(proposal, roots, previous, asOf) {
  const value = proposal.commitment;
  if (!value) return { ok: true, selectionState: 'committed' };
  if (proposal.kind !== 'commitment' || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !commitmentFields.has(key)) || !states.has(value.status) || !account(value.promiserAccountKey) || (value.beneficiaryAccountKey !== undefined && !account(value.beneficiaryAccountKey)) || (value.dueAt !== null && !iso(value.dueAt))) return issue('MEMORY_COMMITMENT_INVALID', 'A commitment requires stable accounts, an explicit anchored dueAt or null, and a supported state.');
  const actual = roots.filter(usable), old = previous?.commitment;
  if (!actual.some((event) => event.actorAccountKey === value.promiserAccountKey)) return issue('MEMORY_COMMITMENT_ACTOR_UNPROVEN', 'The actual source does not establish the named promiser.');
  if (old && (old.promiserAccountKey !== value.promiserAccountKey || old.beneficiaryAccountKey !== value.beneficiaryAccountKey)) return issue('MEMORY_COMMITMENT_ACTOR_CHANGED', 'A commitment version cannot silently change its participants.');
  if (!old && !['open', 'disputed'].includes(value.status)) return issue('MEMORY_COMMITMENT_PREVIOUS_REQUIRED', 'Completion, cancellation and overdue claims need an actual previous commitment.', 'review');
  if (old && ['completed', 'cancelled'].includes(old.status) && value.status !== old.status && value.status !== 'disputed') return issue('MEMORY_COMMITMENT_TRANSITION_INVALID', 'A closed commitment can only retain its state or become disputed.', 'review');
  const changed = old && old.status !== value.status;
  if (changed && ['completed', 'cancelled', 'open'].includes(value.status)) {
    const proof = actual.find((event) => rootId(event) === value.transitionEvidenceId && event.actorAccountKey === value.promiserAccountKey && !(old.evidenceRootIds || []).includes(rootId(event)));
    if (!proof) return issue('MEMORY_COMMITMENT_NEW_EVIDENCE_REQUIRED', 'A state change requires new actual evidence from the same promiser.', 'review');
  }
  if (value.status === 'overdue' && (!iso(asOf) || !value.dueAt || Date.parse(asOf) <= Date.parse(value.dueAt))) return issue('MEMORY_COMMITMENT_DEADLINE_UNPROVEN', 'Overdue requires a trusted time after an anchored deadline.', 'review');
  if (old && old.dueAt !== value.dueAt && (!value.transitionEvidenceId || !actual.some((event) => rootId(event) === value.transitionEvidenceId && event.actorAccountKey === value.promiserAccountKey && !(old.evidenceRootIds || []).includes(rootId(event))))) return issue('MEMORY_COMMITMENT_NEW_EVIDENCE_REQUIRED', 'Changing the deadline requires new evidence from the promiser.', 'review');
  return { ok: true, selectionState: 'committed', commitment: { ...value, evidenceRootIds: [...new Set([...(old?.evidenceRootIds || []), ...actual.map(rootId)])], confirmation: value.status === 'overdue' ? 'unconfirmed' : 'reported' } };
}

// The kernel supplies original roots after span, subject, reality, ACL and CAS checks.
export function validateGrowthProposal({ proposal, rootEvents, previous, counterEvidence = [], asOf } = {}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal) || !kinds.has(proposal.kind) || Object.keys(proposal).some((key) => !fields.has(key)) || !Array.isArray(rootEvents) || !Array.isArray(counterEvidence)) return issue('MEMORY_GROWTH_INVALID', 'Only typed proposals and actual original root events are accepted; control and persona fields are forbidden.');
  if (!['reflection', 'preference', 'self_view', 'commitment'].includes(proposal.kind) && !proposal.commitment) return { ok: true, selectionState: 'committed' };
  if (proposal.kind === 'commitment' && !proposal.commitment) return { ok: true, selectionState: 'committed' };
  const roots = originalRoots(rootEvents, proposal.subject), actual = roots.filter(usable);
  if (!actual.length) return issue('MEMORY_GROWTH_EVIDENCE_REQUIRED', 'Quoted, joked, planned, conditional or uncertain material alone cannot establish growth.');
  if (counterEvidence.some((event) => event && event.resolved !== true && event.status !== 'resolved')) return issue('MEMORY_GROWTH_COUNTER_EVIDENCE', 'Trusted counter-evidence is unresolved; this candidate needs review.', 'review');
  const commitment = validateCommitment(proposal, roots, previous, asOf);
  if (!commitment.ok) return commitment;
  if (proposal.kind === 'commitment' || proposal.commitment) return commitment;
  const self = proposal.subject === 'self' || roots.some((event) => event.characterId && event.subject === event.characterId);
  if (proposal.kind === 'self_view' && !self) return issue('MEMORY_GROWTH_SUBJECT_INVALID', 'A self view must be about the actual character.');
  if (proposal.kind === 'reflection') return { ok: true, selectionState: 'committed', growth: { classification: 'reflection', independentRootIds: actual.map(rootId), dates: [...new Set(actual.filter((event) => iso(event.occurredAt)).map((event) => new Date(event.occurredAt).toISOString().slice(0, 10)))], certainty: proposal.certainty === 'observed' ? 'observed' : 'inferred' } };
  if (!['preference', 'self_view'].includes(proposal.kind)) return { ok: true, selectionState: 'committed' };
  if (!self) {
    if (proposal.certainty !== 'reported' || !actual.some((event) => event.attribution === 'statement' && (event.actorAccountKey === proposal.subject || event.speaker === proposal.subject))) return issue('MEMORY_GROWTH_PREFERENCE_UNPROVEN', 'A user preference must remain a reported statement by its actual subject.');
    return { ok: true, selectionState: 'committed', growth: { classification: 'reported_preference', independentRootIds: actual.map(rootId), certainty: 'reported' } };
  }
  if (!['inferred', 'reported'].includes(proposal.certainty)) return issue('MEMORY_GROWTH_REALITY_UPGRADE', 'A self preference or view is inferred or reported, never an observed external truth.');
  if (proposal.attribution === 'current_self_statement') {
    if (!actual.some((event) => ['statement', 'reflection'].includes(event.attribution) && (event.speaker === proposal.subject || event.actorAccountKey === proposal.subject))) return issue('MEMORY_GROWTH_CURRENT_STATEMENT_UNPROVEN', 'A current self statement requires an actual statement by the character.');
    return { ok: true, selectionState: 'committed', growth: { classification: 'current_statement', independentRootIds: actual.map(rootId), certainty: 'reported', stable: false } };
  }
  const independent = actual.filter((event) => ['action', 'reflection'].includes(event.attribution) && iso(event.occurredAt));
  const dates = [...new Set(independent.map((event) => new Date(event.occurredAt).toISOString().slice(0, 10)))].sort();
  if (independent.length < 3 || dates.length < 2) return issue('MEMORY_GROWTH_THRESHOLD_UNMET', 'A stable self preference or view needs three independent experience roots on at least two dates.', 'review');
  return { ok: true, selectionState: 'committed', growth: { classification: 'stable_self', independentRootIds: independent.map(rootId), dates, certainty: 'inferred', stable: true, threshold: { roots: 3, dates: 2 } } };
}
