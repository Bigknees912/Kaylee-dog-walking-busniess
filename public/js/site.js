/* Shared interactions: scroll-reveal animations and the pop-up gallery
   lightbox. Loaded on every page. */

(function () {
  // ----- scroll reveal -----
  var revealed = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && revealed.length > 0) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    revealed.forEach(function (node) {
      observer.observe(node);
    });
  } else {
    // No observer support: just show everything.
    revealed.forEach(function (node) {
      node.classList.add('in');
    });
  }

  // ----- lightbox for pop-up pictures -----
  var cards = document.querySelectorAll('.pop-card');
  if (cards.length === 0) return;

  var lightbox = document.createElement('div');
  lightbox.className = 'lightbox';
  lightbox.setAttribute('role', 'dialog');
  lightbox.setAttribute('aria-modal', 'true');
  lightbox.setAttribute('aria-label', 'Picture preview');

  var inner = document.createElement('div');
  inner.className = 'lightbox-inner';

  var closeBtn = document.createElement('button');
  closeBtn.className = 'lightbox-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close preview');
  closeBtn.textContent = '✕';

  var artHolder = document.createElement('div');
  artHolder.className = 'art';

  var caption = document.createElement('div');
  caption.className = 'lb-caption';

  var note = document.createElement('p');
  note.className = 'lb-note';
  note.textContent = "can't wait to meet the real crew — your pup's photo could be here!";

  inner.appendChild(closeBtn);
  inner.appendChild(artHolder);
  inner.appendChild(caption);
  inner.appendChild(note);
  lightbox.appendChild(inner);
  document.body.appendChild(lightbox);

  var lastFocused = null;

  function openLightbox(card) {
    var art = card.querySelector('.art');
    var cap = card.querySelector('figcaption');
    artHolder.innerHTML = '';
    caption.innerHTML = '';
    if (art) artHolder.appendChild(art.cloneNode(true));
    if (cap) {
      var capClone = cap.cloneNode(true);
      while (capClone.firstChild) caption.appendChild(capClone.firstChild);
    }
    lastFocused = card;
    lightbox.classList.add('open');
    closeBtn.focus();
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    if (lastFocused) lastFocused.focus();
  }

  cards.forEach(function (card) {
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', 'Open bigger picture');
    card.addEventListener('click', function () {
      openLightbox(card);
    });
    card.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLightbox(card);
      }
    });
  });

  closeBtn.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function (event) {
    if (event.target === lightbox) closeLightbox();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && lightbox.classList.contains('open')) {
      closeLightbox();
    }
  });
})();
