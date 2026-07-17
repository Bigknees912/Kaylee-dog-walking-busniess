/* Shared interactions: intro reveal, scroll-triggered animations (first
   pass only), word-by-word headline reveals, hero parallax, nav bar that
   turns solid on scroll, and the pop-up gallery lightbox.
   Every entrance animation stays under 600ms and everything here backs
   off when the user prefers reduced motion. */

(function () {
  var reducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- word-by-word headline reveals -----
  // Split marked headlines into per-word spans with a small stagger. The
  // stagger is capped so the whole headline finishes within ~600ms.
  var wordBlocks = document.querySelectorAll('.reveal-words');
  if (!reducedMotion) {
    wordBlocks.forEach(function (node) {
      var words = node.textContent.split(/\s+/).filter(Boolean);
      node.textContent = '';
      words.forEach(function (word, i) {
        var span = document.createElement('span');
        span.className = 'w';
        span.textContent = word;
        span.style.setProperty('--wd', Math.min(i * 45, 300) + 'ms');
        node.appendChild(span);
        if (i < words.length - 1) node.appendChild(document.createTextNode(' '));
      });
    });
  }

  // ----- scroll reveal (runs once per element, never on re-scroll) -----
  var revealed = document.querySelectorAll('.reveal, .reveal-words');
  if (!reducedMotion && 'IntersectionObserver' in window && revealed.length > 0) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target); // first viewport entry only
          }
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
    );
    revealed.forEach(function (node) {
      observer.observe(node);
    });
  } else {
    // Reduced motion or no observer support: show everything immediately.
    revealed.forEach(function (node) {
      node.classList.add('in');
    });
  }

  // ----- hero parallax (background drifts slower than the foreground) -----
  var ripple = document.getElementById('hero-ripple');
  if (ripple && !reducedMotion) {
    var parallaxTick = false;
    var updateParallax = function () {
      var y = window.scrollY || window.pageYOffset || 0;
      var shift = Math.min(y * 0.18, 120);
      ripple.style.transform =
        'translateY(' + shift + 'px) scale(' + (1 + Math.min(y * 0.0002, 0.08)) + ')';
      parallaxTick = false;
    };
    window.addEventListener(
      'scroll',
      function () {
        if (!parallaxTick) {
          window.requestAnimationFrame(updateParallax);
          parallaxTick = true;
        }
      },
      { passive: true }
    );
    updateParallax();
  }

  // ----- nav bar: transparent over the hero, solid + shadow once scrolled -----
  var header = document.querySelector('.site-header');
  var hero = document.querySelector('.hero');
  if (header && hero) {
    var headerTick = false;
    var syncHeader = function () {
      var y = window.scrollY || window.pageYOffset || 0;
      if (y > 24) {
        header.classList.add('scrolled');
        header.classList.remove('transparent');
      } else {
        header.classList.add('transparent');
        header.classList.remove('scrolled');
      }
      headerTick = false;
    };
    window.addEventListener(
      'scroll',
      function () {
        if (!headerTick) {
          window.requestAnimationFrame(syncHeader);
          headerTick = true;
        }
      },
      { passive: true }
    );
    syncHeader();
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
    if (!lightbox.classList.contains('open')) return;
    if (event.key === 'Escape') {
      closeLightbox();
      return;
    }
    // Focus trap: closeBtn is the only focusable element inside the
    // lightbox, so keep Tab/Shift+Tab from leaking focus to the page
    // underneath while the modal is open.
    if (event.key === 'Tab') {
      event.preventDefault();
      closeBtn.focus();
    }
  });
})();
