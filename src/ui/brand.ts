import { BRAND } from '../brand';
import { h } from '../util/dom';

/** The product name set as a logo: "LAB" and "X-8", styled by the `.wordmark` rules. */
export function wordmark(className = ''): HTMLElement {
  const [first = '', ...rest] = BRAND.name.toUpperCase().split(' ');
  return h(
    'div',
    { class: `wordmark ${className}`.trim(), attrs: { role: 'img', 'aria-label': BRAND.name } },
    [h('span', { class: 'wm-a', text: first }), h('span', { class: 'wm-b', text: rest.join(' ') })],
  );
}

/** A link to the publisher's website. The desktop app opens it in the system browser. */
export function publisherLink(text: string = BRAND.publisherShort): HTMLAnchorElement {
  const link = h('a', {
    class: 'publisher',
    text,
    title: BRAND.websiteLabel,
    attrs: { href: BRAND.website, target: '_blank', rel: 'noopener noreferrer' },
  });
  // On the start screen a click would otherwise also start the demo.
  link.addEventListener('click', (event) => event.stopPropagation());
  return link;
}
