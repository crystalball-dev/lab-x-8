/**
 * Product identity, in one place. The desktop shell reads it too.
 * `name` must match `productName` in package.json, which names the program and its folders.
 */
export const BRAND = {
  name: 'Lab X-8',
  /** The name as it appears in file names. */
  slug: 'lab-x-8',
  tagline: 'Sound-reactive visual synthesis',
  publisher: 'OPERATION FAIRWAY, LLC',
  publisherShort: 'OPERATION FAIRWAY',
  publisherNote: 'A record label registered in the State of Alaska',
  website: 'https://operationfairway.org',
  websiteLabel: 'operationfairway.org',
  copyright: '© 2026 OPERATION FAIRWAY, LLC',
} as const;
