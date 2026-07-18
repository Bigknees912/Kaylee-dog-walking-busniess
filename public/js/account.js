/* Client account page: login / signup (email+password or Google), then a
   dashboard with account settings, dog profiles, and booking history. */

(function () {
  var authView = document.getElementById('auth-view');
  var accountView = document.getElementById('account-view');
  var authMsg = document.getElementById('auth-msg');
  var dogSizes = [];
  var account = null;

  function j(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    });
  }

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function setMsg(el, text, ok) {
    el.textContent = text;
    el.className = 'form-msg ' + (ok ? 'ok' : 'err');
    el.hidden = false;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ----- initial state -----

  function init() {
    // Surface an error passed back from the Google OAuth redirect.
    var params = new URLSearchParams(window.location.search);
    var errKey = params.get('error');
    if (errKey) {
      var messages = {
        google_unavailable: "Google sign-in isn't set up yet — please use email and password.",
        google_state: 'Google sign-in could not be verified — please try again.',
        google_failed: 'Google sign-in failed — please try again or use email and password.',
      };
      // Message shown once the auth view is visible.
      window.__googleError = messages[errKey] || 'Sign-in failed — please try again.';
      history.replaceState(null, '', '/account.html');
    }

    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) { dogSizes = cfg.dogSizes || []; })
      .catch(function () {});

    // A reset link (?reset=TOKEN) takes priority: show the new-password form.
    var resetToken = params.get('reset');
    if (resetToken) {
      history.replaceState(null, '', '/account.html');
      show(authView);
      hide(loginForm);
      hide(signupForm);
      show(resetForm);
      document.querySelectorAll('[data-authtab]').forEach(function (t) { t.hidden = true; });
      resetForm.dataset.token = resetToken;
      return;
    }

    // Deep link from the profile menu (?tab=signup) — logged-out only;
    // enterAccount() handles the logged-in equivalents (bookings/dogs/settings).
    if (params.get('tab') === 'signup') {
      var signupTab = document.querySelector('[data-authtab="signup"]');
      if (signupTab) signupTab.click();
    }

    j('/api/auth/me').then(function (r) {
      if (r.body && r.body.googleAuthEnabled) show(document.getElementById('google-block'));
      if (r.body && r.body.account) {
        account = r.body.account;
        enterAccount();
      } else {
        show(authView);
        if (window.__googleError) setMsg(authMsg, window.__googleError, false);
      }
    }).catch(function () {
      show(authView);
    });
  }

  // ----- auth (logged-out) tabs + forms -----

  var authTabs = document.querySelectorAll('[data-authtab]');
  var loginForm = document.getElementById('login-form');
  var signupForm = document.getElementById('signup-form');
  var forgotForm = document.getElementById('forgot-form');
  var resetForm = document.getElementById('reset-form');
  authTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      authTabs.forEach(function (t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      authMsg.hidden = true;
      hide(forgotForm);
      hide(resetForm);
      if (tab.dataset.authtab === 'login') { show(loginForm); hide(signupForm); }
      else { hide(loginForm); show(signupForm); }
    });
  });

  // ----- forgot / reset password -----

  document.getElementById('forgot-link').addEventListener('click', function (e) {
    e.preventDefault();
    authMsg.hidden = true;
    hide(loginForm);
    show(forgotForm);
  });
  document.getElementById('forgot-back-link').addEventListener('click', function (e) {
    e.preventDefault();
    authMsg.hidden = true;
    hide(forgotForm);
    show(loginForm);
  });

  forgotForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = forgotForm.querySelector('button[type=submit]');
    btn.disabled = true;
    j('/api/auth/forgot', {
      method: 'POST',
      body: JSON.stringify({ email: document.getElementById('forgot-email').value.trim() }),
    }).then(function (r) {
      if (r.ok) {
        // The account may or may not exist — the server's wording stays
        // generic on purpose so this can't be used to discover emails.
        // Add the practical next step separately, since there's no email
        // provider connected yet: Kaylee sees the link in her dashboard.
        forgotForm.reset();
        setMsg(
          authMsg,
          (r.body.message || 'If that email has an account, a reset link is on its way.') +
            ' Text or call Kaylee at 587-433-2199 and ask her to send you the link from her dashboard — ' +
            "she'll see it under Messages the moment you submit this.",
          true
        );
      } else {
        setMsg(authMsg, r.body.error || 'Could not send a reset link — please try again.', false);
      }
    }).catch(function () {
      setMsg(authMsg, 'Could not reach the server — please try again.', false);
    }).finally(function () { btn.disabled = false; });
  });

  resetForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = resetForm.querySelector('button[type=submit]');
    btn.disabled = true;
    j('/api/auth/reset', {
      method: 'POST',
      body: JSON.stringify({
        token: resetForm.dataset.token || '',
        newPassword: document.getElementById('reset-password').value,
      }),
    }).then(function (r) {
      if (r.ok) {
        account = r.body.account;
        hide(resetForm);
        enterAccount();
      } else {
        setMsg(authMsg, r.body.error || 'Could not reset your password.', false);
      }
    }).catch(function () {
      setMsg(authMsg, 'Could not reach the server — please try again.', false);
    }).finally(function () { btn.disabled = false; });
  });

  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = loginForm.querySelector('button[type=submit]');
    btn.disabled = true;
    j('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value,
      }),
    }).then(function (r) {
      if (r.ok) { account = r.body.account; enterAccount(); }
      else setMsg(authMsg, r.body.error || 'Could not log in.', false);
    }).catch(function () {
      setMsg(authMsg, 'Could not reach the server — please try again.', false);
    }).finally(function () { btn.disabled = false; });
  });

  signupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = signupForm.querySelector('button[type=submit]');
    btn.disabled = true;
    j('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('signup-name').value.trim(),
        email: document.getElementById('signup-email').value.trim(),
        phone: document.getElementById('signup-phone').value.trim(),
        password: document.getElementById('signup-password').value,
      }),
    }).then(function (r) {
      if (r.ok) { account = r.body.account; enterAccount(); }
      else setMsg(authMsg, r.body.error || 'Could not create your account.', false);
    }).catch(function () {
      setMsg(authMsg, 'Could not reach the server — please try again.', false);
    }).finally(function () { btn.disabled = false; });
  });

  // ----- logged-in dashboard -----

  function enterAccount() {
    hide(authView);
    show(accountView);
    document.getElementById('greet-name').textContent = (account.name || 'there').split(' ')[0];
    fillDetails();
    renderLoginMethods();
    renderPauseState();
    loadDogs();
    loadBookings();

    // Deep link from the profile menu, e.g. "My bookings" -> ?tab=bookings.
    var requestedTab = new URLSearchParams(window.location.search).get('tab');
    if (requestedTab === 'bookings' || requestedTab === 'dogs' || requestedTab === 'settings') {
      history.replaceState(null, '', '/account.html');
      var target = document.querySelector('#account-view .dash-tab[data-tab="' + requestedTab + '"]');
      if (target) target.click();
    }
  }

  document.getElementById('logout-btn').addEventListener('click', function () {
    var btn = document.getElementById('logout-btn');
    btn.disabled = true;
    j('/api/auth/logout', { method: 'POST' }).finally(function () {
      account = null;
      hide(accountView);
      show(authView);
      authMsg.hidden = true;
      loginForm.reset();
      signupForm.reset();
      btn.disabled = false;
      window.scrollTo(0, 0);
    });
  });

  // dashboard tabs
  var dashTabs = document.querySelectorAll('#account-view .dash-tab');
  var panels = {
    settings: document.getElementById('panel-settings'),
    dogs: document.getElementById('panel-dogs'),
    bookings: document.getElementById('panel-bookings'),
  };
  dashTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      dashTabs.forEach(function (t) { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      Object.keys(panels).forEach(function (k) { panels[k].hidden = k !== tab.dataset.tab; });
    });
  });

  // ----- account settings -----

  function fillDetails() {
    document.getElementById('acct-name').value = account.name || '';
    document.getElementById('acct-phone').value = account.phone || '';
    document.getElementById('acct-address').value = account.address || '';
    // Google-only accounts have no password yet: relabel + drop the "current" field.
    var heading = document.getElementById('password-heading');
    var currentRow = document.getElementById('current-password-row');
    if (!account.hasPassword) {
      heading.textContent = 'Set a password';
      currentRow.hidden = true;
    } else {
      heading.textContent = 'Change password';
      currentRow.hidden = false;
    }
  }

  function renderLoginMethods() {
    var holder = document.getElementById('login-methods');
    holder.innerHTML = '';
    holder.appendChild(el('li', null, 'Email: ' + account.email));
    holder.appendChild(el('li', null, account.hasPassword ? 'Password: set' : 'Password: not set yet'));
    holder.appendChild(el('li', null, 'Google: ' + (account.hasGoogle ? 'linked' : 'not linked')));
  }

  document.getElementById('details-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = document.getElementById('details-msg');
    j('/api/account', {
      method: 'PATCH',
      body: JSON.stringify({
        name: document.getElementById('acct-name').value.trim(),
        phone: document.getElementById('acct-phone').value.trim(),
        address: document.getElementById('acct-address').value.trim(),
      }),
    }).then(function (r) {
      if (r.ok) {
        account = r.body.account;
        document.getElementById('greet-name').textContent = (account.name || 'there').split(' ')[0];
        setMsg(msg, 'Saved!', true);
      } else setMsg(msg, r.body.error || 'Could not save.', false);
    }).catch(function () { setMsg(msg, 'Could not reach the server.', false); });
  });

  document.getElementById('password-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = document.getElementById('password-msg');
    j('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: document.getElementById('acct-current-password').value,
        newPassword: document.getElementById('acct-new-password').value,
      }),
    }).then(function (r) {
      if (r.ok) {
        account = r.body.account;
        document.getElementById('acct-current-password').value = '';
        document.getElementById('acct-new-password').value = '';
        fillDetails();
        renderLoginMethods();
        setMsg(msg, 'Password saved!', true);
      } else setMsg(msg, r.body.error || 'Could not save password.', false);
    }).catch(function () { setMsg(msg, 'Could not reach the server.', false); });
  });

  // ----- pause / resume -----

  var pauseBtn = document.getElementById('pause-btn');

  function renderPauseState() {
    pauseBtn.textContent = account.paused ? 'Resume my account' : 'Pause my account';
    document.getElementById('pause-note').textContent = account.paused
      ? "Your account is paused — Kaylee knows you're away. All your dogs and history are safe. Resume any time, or just book a walk."
      : "Pausing keeps all your dogs and walk history — you just won't show as an active client until you're back. Booking a walk automatically un-pauses you.";
  }

  pauseBtn.addEventListener('click', function () {
    var msg = document.getElementById('pause-msg');
    pauseBtn.disabled = true;
    j('/api/account/pause', {
      method: 'POST',
      body: JSON.stringify({ paused: !account.paused }),
    }).then(function (r) {
      if (r.ok) {
        account = r.body.account;
        renderPauseState();
        setMsg(msg, account.paused ? 'Account paused — enjoy the trip!' : 'Welcome back! Your account is active again.', true);
      } else {
        setMsg(msg, r.body.error || 'Could not update your account.', false);
      }
    }).catch(function () {
      setMsg(msg, 'Could not reach the server.', false);
    }).finally(function () { pauseBtn.disabled = false; });
  });

  // ----- dog profiles -----

  function fillSizeSelect(select, current) {
    select.innerHTML = '';
    var blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Choose…';
    select.appendChild(blank);
    dogSizes.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      if (s === current) o.selected = true;
      select.appendChild(o);
    });
  }

  // Downscale an uploaded image to a small JPEG data URL so photos stay well
  // under the server's per-photo size cap.
  function fileToDataUrl(file, cb) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 600;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        cb(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = function () { cb(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { cb(null); };
    reader.readAsDataURL(file);
  }

  function buildDogCard(dog) {
    var tpl = document.getElementById('dog-card-tpl');
    var node = tpl.content.cloneNode(true);
    var card = node.querySelector('.dog-card');
    var photo = card.querySelector('.dog-photo');
    var photoEmpty = card.querySelector('.dog-photo-empty');
    var removePhotoBtn = card.querySelector('.remove-photo-btn');
    var pendingPhoto = { value: undefined }; // undefined = unchanged, '' = cleared, string = new

    function applyPhoto(url) {
      if (url) {
        photo.src = url;
        photo.hidden = false;
        photoEmpty.hidden = true;
        removePhotoBtn.hidden = false;
      } else {
        photo.hidden = true;
        photoEmpty.hidden = false;
        removePhotoBtn.hidden = true;
      }
    }

    card.querySelector('.dog-name').value = dog.name || '';
    card.querySelector('.dog-breed').value = dog.breed || '';
    card.querySelector('.dog-age').value = dog.age || '';
    fillSizeSelect(card.querySelector('.dog-size'), dog.size || '');
    card.querySelector('.dog-behavior').value = dog.behaviorNotes || '';
    card.querySelector('.dog-vet').value = dog.vetContact || '';
    card.querySelector('.dog-allergies').value = dog.allergies || '';
    applyPhoto(dog.photo || '');

    card.querySelector('.dog-photo-input').addEventListener('change', function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      fileToDataUrl(file, function (url) {
        if (!url) return;
        pendingPhoto.value = url;
        applyPhoto(url);
      });
    });
    removePhotoBtn.addEventListener('click', function () {
      pendingPhoto.value = '';
      applyPhoto('');
    });

    var msgEl = card.querySelector('.dog-card-msg');

    function collect() {
      var payload = {
        name: card.querySelector('.dog-name').value.trim(),
        breed: card.querySelector('.dog-breed').value.trim(),
        age: card.querySelector('.dog-age').value.trim(),
        size: card.querySelector('.dog-size').value,
        behaviorNotes: card.querySelector('.dog-behavior').value.trim(),
        vetContact: card.querySelector('.dog-vet').value.trim(),
        allergies: card.querySelector('.dog-allergies').value.trim(),
      };
      if (pendingPhoto.value !== undefined) payload.photo = pendingPhoto.value;
      return payload;
    }

    card.querySelector('.save-dog-btn').addEventListener('click', function () {
      var payload = collect();
      if (!payload.name) { msgEl.textContent = 'Name required'; return; }
      var isNew = !dog.id;
      var url = isNew ? '/api/account/dogs' : '/api/account/dogs/' + dog.id;
      j(url, { method: isNew ? 'POST' : 'PATCH', body: JSON.stringify(payload) }).then(function (r) {
        if (r.ok) {
          msgEl.textContent = 'Saved ✓';
          setTimeout(function () { msgEl.textContent = ''; }, 1500);
          loadDogs();
        } else {
          msgEl.textContent = (r.body && r.body.error) || 'Could not save';
        }
      }).catch(function () { msgEl.textContent = 'Server error'; });
    });

    card.querySelector('.delete-dog-btn').addEventListener('click', function () {
      if (!dog.id) { card.remove(); return; }
      if (!window.confirm('Remove ' + (dog.name || 'this dog') + '?')) return;
      j('/api/account/dogs/' + dog.id, { method: 'DELETE' }).then(function (r) {
        if (r.ok) loadDogs();
        else msgEl.textContent = (r.body && r.body.error) || 'Could not delete';
      }).catch(function () { msgEl.textContent = 'Server error'; });
    });

    return card;
  }

  function loadDogs() {
    var holder = document.getElementById('dogs-list');
    j('/api/account/dogs').then(function (r) {
      holder.innerHTML = '';
      if (!r.ok) { holder.appendChild(el('p', 'hint', 'Could not load your dogs.')); return; }
      if (r.body.dogs.length === 0) {
        holder.appendChild(el('p', 'hint', "No dogs yet — add your first one below and it'll autofill at booking."));
      }
      r.body.dogs.forEach(function (d) { holder.appendChild(buildDogCard(d)); });
    }).catch(function () {
      holder.innerHTML = '';
      holder.appendChild(el('p', 'hint', 'Could not reach the server.'));
    });
  }

  document.getElementById('add-dog-btn').addEventListener('click', function () {
    var holder = document.getElementById('dogs-list');
    // If a blank card is already open, don't stack another.
    holder.appendChild(buildDogCard({}));
    var cards = holder.querySelectorAll('.dog-card');
    cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ----- bookings -----

  function friendlyDate(iso) {
    var parts = iso.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-CA', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  function renderBookingList(holder, list, emptyText) {
    holder.innerHTML = '';
    if (list.length === 0) { holder.appendChild(el('p', 'hint', emptyText)); return; }
    list.forEach(function (b) {
      var card = el('div', 'card booking-row');
      var head = el('div', 'booking-head');
      head.appendChild(el('strong', null, friendlyDate(b.date) + ' · ' + b.slot));
      var statusClass = b.status === 'booked' ? 'booked' : b.status === 'done' ? 'done' : 'cancelled';
      head.appendChild(el('span', 'walk-status ' + statusClass,
        b.status === 'booked' ? 'Booked' : b.status === 'done' ? 'Done' : 'Cancelled'));
      card.appendChild(head);
      card.appendChild(el('div', 'dog-sub', b.dogName + ' · ' + b.duration + ' min · ' + b.address));
      if (b.notes) card.appendChild(el('div', 'dog-sub', 'Note: ' + b.notes));
      holder.appendChild(card);
    });
  }

  function loadBookings() {
    j('/api/account/bookings').then(function (r) {
      if (!r.ok) return;
      renderBookingList(document.getElementById('upcoming-bookings'), r.body.upcoming, 'No upcoming walks — book one!');
      renderBookingList(document.getElementById('past-bookings'), r.body.past, 'No past walks yet.');
    }).catch(function () {});
  }

  init();
})();
