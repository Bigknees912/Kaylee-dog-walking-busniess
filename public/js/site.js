/* Shared interactions: intro reveal, scroll-triggered animations (first
   pass only), word-by-word headline reveals, hero parallax, nav bar that
   turns solid on scroll, and the pop-up gallery lightbox.
   Every entrance animation stays under 600ms and everything here backs
   off when the user prefers reduced motion. */

(function () {
  var reducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ----- header: hamburger menu + profile dropdown (every page) -----
  (function () {
    var navToggle = document.querySelector('.nav-toggle');
    var siteNav = document.getElementById('site-nav');
    var profileBtn = document.querySelector('.profile-btn');
    var profileMenu = document.getElementById('profile-menu');
    if (!profileBtn || !profileMenu) return;

    function closeMenu() {
      if (siteNav && !siteNav.hidden) {
        siteNav.hidden = true;
        navToggle.setAttribute('aria-expanded', 'false');
      }
      if (!profileMenu.hidden) {
        profileMenu.hidden = true;
        profileBtn.setAttribute('aria-expanded', 'false');
      }
    }

    if (navToggle && siteNav) {
      navToggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = siteNav.hidden;
        closeMenu();
        if (willOpen) {
          siteNav.hidden = false;
          navToggle.setAttribute('aria-expanded', 'true');
        }
      });
    }

    function makeLink(href, text) {
      var a = document.createElement('a');
      a.href = href;
      a.textContent = text;
      return a;
    }

    function renderProfileMenu(account) {
      profileMenu.innerHTML = '';
      if (account) {
        profileBtn.classList.add('has-account');
        var nameBlock = document.createElement('div');
        nameBlock.className = 'profile-name';
        nameBlock.textContent = account.name || account.email;
        var small = document.createElement('small');
        small.textContent = account.email;
        nameBlock.appendChild(small);
        profileMenu.appendChild(nameBlock);
        profileMenu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-divider' }));
        profileMenu.appendChild(makeLink('/account.html?tab=bookings', 'My bookings'));
        profileMenu.appendChild(makeLink('/account.html?tab=dogs', 'Dog profiles'));
        profileMenu.appendChild(makeLink('/account.html?tab=settings', 'Account settings'));
        profileMenu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-divider' }));
        var logoutBtn = document.createElement('button');
        logoutBtn.type = 'button';
        logoutBtn.className = 'menu-item';
        logoutBtn.textContent = 'Log out';
        logoutBtn.addEventListener('click', function () {
          logoutBtn.disabled = true;
          fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
            .catch(function () {})
            .finally(function () {
              window.location.href = '/';
            });
        });
        profileMenu.appendChild(logoutBtn);
      } else {
        profileMenu.appendChild(makeLink('/account.html', 'Log in'));
        profileMenu.appendChild(makeLink('/account.html?tab=signup', 'Sign up'));
      }
    }

    profileBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = profileMenu.hidden;
      closeMenu();
      if (willOpen) {
        profileMenu.hidden = false;
        profileBtn.setAttribute('aria-expanded', 'true');
      }
    });

    document.addEventListener('click', function (e) {
      if (siteNav && !siteNav.hidden && !siteNav.contains(e.target) && !navToggle.contains(e.target)) {
        siteNav.hidden = true;
        navToggle.setAttribute('aria-expanded', 'false');
      }
      if (!profileMenu.hidden && !profileMenu.contains(e.target) && !profileBtn.contains(e.target)) {
        profileMenu.hidden = true;
        profileBtn.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) { renderProfileMenu(data && data.account); })
      .catch(function () { renderProfileMenu(null); });
  })();

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
  note.textContent = "can't wait to meet the real crew, your pup's photo could be here!";

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
