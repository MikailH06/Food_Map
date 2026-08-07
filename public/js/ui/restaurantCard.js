/**
 * Restaurant rendering.
 *
 * Two views over the same resolved object: a compact row for lists, and the
 * detail panel. Both label where a rating came from, because a two-person
 * community average and a 2,841-review aggregate are not the same claim and
 * should not look identical.
 */

import { escapeHtml, sourceLabel } from '../map/mapProvider.js';

/**
 * Placeholder artwork for a restaurant with no photo.
 *
 * Generated from the name and cuisine rather than shipped as image files: no
 * assets to host, no broken links, and it works offline. Measured photo
 * coverage from restaurant websites is ~63%, so roughly a third of pins land
 * here.
 */
const CUISINE_HUES = {
  mexican: 12, oaxacan: 12, taco: 12,
  italian: 96, pizza: 96, pasta: 96,
  japanese: 200, sushi: 200, ramen: 200,
  chinese: 355, thai: 42, vietnamese: 160, korean: 320,
  indian: 28, american: 220, burger: 30, cafe: 25,
  'coffee shop': 25, bakery: 45, seafood: 190, vegan: 120,
};

function hueFor(restaurant) {
  for (const cuisine of restaurant.cuisines ?? []) {
    const hue = CUISINE_HUES[cuisine];
    if (hue !== undefined) return hue;
  }
  // Stable pseudo-random hue from the name, so a restaurant always looks the same.
  let hash = 0;
  for (const char of restaurant.name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function placeholderStyle(restaurant) {
  const hue = hueFor(restaurant);
  return `background: linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 55% 30%));`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

/** Thumbnail markup: a real photo when we have one, otherwise generated art. */
function thumbHtml(restaurant) {
  if (restaurant.photo?.url) {
    // A scraped image URL can rot or be hotlink-blocked; swap in the
    // placeholder rather than showing a broken image icon.
    return `
      <div class="thumb">
        <img src="${escapeHtml(restaurant.photo.url)}" alt="" loading="lazy"
             onerror="this.parentElement.innerHTML='<div class=\\'thumb-fallback\\' style=\\'${placeholderStyle(restaurant)}\\'>${escapeHtml(initials(restaurant.name))}</div>'" />
      </div>`;
  }

  return `
    <div class="thumb">
      <div class="thumb-fallback" style="${placeholderStyle(restaurant)}">
        ${escapeHtml(initials(restaurant.name))}
      </div>
    </div>`;
}

/** Star rating with its provenance, or an honest "not rated yet". */
function ratingHtml(rating) {
  if (!rating) {
    return '<span class="rating rating-none">Not rated yet</span>';
  }

  return `
    <span class="rating" title="${escapeHtml(sourceLabel(rating.source))}">
      <span class="rating-star">★</span>${rating.value.toFixed(1)}
      ${rating.count ? `<span class="rating-count">(${rating.count})</span>` : ''}
      <span class="rating-source rating-source-${escapeHtml(rating.source)}">${escapeHtml(sourceLabel(rating.source))}</span>
    </span>`;
}

/**
 * Compact list row.
 *
 * @param {object} restaurant
 * @param {object} options
 * @param {'add'|'remove'|null} options.action
 * @param {(restaurant: object) => void} options.onAction
 * @param {(restaurant: object) => void} options.onSelect
 * @returns {HTMLElement}
 */
export function resultRow(restaurant, { action = null, onAction, onSelect } = {}) {
  const element = document.createElement('article');
  element.className = 'result';
  element.dataset.restaurantId = restaurant.id;

  const distance = restaurant.meta?.distanceMeters;
  const distanceLabel =
    typeof distance === 'number'
      ? distance < 1000
        ? `${Math.round(distance)} m`
        : `${(distance / 1000).toFixed(1)} km`
      : null;

  element.innerHTML = `
    ${thumbHtml(restaurant)}
    <div class="result-body">
      <h3 class="result-name">${escapeHtml(restaurant.name)}</h3>
      <p class="result-address">${escapeHtml(restaurant.address.full ?? 'Address unknown')}</p>
      <div class="result-meta">
        ${ratingHtml(restaurant.rating)}
        ${restaurant.price ? `<span class="price">${restaurant.price.symbols}</span>` : ''}
        ${distanceLabel ? `<span class="distance">${distanceLabel}</span>` : ''}
      </div>
      ${
        restaurant.cuisines?.length
          ? `<div class="tags">${restaurant.cuisines
              .slice(0, 3)
              .map((c) => `<span class="tag">${escapeHtml(c)}</span>`)
              .join('')}</div>`
          : ''
      }
    </div>
    ${
      action
        ? `<button type="button" class="btn btn-${action === 'add' ? 'primary' : 'ghost'} result-action">
             ${action === 'add' ? 'Add' : 'Remove'}
           </button>`
        : ''
    }
  `;

  const actionButton = element.querySelector('.result-action');
  if (actionButton && onAction) {
    actionButton.addEventListener('click', (event) => {
      event.stopPropagation();
      onAction(restaurant);
    });
  }

  if (onSelect) {
    element.addEventListener('click', () => onSelect(restaurant));
  }

  return element;
}

/**
 * Detail panel markup.
 *
 * @param {object} restaurant
 * @param {boolean} canEdit  whether the viewer owns this map
 */
export function detailHtml(restaurant, { canEdit = false } = {}) {
  const your = restaurant.yourRating;

  const stars = [1, 2, 3, 4, 5]
    .map(
      (n) => `
      <button type="button" class="star-btn ${your && your.stars >= n ? 'star-on' : ''}"
              data-stars="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`
    )
    .join('');

  const prices = [1, 2, 3, 4]
    .map(
      (n) => `
      <button type="button" class="price-btn ${your && your.priceLevel === n ? 'price-on' : ''}"
              data-price="${n}">${'$'.repeat(n)}</button>`
    )
    .join('');

  return `
    <div class="detail-header">
      <h2 class="detail-name">${escapeHtml(restaurant.name)}</h2>
      <button type="button" class="btn btn-ghost detail-close" aria-label="Close">✕</button>
    </div>

    ${
      restaurant.photo
        ? `<img class="detail-photo" src="${escapeHtml(restaurant.photo.url)}" alt=""
              onerror="this.remove()" />
           <p class="detail-photo-credit">Photo ${escapeHtml(sourceLabel(restaurant.photo.source))}</p>`
        : ''
    }

    <div class="detail-meta">
      ${ratingHtml(restaurant.rating)}
      ${restaurant.price ? `<span class="price">${restaurant.price.symbols} <span class="rating-source">${escapeHtml(sourceLabel(restaurant.price.source))}</span></span>` : ''}
    </div>

    <p class="detail-address">${escapeHtml(restaurant.address.full ?? '')}</p>

    ${
      restaurant.description
        ? `<p class="detail-description">${escapeHtml(restaurant.description.text)}</p>
           <p class="detail-credit">${escapeHtml(sourceLabel(restaurant.description.source))}</p>`
        : ''
    }

    <dl class="detail-facts">
      ${restaurant.phone ? `<dt>Phone</dt><dd><a href="tel:${escapeHtml(restaurant.phone)}">${escapeHtml(restaurant.phone)}</a></dd>` : ''}
      ${restaurant.website ? `<dt>Website</dt><dd><a href="${escapeHtml(restaurant.website)}" target="_blank" rel="noopener noreferrer">Visit site</a></dd>` : ''}
      ${restaurant.openingHours ? `<dt>Hours</dt><dd>${escapeHtml(restaurant.openingHours)}</dd>` : ''}
      ${restaurant.cuisines?.length ? `<dt>Cuisine</dt><dd>${escapeHtml(restaurant.cuisines.join(', '))}</dd>` : ''}
    </dl>

    <section class="detail-rate">
      <h3>Your rating</h3>
      <div class="star-row" id="star-row">${stars}</div>
      <div class="price-row" id="price-row">
        <span class="price-label">Price</span>${prices}
      </div>
      <textarea id="rating-comment" class="comment" rows="2" maxlength="1000"
                placeholder="A note about this place (optional)">${escapeHtml(your?.comment ?? '')}</textarea>
      <div class="detail-rate-actions">
        <button type="button" class="btn btn-primary" id="save-rating">Save rating</button>
        ${your ? '<button type="button" class="btn btn-ghost" id="clear-rating">Remove my rating</button>' : ''}
      </div>
    </section>

    ${
      canEdit
        ? `<div class="detail-actions">
             <button type="button" class="btn btn-ghost detail-remove">Remove from this map</button>
           </div>`
        : ''
    }
  `;
}
