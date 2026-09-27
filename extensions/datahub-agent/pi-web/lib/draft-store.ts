import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";

import type { CatalogReference } from "./catalog-contract";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  catalogReferences?: CatalogReference[];
}

/** Local submission recovery only; never sent as an Agent API authority. */
export type ChatSubmissionDraft = Pick<
  ChatDraft,
  "value" | "catalogReferences"
>;

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    ...(draft.catalogReferences?.length
      ? {
          catalogReferences: draft.catalogReferences.map((reference) => ({
            ...reference,
          })),
        }
      : {}),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return (
    !draft.value &&
    draft.images.length === 0 &&
    !draft.catalogReferences?.length
  );
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

export function mergeRestoredSubmissionText(
  submitted: string,
  current: string,
): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  catalogReferences?: CatalogReference[],
  submittedReferences?: CatalogReference[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  const references = [
    ...new Map(
      [...(submittedReferences ?? []), ...(catalogReferences ?? [])].map(
        (reference) => [
          JSON.stringify([reference.urn, reference.fieldPath ?? null]),
          { ...reference },
        ],
      ),
    ).values(),
  ];
  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
    ...(references.length ? { catalogReferences: references } : {}),
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
  submittedReferences?: CatalogReference[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
    current.catalogReferences,
    submittedReferences,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey)
    return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous =
    currentDraft && !isEmptyDraft(currentDraft)
      ? cloneDraft(currentDraft)
      : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(
        next.value,
        next.images,
        previous.value,
        previous.images,
        [
          ...(next.catalogReferences ?? []),
          ...(previous.catalogReferences ?? []),
        ],
      )
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
